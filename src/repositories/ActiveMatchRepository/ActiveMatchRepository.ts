import { ActiveMatch, Prisma, PrismaClient } from "@prisma/client";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime";
import { Team } from "../../types/common";
import LeaderboardRepository from "../LeaderboardRepository";
import { generateRandomId, splitArray, waitForAllPromises } from "../../utils";
import { ActiveMatchTeams, NewActiveMatchInput, PlayerInActiveMatch, UpdatePlayerInActiveMatchInput } from "./types";

export class ActiveMatchRepository {
  #ActiveMatch: Prisma.ActiveMatchDelegate<Prisma.RejectOnNotFound | Prisma.RejectPerOperation | undefined>;

  constructor() {
    this.#ActiveMatch = new PrismaClient().activeMatch;
  }

  async addActiveMatch(newActiveMatchPlayers: Array<NewActiveMatchInput>): Promise<void> {
    const notEveryoneHasATeam = newActiveMatchPlayers.some((player) => !Number.isInteger(player.team));
    if (notEveryoneHasATeam) {
      throw new Error("Not all players are assigned a team.");
    }

    const matchId = generateRandomId();

    await this.#ActiveMatch.createMany({
      data: newActiveMatchPlayers.map((newActiveMatchPlayer) => ({
        id: matchId,
        playerId: newActiveMatchPlayer.id,
        team: newActiveMatchPlayer.team,
      })),
    });
  }

  async updatePlayerInActiveMatch(playerInMatchId: string, updates: UpdatePlayerInActiveMatchInput): Promise<void> {
    await this.#ActiveMatch
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
        if (err instanceof PrismaClientKnownRequestError && err.code === "P2025") {
          throw new Error(`Player with ID: ${playerInMatchId} is not in an active match.`);
        }
      });
  }

  async removeAllPlayersInActiveMatch(playerInMatchId: string): Promise<void> {
    await this.#ActiveMatch
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

        return this.#ActiveMatch.deleteMany({
          where: {
            id: match.id,
          },
        });
      });
  }

  async getAllBrokenQueueVotesInActiveMatch(playerInMatchId: string): Promise<number> {
    const allPlayersInMatch = await this.#ActiveMatch
      .findUnique({
        select: {
          id: true,
        },
        where: {
          playerId: playerInMatchId,
        },
      })
      .then((match) => {

        return this.#ActiveMatch.count({
          where: {
            brokenQueue: true,
            id: match?.id,
          },
        });
      });

    return allPlayersInMatch;
  }

  async getAllBrokenQueueVotersInActiveMatch(playerInMatchId: string): Promise<ActiveMatchTeams> {
    const allPlayersInMatch = await this.#ActiveMatch
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

        return this.#ActiveMatch.findMany({
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
    const allPlayersInMatch = await this.#ActiveMatch
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

        return this.#ActiveMatch.findMany({
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
    const stats = await LeaderboardRepository.getPlayerStats(playerInMatch.playerId);
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
    const playerInMatch = await this.#ActiveMatch.count({
      where: {
        playerId: playerInMatchId,
      },
    });

    return playerInMatch > 0;
  }

  async getPlayerInActiveMatch(playerInMatchId: string): Promise<PlayerInActiveMatch | null> {
    const playerInMatch = await this.#ActiveMatch.findUnique({
      where: {
        playerId: playerInMatchId,
      },
    });

    if (playerInMatch) {
      const player = this.#getPlayerInActiveMatchWithMmr(playerInMatch);
      return player;
    } else {
      return null;
    }
  }
}

export default new ActiveMatchRepository();
