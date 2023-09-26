import * as faker from "faker";
import { PlayerInQueue } from "../types";
import QueueRepository from "../QueueRepository";
import { BallChaserQueueBuilder } from "../../../../.jest/Builder";
import { PrismaClient } from "@prisma/client";
import { DateTime } from "luxon";
import { Team } from "../../../types/common";
import { InvalidCommand } from "../../../utils/InvalidCommand";

function verifyBallChasersAreEqual(expectedBallChaser: PlayerInQueue, actualBallChaser: PlayerInQueue): void {
  expect(actualBallChaser).not.toBeNull();
  expect(actualBallChaser?.id).toBe(expectedBallChaser.id);
  expect(actualBallChaser?.mmr).toBe(expectedBallChaser.mmr);
  expect(actualBallChaser?.name).toBe(expectedBallChaser.name);
  expect(actualBallChaser?.queueTime?.toISO()).toBe(expectedBallChaser.queueTime?.toISO());
  expect(actualBallChaser?.team).toBe(expectedBallChaser.team);
  expect(actualBallChaser?.isCap).toBe(expectedBallChaser.isCap);
}

let prisma: PrismaClient;
let eventId: number = 1;

beforeEach(async () => {
  jest.clearAllMocks();
});

beforeAll(async () => {
  prisma = new PrismaClient();
  await prisma.$connect();
  await prisma.event.deleteMany();

  await prisma.event.create({
    data: {
      id: 1,
      name: "Test Event",
    },
  });

  await prisma.leaderboard.deleteMany();
  await prisma.activeMatch.deleteMany();
  await prisma.queue.deleteMany();
  await prisma.ballChaser.deleteMany();
});

