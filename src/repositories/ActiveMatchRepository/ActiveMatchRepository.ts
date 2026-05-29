import { ActiveMatch, Prisma, PrismaClient } from "../../prisma";
import { Team } from "../../types/common";
import { LeaderboardRepository } from "../LeaderboardRepository";
import { generateRandomId, splitArray, waitForAllPromises } from "../../utils";
import { ActiveMatchTeams, NewActiveMatchInput, PlayerInActiveMatch, UpdatePlayerInActiveMatchInput } from "./types";

export class ActiveMatchRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly leaderboardRepository: Pick<LeaderboardRepository, "getPlayerStats">
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

  async updatePlayerInActiveMatch(playerInMatchId: string, updates: UpdatePlayerInActiveMatchInput): Promise<void> {
    await this.prisma.activeMatch
      .update({
        data: {
          brokenQueue: updates.brokenQueue,
          reportedTeam: updates.reportedTeam,
        },
        where: {
          playerId: playerInMatchId,
        },
      })
      .catch((err) => {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
          throw new Error(`Player with ID: ${playerInMatchId} is not in an active match.`);
        }
      });
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
          console.warn(`Player with ID: ${playerInMatchId} is not in an active match.`);
          return [];
        }

        return this.prisma.activeMatch.findMany({
          where: {
            brokenQueue: true,
            id: match.id,
          },
        });
      });

    const allPlayersInActiveMatch = await waitForAllPromises(allPlayersInMatch, async (playerInMatch) => {
      return await this.#getPlayerInActiveMatchWithMmr(playerInMatch);
    });

    const [blueTeam, orangeTeam] = splitArray(allPlayersInActiveMatch, (p) => p.team === Team.Blue);

    return {
      blueTeam,
      orangeTeam,
    };
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
          console.warn(`Player with ID: ${playerInMatchId} is not in an active match.`);
          return [];
        }

        return this.prisma.activeMatch.findMany({
          where: {
            id: match.id,
          },
        });
      });

    const allPlayersInActiveMatch = await waitForAllPromises(allPlayersInMatch, async (playerInMatch) => {
      return await this.#getPlayerInActiveMatchWithMmr(playerInMatch);
    });

    const [blueTeam, orangeTeam] = splitArray(allPlayersInActiveMatch, (p) => p.team === Team.Blue);

    return {
      blueTeam,
      orangeTeam,
    };
  }

  async #getPlayerInActiveMatchWithMmr(playerInMatch: ActiveMatch): Promise<PlayerInActiveMatch> {
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

  async isPlayerInActiveMatch(playerInMatchId: string): Promise<boolean> {
    const playerInMatch = await this.prisma.activeMatch.count({
      where: {
        playerId: playerInMatchId,
      },
    });

    return playerInMatch > 0;
  }

  async getPlayerInActiveMatch(playerInMatchId: string): Promise<PlayerInActiveMatch | null> {
    const playerInMatch = await this.prisma.activeMatch.findUnique({
      where: {
        playerId: playerInMatchId,
      },
    });

    if (playerInMatch) {
      return this.#getPlayerInActiveMatchWithMmr(playerInMatch);
    } else {
      return null;
    }
  }
}
