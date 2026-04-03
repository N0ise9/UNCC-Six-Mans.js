import { BallChaser, PrismaClient, createPrismaClientFromEnv } from "../../../prisma";
import * as faker from "faker";
import { LeaderboardBuilder } from "../../../../.jest/Builder";
import { waitForAllPromises } from "../../../utils";
import { LeaderboardRepository } from "../LeaderboardRepository";
import { EventRepository } from "../../EventRepository";
import { PlayerStats } from "../types";

let prisma: PrismaClient;
let eventId: number = 1;
let eventRepository: EventRepository;
let leaderboardRepository: LeaderboardRepository;

beforeEach(async () => {
  jest.clearAllMocks();
  eventRepository = new EventRepository(prisma);
  leaderboardRepository = new LeaderboardRepository(prisma, eventRepository);
});

beforeAll(async () => {
  prisma = createPrismaClientFromEnv();
  await prisma.$connect();
  await prisma.leaderboard.deleteMany();
  await prisma.event.deleteMany();

  await prisma.event.create({
    data: {
      id: eventId,
      name: "Spring 2022",
    },
  });

  await prisma.activeMatch.deleteMany();
  await prisma.queue.deleteMany();
  await prisma.ballChaser.deleteMany();
});

afterEach(async () => {
  await prisma.leaderboard.deleteMany();
  await prisma.event.deleteMany();

  await prisma.event.create({
    data: {
      id: eventId,
      name: "Spring 2022",
    },
  });

  await prisma.activeMatch.deleteMany();
  await prisma.queue.deleteMany();
  await prisma.ballChaser.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

const validatePlayerStats = (expected: PlayerStats, actual: PlayerStats | null) => {
  expect(actual).not.toBeNull();
  expect(actual!.id).toBe(expected.id);
  expect(actual!.losses).toBe(expected.losses);
  expect(actual!.matchesPlayed).toBe(expected.matchesPlayed);
  expect(actual!.mmr).toBe(expected.mmr);
  expect(actual!.name).toBe(expected.name);
  expect(actual!.winPerc).toBe(expected.winPerc);
  expect(actual!.wins).toBe(expected.wins);
};

const expectPlayersSortedByLeaderboardOrder = (players: ReadonlyArray<Readonly<PlayerStats>>) => {
  for (let i = 0; i < players.length - 1; i++) {
    const current = players[i];
    const next = players[i + 1];

    if (current.mmr === next.mmr) {
      expect(current.wins).toBeGreaterThanOrEqual(next.wins);
      continue;
    }

    expect(current.mmr).toBeGreaterThan(next.mmr);
  }
};

async function manuallyAddPlayerStatsToLeaderboard(ballChaser: PlayerStats | Array<PlayerStats>) {
  const playersToAdd = Array.isArray(ballChaser) ? ballChaser : [ballChaser];

  await waitForAllPromises(playersToAdd, async (player) => {
    await prisma.ballChaser.create({
      data: {
        id: player.id,
        name: player.name,
        rank: {
          create: {
            mmr: player.mmr,
            losses: player.losses,
            wins: player.wins,
            eventId,
          },
        },
      },
    });
  });
}

async function manuallyAddBallChaser(ballChaser: BallChaser) {
  await prisma.ballChaser.create({
    data: {
      id: ballChaser.id,
      name: ballChaser.name,
    },
  });
}

describe("LeaderboardRepository tests", () => {
  it("gets player's stats", async () => {
    const mockPlayerStats = LeaderboardBuilder.single();
    await manuallyAddPlayerStatsToLeaderboard(mockPlayerStats);

    const result = await leaderboardRepository.getPlayerStats(mockPlayerStats.id);

    validatePlayerStats(mockPlayerStats, result);
  });

  it("returns null when looking for player that does not exist", async () => {
    const result = await leaderboardRepository.getPlayerStats(faker.datatype.uuid());
    expect(result).toBeNull();
  });

  it("updates player stats when the player exists", async () => {
    const mockPlayerStats = LeaderboardBuilder.single();
    await manuallyAddPlayerStatsToLeaderboard(mockPlayerStats);

    const mockPlayerUpdates = LeaderboardBuilder.single({ id: mockPlayerStats.id, name: mockPlayerStats.name });

    await leaderboardRepository.updatePlayersStats([mockPlayerUpdates]);

    const actual = await prisma.leaderboard.findUnique({
      include: {
        player: true,
      },
      where: {
        eventId_playerId: {
          eventId,
          playerId: mockPlayerStats.id,
        },
      },
    });

    expect(actual).not.toBeNull();

    // should not change
    expect(actual?.player.id).toBe(mockPlayerStats.id);
    expect(actual?.player.name).toBe(mockPlayerStats.name);

    // should change
    expect(actual?.mmr).toBe(mockPlayerUpdates.mmr);
    expect(actual?.wins).toBe(mockPlayerUpdates.wins);
    expect(actual?.losses).toBe(mockPlayerUpdates.losses);
  });

  it("adds a player's stats when the player does not already exist", async () => {
    const mockPlayerStats = LeaderboardBuilder.single();
    await manuallyAddBallChaser(mockPlayerStats);

    await leaderboardRepository.updatePlayersStats([mockPlayerStats]);

    const actual = await prisma.leaderboard.findUnique({
      include: {
        player: true,
      },
      where: {
        eventId_playerId: {
          eventId,
          playerId: mockPlayerStats.id,
        },
      },
    });

    expect(actual).not.toBeNull();

    expect(actual?.player.id).toBe(mockPlayerStats.id);
    expect(actual?.player.name).toBe(mockPlayerStats.name);
    expect(actual?.mmr).toBe(mockPlayerStats.mmr);
    expect(actual?.wins).toBe(mockPlayerStats.wins);
    expect(actual?.losses).toBe(mockPlayerStats.losses);
  });

  it("adds player stats for the correct season", async () => {
    await prisma.event.create({
      data: {
        id: 50,
        name: "Fake season",
        endDate: faker.date.past(),
      },
    });

    const mockPlayerStats = LeaderboardBuilder.single();
    await manuallyAddBallChaser(mockPlayerStats);

    await leaderboardRepository.updatePlayersStats([mockPlayerStats]);

    const actual = await prisma.leaderboard.findUnique({
      include: {
        player: true,
      },
      where: {
        eventId_playerId: {
          eventId,
          playerId: mockPlayerStats.id,
        },
      },
    });

    expect(actual).not.toBeNull();
  });

  it("gets top n player stats", async () => {
    const playersToAdd = LeaderboardBuilder.many(10);
    await manuallyAddPlayerStatsToLeaderboard(playersToAdd);

    const allPlayers = await leaderboardRepository.getPlayersStats(5);

    expect(allPlayers).toHaveLength(5);
    expectPlayersSortedByLeaderboardOrder(allPlayers);
  });

  it("gets all player stats sorted correctly based on MMR", async () => {
    const playersToAdd = LeaderboardBuilder.many(10);
    await manuallyAddPlayerStatsToLeaderboard(playersToAdd);

    const allPlayers = await leaderboardRepository.getPlayersStats();

    expect(allPlayers).toHaveLength(playersToAdd.length);
    expectPlayersSortedByLeaderboardOrder(allPlayers);
  });

  it("gets all player stats sorted correctly by wins when MMR is equal", async () => {
    const playersToAdd = LeaderboardBuilder.many(5, { mmr: 100 });
    await manuallyAddPlayerStatsToLeaderboard(playersToAdd);

    const allPlayers = await leaderboardRepository.getPlayersStats();

    expect(allPlayers).toHaveLength(playersToAdd.length);
    // playersToAdd.length - 1 since you can't [i + 1] on the last item
    for (let i = 0; i < playersToAdd.length - 1; i++) {
      expect(allPlayers[i].wins).toBeGreaterThan(allPlayers[i + 1].wins);
    }
  });
});

describe("Leaderboard schema tests", () => {
  it("can have the same player with different seasons", async () => {
    await prisma.event.createMany({
      data: [
        {
          id: 100,
          name: "SUMMER 2021",
          endDate: faker.date.past(),
        },
        {
          id: 200,
          name: "SPRING 2021",
          endDate: faker.date.past(),
        },
      ],
    });

    await expect(
      prisma.ballChaser.create({
        data: {
          id: "fake_id",
          name: "player_name",
          rank: {
            createMany: {
              data: [
                {
                  eventId,
                  mmr: faker.datatype.number(),
                },
                {
                  eventId: 100,
                  mmr: faker.datatype.number(),
                },
                {
                  eventId: 200,
                  mmr: faker.datatype.number(),
                },
              ],
            },
          },
        },
      })
    ).resolves.not.toThrow();
  });
});
