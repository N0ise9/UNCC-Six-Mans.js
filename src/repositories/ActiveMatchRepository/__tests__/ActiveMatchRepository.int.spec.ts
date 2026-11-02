import * as faker from "faker";
import { ActiveMatchBuilder, BallChaserQueueBuilder } from "../../../../.jest/Builder";
import { ActiveMatchRepository } from "../ActiveMatchRepository";
import { PlayerInActiveMatch } from "../types";
import { Team } from "../../../types/common";
import { ActiveMatch, BallChaser, PrismaClient } from "../../../prisma";
import { waitForAllPromises } from "../../../utils";
import { LeaderboardRepository } from "../../LeaderboardRepository";
import { EventRepository } from "../../EventRepository";
import {
  createIntegrationTestPrismaClient,
  ensureDefaultIntegrationEvent,
  resetIntegrationDatabase,
} from "../../../../.jest/integrationPrisma";

let prisma: PrismaClient;
let eventRepository: EventRepository;
let leaderboardRepository: LeaderboardRepository;
let activeMatchRepository: ActiveMatchRepository;

beforeEach(async () => {
  jest.clearAllMocks();
  await resetIntegrationDatabase(prisma);
  await ensureDefaultIntegrationEvent(prisma);
  eventRepository = new EventRepository(prisma);
  leaderboardRepository = new LeaderboardRepository(prisma, eventRepository);
  activeMatchRepository = new ActiveMatchRepository(prisma, leaderboardRepository);
});

beforeAll(async () => {
  prisma = createIntegrationTestPrismaClient();
  await prisma.$connect();
});

afterAll(async () => {
  await resetIntegrationDatabase(prisma);
  await prisma?.$disconnect();
});

async function manuallyAddActiveMatch(activeMatch: PlayerInActiveMatch | Array<PlayerInActiveMatch>) {
  const playersToAdd = Array.isArray(activeMatch) ? activeMatch : [activeMatch];

  await waitForAllPromises(playersToAdd, async (activeMatch) => {
    await prisma.ballChaser.create({
      data: {
        id: activeMatch.id,
        name: faker.name.firstName(),
        activeMatch: {
          create: {
            brokenQueue: activeMatch.brokenQueue,
            id: activeMatch.matchId,
            team: activeMatch.team,
            reportedTeam: activeMatch.reportedTeam,
          },
        },
      },
    });
  });
}

async function manuallyAddBallChaser(ballChaser: BallChaser | Array<BallChaser>) {
  if (Array.isArray(ballChaser)) {
    await prisma.ballChaser.createMany({
      data: ballChaser.map((p) => ({
        id: p.id,
        name: p.name,
      })),
    });
  } else {
    await prisma.ballChaser.create({
      data: {
        id: ballChaser.id,
        name: ballChaser.name,
      },
    });
  }
}