afterEach(async () => {
  await prisma.leaderboard.deleteMany();
  await prisma.activeMatch.deleteMany();
  await prisma.queue.deleteMany();
  await prisma.ballChaser.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function manuallyAddBallChaserToQueue(ballChaser: PlayerInQueue) {
  await prisma.ballChaser.create({
    data: {
      id: ballChaser.id,
      name: ballChaser.name,
      queue: {
        create: {
          isCap: ballChaser.isCap,
          queueTime: ballChaser.queueTime.toISO()!,
          team: ballChaser.team,
        },
      },
      rank: {
        create: {
          mmr: ballChaser.mmr ?? 100,
          eventId,
        },
      },
    },
  });
}

describe("Queue Repository tests", () => {
  it("gets BallChaser using ID when BallChaser exists", async () => {
    const expectedBallChaser = BallChaserQueueBuilder.single();
    await manuallyAddBallChaserToQueue(expectedBallChaser);

    const actualBallChaser = await QueueRepository.getBallChaserInQueue(expectedBallChaser.id);

    expect(actualBallChaser).not.toBeNull();
    verifyBallChasersAreEqual(expectedBallChaser, actualBallChaser!);
  });

  it("gets BallChaser from queue when they exist and is not on the Leaderboard", async () => {
    const expectedBallChaser = BallChaserQueueBuilder.single();

    await prisma.ballChaser.create({
      data: {
        id: expectedBallChaser.id,
        name: expectedBallChaser.name,
        queue: {
          create: {
            isCap: expectedBallChaser.isCap,
            queueTime: expectedBallChaser.queueTime.toISO()!,
            team: expectedBallChaser.team,
          },
        },
      },
    });

    const actualBallChaser = await QueueRepository.getBallChaserInQueue(expectedBallChaser.id);

    expect(actualBallChaser).not.toBeNull();
    expect(actualBallChaser?.id).toEqual(expectedBallChaser.id);
    expect(actualBallChaser?.mmr).toEqual(100);
  });

  it("returns null when BallChaser does not exist with ID", async () => {
    const actualBallChaser = await QueueRepository.getBallChaserInQueue(faker.datatype.uuid());
    expect(actualBallChaser).toBeNull();
  });

  it("retrieves all BallChasers in queue", async () => {
    const expectedBallChasers = BallChaserQueueBuilder.many(2).sort(
      (a, b) => a.queueTime.toMillis() - b.queueTime.toMillis()
    );

    await manuallyAddBallChaserToQueue(expectedBallChasers[0]);
    await manuallyAddBallChaserToQueue(expectedBallChasers[1]);

    const actualBallChasers = await QueueRepository.getAllBallChasersInQueue();

    expect(actualBallChasers).toHaveLength(2);
    verifyBallChasersAreEqual(expectedBallChasers[0], actualBallChasers[0]);
    verifyBallChasersAreEqual(expectedBallChasers[1], actualBallChasers[1]);
  });

  it("removes BallChaser when found in queue", async () => {
    const mockBallChaser = BallChaserQueueBuilder.single();
    await manuallyAddBallChaserToQueue(mockBallChaser);

    await expect(QueueRepository.removeBallChaserFromQueue(mockBallChaser.id)).resolves.not.toThrowError();
    const count = await prisma.queue.count();
    expect(count).toBe(0);
  });

  it("throws error when trying to remove BallChaser when not found in queue", async () => {
    await expect(QueueRepository.removeBallChaserFromQueue(faker.datatype.uuid())).rejects.toThrowError(InvalidCommand);
  });

  it("removes all BallChasers in queue", async () => {
    const expectedBallChaser1 = BallChaserQueueBuilder.single();
    await manuallyAddBallChaserToQueue(expectedBallChaser1);
    const expectedBallChaser2 = BallChaserQueueBuilder.single();
    await manuallyAddBallChaserToQueue(expectedBallChaser2);

    await expect(QueueRepository.removeAllBallChasersFromQueue()).resolves.not.toThrowError();
    const count = await prisma.queue.count();
    expect(count).toBe(0);
  });

  it("updates BallChaser when BallChaser is found", async () => {
    const mockBallChaser = BallChaserQueueBuilder.single();
    await manuallyAddBallChaserToQueue(mockBallChaser);
    const updatedBallChaser = BallChaserQueueBuilder.single({ id: mockBallChaser.id });

    await QueueRepository.updateBallChaserInQueue({
      id: mockBallChaser.id,
      isCap: updatedBallChaser.isCap,
      queueTime: updatedBallChaser.queueTime,
      team: updatedBallChaser.team ?? undefined,
    });

    const playerInDb = await prisma.queue.findUnique({
      include: {
        player: true,
      },
      where: {
        playerId: updatedBallChaser.id,
      },
    });

    // should not change
    expect(playerInDb?.player.id).toEqual(mockBallChaser.id);
    expect(playerInDb?.player.name).toEqual(mockBallChaser.name);

    // should change
    expect(playerInDb?.isCap).toEqual(updatedBallChaser.isCap);
    expect(DateTime.fromJSDate(playerInDb?.queueTime!).toISO()).toEqual(updatedBallChaser.queueTime.toISO());
    expect(playerInDb?.team).toEqual(updatedBallChaser.team);
  });

  it("throws when player to update is not found", async () => {
    await expect(QueueRepository.updateBallChaserInQueue({ id: faker.datatype.uuid() })).rejects.toThrowError();
  });

  it("adds BallChaser to queue", async () => {
    const mockBallChaser = BallChaserQueueBuilder.single();

    await QueueRepository.addBallChaserToQueue({
      id: mockBallChaser.id,
      name: mockBallChaser.name,
      queueTime: mockBallChaser.queueTime,
    });

    const playerInDb = await prisma.queue.findUnique({
      include: {
        player: true,
      },
      where: {
        playerId: mockBallChaser.id,
      },
    });

    expect(playerInDb?.player.id).toEqual(mockBallChaser.id);
    expect(playerInDb?.player.name).toEqual(mockBallChaser.name);
    expect(playerInDb?.isCap).toEqual(false);
    expect(DateTime.fromJSDate(playerInDb?.queueTime!).toISO()).toEqual(mockBallChaser.queueTime.toISO());
    expect(playerInDb?.team).toBeNull();
  });
  describe("check if player is in queue", () => {
    it("player is in queue", async () => {
      const mockBallChaser = BallChaserQueueBuilder.single();
      await manuallyAddBallChaserToQueue(mockBallChaser);

      const playerInQueue = await QueueRepository.isPlayerInQueue(mockBallChaser.id);

      expect(playerInQueue).toEqual(true);
    });
    it("player is not in queue", async () => {
      const mockBallChaser = BallChaserQueueBuilder.single();
      await manuallyAddBallChaserToQueue(mockBallChaser);

      const playerNotInQueue = await QueueRepository.isPlayerInQueue(faker.datatype.uuid());

      expect(playerNotInQueue).toEqual(false);
    });
  });
  describe("check if player is team captain", () => {
    it("player is team captain", async () => {
      const mockBallChaser = BallChaserQueueBuilder.single({ team: Team.Blue, isCap: true });
      await manuallyAddBallChaserToQueue(mockBallChaser);

      const isCaptain = await QueueRepository.isTeamCaptain(mockBallChaser.id, Team.Blue);

      expect(isCaptain).toEqual(true);
    });
    it("player is team captain but wrong team", async () => {
      const mockBlueCaptain = BallChaserQueueBuilder.single({ team: Team.Blue, isCap: true });
      await manuallyAddBallChaserToQueue(mockBlueCaptain);

      const isCaptain = await QueueRepository.isTeamCaptain(mockBlueCaptain.id, Team.Orange);

      expect(isCaptain).toEqual(false);
    });
    it("player is team member but not captain", async () => {
      const mockBlueTeamMember = BallChaserQueueBuilder.single({ team: Team.Blue, isCap: false });
      await manuallyAddBallChaserToQueue(mockBlueTeamMember);

      const isCaptain = await QueueRepository.isTeamCaptain(faker.datatype.uuid(), Team.Blue);

      expect(isCaptain).toEqual(false);
    });
  });
});
