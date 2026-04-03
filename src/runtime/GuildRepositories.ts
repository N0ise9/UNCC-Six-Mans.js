import { ActiveMatch, PrismaClient } from "@prisma/client";
import { DateTime } from "luxon";
import { Team } from "../types/common";
import { generateRandomId, splitArray, waitForAllPromises } from "../utils";
import {
  ActiveMatchTeams,
  NewActiveMatchInput,
  PlayerInActiveMatch,
  UpdatePlayerInActiveMatchInput,
} from "../repositories/ActiveMatchRepository/types";
import { Event } from "../repositories/EventRepository/types";
import { LeaderboardWithBallChaser, PlayerStats, UpdatePlayerStatsInput } from "../repositories/LeaderboardRepository/types";
import {
  AddBallChaserToQueueInput,
  PlayerInQueue,
  QueueWithBallChaser,
  UpdateBallChaserInQueueInput,
} from "../repositories/QueueRepository/types";

class GuildEventRepository {
  private currentEventCache: Event | null = null;

  constructor(private readonly prisma: PrismaClient) {}

  async getCurrentEvent(): Promise<Event> {
    if (this.currentEventCache) {
      return this.currentEventCache;
    }

    const currentEventResult = await this.prisma.event.findFirst({
      where: {
        endDate: null,
      },
    });

    if (!currentEventResult) {
      throw new Error("No current event. There should always be an active event.");
    }

    const currentEvent: Event = {
      endDate: currentEventResult.endDate,
      id: currentEventResult.id,
      mmrMult: currentEventResult.mmrMult.toNumber(),
      name: currentEventResult.name,
      startDate: currentEventResult.startDate,
    };

    this.currentEventCache = currentEvent;
    return currentEvent;
  }
}

class GuildLeaderboardRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly eventRepository: GuildEventRepository
  ) {}

  private calculatePlayerStats(playerStats: LeaderboardWithBallChaser): PlayerStats {
    return {
      id: playerStats.player.id,
      losses: playerStats.losses,
      matchesPlayed: playerStats.wins + playerStats.losses,
      mmr: playerStats.mmr,
      name: playerStats.player.name,
      winPerc: playerStats.wins / (playerStats.wins + playerStats.losses),
      wins: playerStats.wins,
    };
  }

  async getPlayerStats(id: string): Promise<Readonly<PlayerStats> | null> {
    const { id: currentEventId } = await this.eventRepository.getCurrentEvent();

    const playerStats = await this.prisma.leaderboard.findUnique({
      include: {
        player: true,
      },
      where: {
        eventId_playerId: {
          eventId: currentEventId,
          playerId: id,
        },
      },
    });

    if (!playerStats) {
      return null;
    }

    return this.calculatePlayerStats(playerStats);
  }

  async getPlayersStats(n?: number): Promise<ReadonlyArray<Readonly<PlayerStats>>> {
    const { id: currentEventId } = await this.eventRepository.getCurrentEvent();

    const playersStats = await this.prisma.leaderboard.findMany({
      include: {
        player: true,
      },
      orderBy: [{ mmr: "desc" }, { wins: "desc" }],
      take: n,
      where: {
        eventId: currentEventId,
      },
    });

    return playersStats.map((playerStats) => this.calculatePlayerStats(playerStats));
  }

  async updatePlayersStats(playersUpdates: Array<UpdatePlayerStatsInput>): Promise<void> {
    const { id: currentEventId } = await this.eventRepository.getCurrentEvent();

    await waitForAllPromises(playersUpdates, async (playerUpdates) => {
      await this.prisma.leaderboard.upsert({
        create: {
          eventId: currentEventId,
          losses: playerUpdates.losses,
          mmr: playerUpdates.mmr,
          playerId: playerUpdates.id,
          wins: playerUpdates.wins,
        },
        update: {
          losses: playerUpdates.losses,
          mmr: playerUpdates.mmr,
          wins: playerUpdates.wins,
        },
        where: {
          eventId_playerId: {
            eventId: currentEventId,
            playerId: playerUpdates.id,
          },
        },
      });
    });
  }
}

class GuildQueueRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly leaderboardRepository: GuildLeaderboardRepository
  ) {}

  private async getPlayerMmr(playerInQueue: QueueWithBallChaser): Promise<PlayerInQueue> {
    const lb = await this.leaderboardRepository.getPlayerStats(playerInQueue.player.id);
    return {
      id: playerInQueue.player.id,
      isCap: playerInQueue.isCap,
      mmr: lb?.mmr ?? 100,
      name: playerInQueue.player.name,
      queueTime: DateTime.fromJSDate(playerInQueue.queueTime),
      team: playerInQueue.team,
    };
  }

  async addBallChaserToQueue(ballChaserToAdd: AddBallChaserToQueueInput): Promise<void> {
    await this.prisma.ballChaser.upsert({
      create: {
        id: ballChaserToAdd.id,
        name: ballChaserToAdd.name,
        queue: {
          create: {
            queueTime: ballChaserToAdd.queueTime.toISO()!,
          },
        },
      },
      update: {
        name: ballChaserToAdd.name,
        queue: {
          upsert: {
            create: {
              queueTime: ballChaserToAdd.queueTime.toISO()!,
            },
            update: {
              queueTime: ballChaserToAdd.queueTime.toISO()!,
            },
          },
        },
      },
      where: {
        id: ballChaserToAdd.id,
      },
    });
  }

  async getAllBallChasersInQueue(): Promise<ReadonlyArray<Readonly<PlayerInQueue>>> {
    const allPlayersInQueue = await this.prisma.queue.findMany({
      include: {
        player: true,
      },
    });

    const allPlayersWithMmr = await waitForAllPromises(allPlayersInQueue, async (playerInQueue) => {
      return await this.getPlayerMmr(playerInQueue);
    });

    allPlayersWithMmr.sort((a, b) => a.queueTime.toMillis() - b.queueTime.toMillis());
    return allPlayersWithMmr;
  }

  async getBallChaserInQueue(id: string): Promise<Readonly<PlayerInQueue> | null> {
    const playerInQueue = await this.prisma.queue.findUnique({
      include: {
        player: true,
      },
      where: {
        playerId: id,
      },
    });

    if (!playerInQueue) {
      return null;
    }

    return this.getPlayerMmr(playerInQueue);
  }

  async isPlayerInQueue(ballChaserToCheck: string): Promise<boolean> {
    const playerInMatch = await this.prisma.queue.count({
      where: {
        playerId: ballChaserToCheck,
      },
    });

    return playerInMatch > 0;
  }

  async isTeamCaptain(ballChaserToCheck: string, teamToCheck: Team): Promise<boolean> {
    const isCaptain = await this.prisma.queue.count({
      where: {
        playerId: ballChaserToCheck,
        team: teamToCheck,
      },
    });

    return isCaptain > 0;
  }

  async removeAllBallChasersFromQueue(): Promise<void> {
    await this.prisma.queue.deleteMany();
  }

  async removeBallChaserFromQueue(id: string): Promise<void> {
    await this.prisma.queue.delete({ where: { playerId: id } }).catch(() => undefined);
  }

  async updateBallChaserInQueue({ id, ...updates }: UpdateBallChaserInQueueInput): Promise<void> {
    await this.prisma.queue.update({
      data: {
        isCap: updates.isCap,
        queueTime: updates.queueTime?.toISO()?.toString(),
        team: updates.team,
      },
      where: { playerId: id },
    });
  }
}

class GuildActiveMatchRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly leaderboardRepository: GuildLeaderboardRepository
  ) {}

  async addActiveMatch(newActiveMatchPlayers: Array<NewActiveMatchInput>): Promise<void> {
    const notEveryoneHasATeam = newActiveMatchPlayers.some((player) => !Number.isInteger(player.team));
    if (notEveryoneHasATeam) {
      throw new Error("Not all players are assigned a team.");
    }

    const matchId = generateRandomId();

    await this.prisma.activeMatch.createMany({
      data: newActiveMatchPlayers.map((newActiveMatchPlayer) => ({
        id: matchId,
        playerId: newActiveMatchPlayer.id,
        team: newActiveMatchPlayer.team,
      })),
    });
  }

  async getAllBrokenQueueVotersInActiveMatch(playerInMatchId: string): Promise<ActiveMatchTeams> {
    const allPlayersInMatch = await this.prisma.activeMatch
      .findUnique({
        select: {
          id: true,
        },
        where: {
          playerId: playerInMatchId,
        },
      })
      .then((match) => {
        if (!match) {
          return [] as ActiveMatch[];
        }

        return this.prisma.activeMatch.findMany({
          where: {
            brokenQueue: true,
            id: match.id,
          },
        });
      });

    const allPlayersInActiveMatch = await waitForAllPromises(allPlayersInMatch, async (playerInMatch) => {
      return await this.getPlayerInActiveMatchWithMmr(playerInMatch);
    });

    const [blueTeam, orangeTeam] = splitArray(allPlayersInActiveMatch, (p) => p.team === Team.Blue);
    return {
      blueTeam,
      orangeTeam,
    };
  }

  async getAllBrokenQueueVotesInActiveMatch(playerInMatchId: string): Promise<number> {
    return await this.prisma.activeMatch
      .findUnique({
        select: {
          id: true,
        },
        where: {
          playerId: playerInMatchId,
        },
      })
      .then((match) => {
        return this.prisma.activeMatch.count({
          where: {
            brokenQueue: true,
            id: match?.id,
          },
        });
      });
  }

  async getAllPlayersInActiveMatch(playerInMatchId: string): Promise<ActiveMatchTeams> {
    const allPlayersInMatch = await this.prisma.activeMatch
      .findUnique({
        select: {
          id: true,
        },
        where: {
          playerId: playerInMatchId,
        },
      })
      .then((match) => {
        if (!match) {
          return [] as ActiveMatch[];
        }

        return this.prisma.activeMatch.findMany({
          where: {
            id: match.id,
          },
        });
      });

    const allPlayersInActiveMatch = await waitForAllPromises(allPlayersInMatch, async (playerInMatch) => {
      return await this.getPlayerInActiveMatchWithMmr(playerInMatch);
    });

    const [blueTeam, orangeTeam] = splitArray(allPlayersInActiveMatch, (p) => p.team === Team.Blue);
    return {
      blueTeam,
      orangeTeam,
    };
  }

  async getPlayerInActiveMatch(playerInMatchId: string): Promise<PlayerInActiveMatch | null> {
    const playerInMatch = await this.prisma.activeMatch.findUnique({
      where: {
        playerId: playerInMatchId,
      },
    });

    if (!playerInMatch) {
      return null;
    }

    return this.getPlayerInActiveMatchWithMmr(playerInMatch);
  }

  async isPlayerInActiveMatch(playerInMatchId: string): Promise<boolean> {
    const playerInMatch = await this.prisma.activeMatch.count({
      where: {
        playerId: playerInMatchId,
      },
    });

    return playerInMatch > 0;
  }

  async removeAllPlayersInActiveMatch(playerInMatchId: string): Promise<void> {
    await this.prisma.activeMatch
      .findUnique({
        select: {
          id: true,
        },
        where: {
          playerId: playerInMatchId,
        },
      })
      .then((match) => {
        if (!match) {
          throw new Error(`Player with ID: ${playerInMatchId} is not in an active match.`);
        }

        return this.prisma.activeMatch.deleteMany({
          where: {
            id: match.id,
          },
        });
      });
  }

  async updatePlayerInActiveMatch(playerInMatchId: string, updates: UpdatePlayerInActiveMatchInput): Promise<void> {
    await this.prisma.activeMatch.update({
      data: {
        brokenQueue: updates.brokenQueue,
        reportedTeam: updates.reportedTeam,
      },
      where: {
        playerId: playerInMatchId,
      },
    });
  }

  private async getPlayerInActiveMatchWithMmr(playerInMatch: ActiveMatch): Promise<PlayerInActiveMatch> {
    const stats = await this.leaderboardRepository.getPlayerStats(playerInMatch.playerId);
    return {
      brokenQueue: playerInMatch.brokenQueue,
      id: playerInMatch.playerId,
      matchId: playerInMatch.id,
      mmr: stats ? stats.mmr : 100,
      reportedTeam: playerInMatch.reportedTeam,
      team: playerInMatch.team,
    };
  }
}

export class GuildRepositories {
  readonly activeMatch: GuildActiveMatchRepository;
  readonly event: GuildEventRepository;
  readonly leaderboard: GuildLeaderboardRepository;
  readonly queue: GuildQueueRepository;

  constructor(private readonly prisma: PrismaClient) {
    this.event = new GuildEventRepository(prisma);
    this.leaderboard = new GuildLeaderboardRepository(prisma, this.event);
    this.queue = new GuildQueueRepository(prisma, this.leaderboard);
    this.activeMatch = new GuildActiveMatchRepository(prisma, this.leaderboard);
  }

  getPrismaClient(): PrismaClient {
    return this.prisma;
  }
}