describe("ActiveMatchRepository Tests", () => {
  describe("Happy path tests", () => {
    it("can add an active match", async () => {
      const mockBallChasers = BallChaserQueueBuilder.many(6);
      await manuallyAddBallChaser(mockBallChasers);

      await activeMatchRepository.addActiveMatch(mockBallChasers.map((p) => ({ id: p.id, team: p.team! })));

      const actual = await prisma.activeMatch.findMany();
      expect(actual).toHaveLength(6);

      const matchId = actual[0].id;

      expect(actual).toEqual(
        expect.arrayContaining(
          mockBallChasers.map(
            (p): ActiveMatch => ({
              id: matchId,
              playerId: p.id,
              team: p.team!,
              reportedTeam: null,
              brokenQueue: false,
            })
          )
        )
      );
    });

    it("can remove all players in a match", async () => {
      const mockMatchId = faker.datatype.uuid();
      const mockPlayers = ActiveMatchBuilder.many(6, { matchId: mockMatchId });
      await manuallyAddActiveMatch(mockPlayers);

      await activeMatchRepository.removeAllPlayersInActiveMatch(mockPlayers[0].id);

      const count = await prisma.activeMatch.count();
      expect(count).toBe(0);
    });

    it("throws when trying to remove a player not in an active match", async () => {
      await expect(
        activeMatchRepository.removeAllPlayersInActiveMatch(BallChaserQueueBuilder.single().id)
      ).rejects.toThrow();
    });

    it("retreives all players part of an active match", async () => {
      const mockMatchId = faker.datatype.uuid();
      const mockPlayers = ActiveMatchBuilder.many(6, { matchId: mockMatchId });
      await manuallyAddActiveMatch(mockPlayers);

      const oneOfThePlayers = faker.random.arrayElement(mockPlayers);
      const allPlayersInActiveMatch = await activeMatchRepository.getAllPlayersInActiveMatch(oneOfThePlayers.id);

      allPlayersInActiveMatch.blueTeam.forEach((player) => {
        const expectedPlayer = mockPlayers.find((p) => p.id === player.id);
        expect(expectedPlayer).not.toBeNull();
        expect(player.matchId).toBe(mockMatchId);
        expect(player.reportedTeam).toBe(expectedPlayer?.reportedTeam);
        expect(player.team).toBe(expectedPlayer?.team);
      });
      allPlayersInActiveMatch.orangeTeam.forEach((player) => {
        const expectedPlayer = mockPlayers.find((p) => p.id === player.id);
        expect(expectedPlayer).not.toBeNull();
        expect(player.matchId).toBe(mockMatchId);
        expect(player.reportedTeam).toBe(expectedPlayer?.reportedTeam);
        expect(player.team).toBe(expectedPlayer?.team);
      });
    });

    it("returns an empty array when trying to retreive a player not in an active match", async () => {
      const allPlayers = await activeMatchRepository.getAllPlayersInActiveMatch(BallChaserQueueBuilder.single().id);
      expect(allPlayers).toEqual({ blueTeam: [], orangeTeam: [] });
    });

    it("updates player in active match correctly", async () => {
      const mockMatchId = faker.datatype.uuid();
      const mockPlayers = ActiveMatchBuilder.many(6, { matchId: mockMatchId });

      await manuallyAddActiveMatch(mockPlayers);
      const oneOfThePlayers = faker.random.arrayElement(mockPlayers);

      const reportedTeam = faker.random.arrayElement([Team.Orange, Team.Blue]);
      const oneOfThePlayersIndex = mockPlayers.findIndex((mockPlayer) => mockPlayer.id === oneOfThePlayers.id);

      await activeMatchRepository.updatePlayerInActiveMatch(mockPlayers[oneOfThePlayersIndex].id, {
        reportedTeam: reportedTeam,
      });

      const actual = await prisma.activeMatch.findMany({
        where: {
          id: mockMatchId,
        },
      });

      expect(actual).toHaveLength(6);
      actual.forEach((match) => {
        const mockPlayerForEntry = mockPlayers.find((p) => p.id === match.playerId);

        expect(mockPlayerForEntry).not.toBeNull();
        expect(match.id).toBe(mockMatchId);
        expect(match.team).toBe(mockPlayerForEntry?.team);

        if (match.playerId === oneOfThePlayers.id) {
          expect(match.reportedTeam).toBe(reportedTeam);
        } else {
          expect(match.reportedTeam).toBe(mockPlayerForEntry?.reportedTeam);
        }
      });
    });

    it("returns whether a player is currently in an active match", async () => {
      const mockMatchId = faker.datatype.uuid();
      const mockPlayers = ActiveMatchBuilder.many(6, { matchId: mockMatchId });
      await manuallyAddActiveMatch(mockPlayers);

      await expect(activeMatchRepository.isPlayerInActiveMatch(mockPlayers[0].id)).resolves.toBe(true);
      await expect(activeMatchRepository.isPlayerInActiveMatch("not-in-match")).resolves.toBe(false);
    });

    it("retrieves a single player in an active match with their mmr", async () => {
      const mockPlayer = ActiveMatchBuilder.single({ id: "player-1", matchId: "match-1", mmr: 145, team: Team.Blue });
      await manuallyAddBallChaser({
        id: mockPlayer.id,
        name: "player-1",
      });
      await prisma.leaderboard.create({
        data: {
          eventId: 1,
          mmr: 145,
          playerId: mockPlayer.id,
        },
      });
      await prisma.activeMatch.create({
        data: {
          id: mockPlayer.matchId,
          playerId: mockPlayer.id,
          team: mockPlayer.team,
        },
      });

      const actual = await activeMatchRepository.getPlayerInActiveMatch(mockPlayer.id);

      expect(actual).toEqual(
        expect.objectContaining({
          id: mockPlayer.id,
          matchId: mockPlayer.matchId,
          mmr: 145,
          team: Team.Blue,
        })
      );
    });

    it("counts broken queue votes in an active match", async () => {
      const mockMatchId = faker.datatype.uuid();
      const mockPlayers = [
        ActiveMatchBuilder.single({ id: "player-1", brokenQueue: true, matchId: mockMatchId, team: Team.Blue }),
        ActiveMatchBuilder.single({ id: "player-2", brokenQueue: false, matchId: mockMatchId, team: Team.Blue }),
        ActiveMatchBuilder.single({ id: "player-3", brokenQueue: true, matchId: mockMatchId, team: Team.Orange }),
      ];
      await manuallyAddActiveMatch(mockPlayers);

      await expect(activeMatchRepository.getAllBrokenQueueVotesInActiveMatch("player-1")).resolves.toBe(2);
    });

    it("returns broken queue voters partitioned by team", async () => {
      const mockMatchId = faker.datatype.uuid();
      const mockPlayers = [
        ActiveMatchBuilder.single({ id: "blue-1", brokenQueue: true, matchId: mockMatchId, team: Team.Blue }),
        ActiveMatchBuilder.single({ id: "blue-2", brokenQueue: false, matchId: mockMatchId, team: Team.Blue }),
        ActiveMatchBuilder.single({ id: "orange-1", brokenQueue: true, matchId: mockMatchId, team: Team.Orange }),
      ];
      await manuallyAddActiveMatch(mockPlayers);

      const voters = await activeMatchRepository.getAllBrokenQueueVotersInActiveMatch("blue-1");

      expect(voters.blueTeam.map((player) => player.id)).toEqual(["blue-1"]);
      expect(voters.orangeTeam.map((player) => player.id)).toEqual(["orange-1"]);
    });
  });

  describe("Exception handling tests", () => {
    it("throws if trying to add a ballchaser to an active match with no team", async () => {
      await expect(
        activeMatchRepository.addActiveMatch([BallChaserQueueBuilder.single({ team: null }) as any])
      ).rejects.toThrow();
    });

    it("throws when trying to update a player not in an active match", async () => {
      await expect(
        activeMatchRepository.updatePlayerInActiveMatch(BallChaserQueueBuilder.single().id, { reportedTeam: Team.Blue })
      ).rejects.toThrow();
    });
  });
});
