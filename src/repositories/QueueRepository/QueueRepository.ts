import { AddBallChaserToQueueInput, PlayerInQueue, QueueWithBallChaser, UpdateBallChaserInQueueInput } from "./types";
import { PrismaClient } from "../../prisma";
import { DateTime } from "luxon";
import { LeaderboardRepository } from "../LeaderboardRepository";
import { waitForAllPromises } from "../../utils";
import { Team } from "../../types/common";

export class QueueRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly leaderboardRepository: Pick<LeaderboardRepository, "getPlayerStats">
  ) {}

  async #getPlayerMmr(playerInQueue: QueueWithBallChaser): Promise<PlayerInQueue> {
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

  /**
   * Retrieves a BallChaser with a specific Discord ID
   * @param id Discord ID of the BallChaser to retrieve
   * @returns A BallChaser object if the player is found, otherwise null
   */
  async getBallChaserInQueue(id: string): Promise<Readonly<PlayerInQueue> | null> {
    const playerInQueue = await this.prisma.queue.findUnique({
      include: {
        player: true,
      },
      where: {
        playerId: id,
      },
    });
    if (playerInQueue) {
      return this.#getPlayerMmr(playerInQueue);
    } else {
      return null;
    }
  }

  /**
   * Retrieves all BallChasers in the queue
   * @returns A list of all BallChasers currently in the queue
   */
  async getAllBallChasersInQueue(): Promise<ReadonlyArray<Readonly<PlayerInQueue>>> {
    const allPlayersInQueue = await this.prisma.queue.findMany({
      include: {
        player: true,
      },
    });

    const allPlayersWithMmr = await waitForAllPromises(allPlayersInQueue, async (playerInQueue) => {
      return await this.#getPlayerMmr(playerInQueue);
    });

    // sort so that shorter queue times are first
    allPlayersWithMmr.sort((a, b) => a.queueTime.toMillis() - b.queueTime.toMillis());
    return allPlayersWithMmr;
  }

  /**
   * Removes the BallChaser from the queue with the specified ID
   * @param id Discord ID of the BallChaser to remove from the queue
   */
  async removeBallChaserFromQueue(id: string): Promise<void> {
    await this.prisma.queue.delete({ where: { playerId: id } }).catch(() => {
      // Leaving when not queued should be a safe no-op for the active runtime.
    });
  }

  /**
   * Removes all BallChasers currently in the queue.
   */
  async removeAllBallChasersFromQueue(): Promise<void> {
    await this.prisma.queue.deleteMany();
  }

  /**
   * Function for updating an existing BallChaser in the queue.
   * @param options BallChaser fields to update. ID field is required for retrieving the BallChaser object to update.
   */
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

  /**
   * Adds a new BallChaser to the queue.
   * @param ballChaserToAdd New BallChaser object to add to the queue.
   */
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
          create: {
            queueTime: ballChaserToAdd.queueTime.toISO()!,
          },
        },
      },
      where: {
        id: ballChaserToAdd.id,
      },
    });
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
}
