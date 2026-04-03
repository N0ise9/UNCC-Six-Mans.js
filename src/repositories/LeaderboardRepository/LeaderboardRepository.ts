import { PrismaClient, createPrismaClient } from "../../prisma";
import { LeaderboardWithBallChaser, PlayerStats, UpdatePlayerStatsInput } from "./types";
import EventRepository from "../EventRepository";
import { waitForAllPromises } from "../../utils";

export class LeaderboardRepository {
  #Prisma: PrismaClient | null;

  constructor() {
    this.#Prisma = null;
  }

  #getPrismaClient(): PrismaClient {
    if (!this.#Prisma) {
      this.#Prisma = createPrismaClient();
    }

    return this.#Prisma;
  }

  #calculatePlayerStats(playerStats: LeaderboardWithBallChaser): PlayerStats {
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

  /**
   * Gets the leaderboard stats for a specific player
   * @param id ID of the player to get stats for
   * @returns returns the player's stats if they exist, otherwise null
   */
  async getPlayerStats(id: string): Promise<Readonly<PlayerStats> | null> {
    const { id: currentEventId } = await EventRepository.getCurrentEvent();

    const playerStats = await this.#getPrismaClient().leaderboard.findUnique({
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

    return this.#calculatePlayerStats(playerStats);
  }

  /**
   * Retreives the top (n) number of players in the leaderboard
   * @param n Number of players to retrieve from the top of the leaderboard. Returns all entries if left undefined.
   * @returns An array of the top 'n' players in the leaderboard
   */
  async getPlayersStats(n?: number): Promise<ReadonlyArray<Readonly<PlayerStats>>> {
    const { id: currentEventId } = await EventRepository.getCurrentEvent();

    const playersStats = await this.#getPrismaClient().leaderboard.findMany({
      include: {
        player: true,
      },
      orderBy: [{ mmr: "desc" }, { wins: "desc" }],
      take: n,
      where: {
        eventId: currentEventId,
      },
    });

    return playersStats.map((playerStats) => this.#calculatePlayerStats(playerStats));
  }

  /**
   * Updates the stats for a list of players. Will update a player if they are already on the leaderboard,
   * otherwise it will add them.
   * @param playersUpdates An array of player stats to update the leaderboard with.
   */
  async updatePlayersStats(playersUpdates: Array<UpdatePlayerStatsInput>): Promise<void> {
    const { id: currentEventId } = await EventRepository.getCurrentEvent();

    await waitForAllPromises(playersUpdates, async (playerUpdates) => {
      await this.#getPrismaClient().leaderboard.upsert({
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

  async disconnect(): Promise<void> {
    if (!this.#Prisma) {
      return;
    }

    await this.#Prisma.$disconnect();
    this.#Prisma = null;
  }
}

export default new LeaderboardRepository();
