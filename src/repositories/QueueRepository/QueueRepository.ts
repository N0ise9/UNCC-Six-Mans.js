import { AddBallChaserToQueueInput, PlayerInQueue, QueueWithBallChaser, UpdateBallChaserInQueueInput } from "./types";
import { PrismaClient, Prisma } from "@prisma/client";
import { DateTime } from "luxon";
import LeaderboardRepository from "../LeaderboardRepository";
import { waitForAllPromises } from "../../utils";
import { Team } from "../../types/common";
// import { InvalidCommand, isRecordNotFoundError } from "../../utils/InvalidCommand";
import { ButtonInteraction } from "discord.js";
import { ButtonCustomID } from "../../utils/MessageHelper/CustomButtons";

const playersMap = new Map<string, string>();
interface CaptainsRandomVotes {
  captains: number;
  random: number;
}

export class QueueRepository {
  #Queue: Prisma.QueueDelegate<Prisma.RejectPerOperation>;
  #BallChasers: Prisma.BallChaserDelegate<Prisma.RejectPerOperation>;

  constructor() {
    this.#Queue = new PrismaClient().queue;
    this.#BallChasers = new PrismaClient().ballChaser;
  }

  async #getPlayerMmr(playerInQueue: QueueWithBallChaser): Promise<PlayerInQueue> {
    const lb = await LeaderboardRepository.getPlayerStats(playerInQueue.player.id);
    return {
      id: playerInQueue.player.id,
      isCap: playerInQueue.isCap,
      mmr: lb?.mmr ?? 100,
      name: playerInQueue.player.name,
      queueTime: DateTime.fromJSDate(playerInQueue.queueTime),
      team: playerInQueue.team,
    };
  }

  async countCaptainsRandomVote(buttonInteraction: ButtonInteraction): Promise<CaptainsRandomVotes> {
    playersMap.set(buttonInteraction.user.id, buttonInteraction.customId);
    let captainsCounter = 0;
    let randomCounter = 0;
    for (const value of playersMap.values()) {
      if (value == ButtonCustomID.ChooseTeam) {
        captainsCounter += 1;
      } else {
        randomCounter += 1;
      }
    }
    return {
      captains: captainsCounter,
      random: randomCounter,
    };
  }

  async getCaptainsRandomVoters(): Promise<Map<string, string>> {
    return playersMap;
  }

  async resetCaptainsRandomVoters(): Promise<void> {
    playersMap.clear();
  }

  /**
   * Retrieves a BallChaser with a specific Discord ID
   * @param id Discord ID of the BallChaser to retrieve
   * @returns A BallChaser object if the player is found, otherwise null
   */
  async getBallChaserInQueue(id: string): Promise<Readonly<PlayerInQueue> | null> {
    const playerInQueue = await this.#Queue.findUnique({
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
    const allPlayersInQueue = await this.#Queue.findMany({
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
    await this.#Queue.delete({ where: { playerId: id } }).catch(() => {

      // Commenting this out because if a player leaves while not in queue, the bot freezes and stops
      // if (isRecordNotFoundError(err)) {
      //   throw new InvalidCommand("Player not in queue.");
      // } else {
      //   console.error(err);
      // }
    });
  }

  /**
   * Removes all BallChasers currently in the queue.
   */
  async removeAllBallChasersFromQueue(): Promise<void> {
    await this.#Queue.deleteMany();
  }

  /**
   * Function for updating an existing BallChaser in the queue.
   * @param options BallChaser fields to update. ID field is required for retrieving the BallChaser object to update.
   */
  async updateBallChaserInQueue({ id, ...updates }: UpdateBallChaserInQueueInput): Promise<void> {
    await this.#Queue.update({
      data: {
        isCap: updates.isCap,
        queueTime: updates.queueTime?.toISO(),
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
    await this.#BallChasers.upsert({
      create: {
        id: ballChaserToAdd.id,
        name: ballChaserToAdd.name,
        queue: {
          create: {
            queueTime: ballChaserToAdd.queueTime.toISO(),
          },
        },
      },
      update: {
        name: ballChaserToAdd.name,
        queue: {
          create: {
            queueTime: ballChaserToAdd.queueTime.toISO(),
          },
        },
      },
      where: {
        id: ballChaserToAdd.id,
      },
    });
  }

  async isPlayerInQueue(ballChaserToCheck: string): Promise<boolean> {
    const playerInMatch = await this.#Queue.count({
      where: {
        playerId: ballChaserToCheck,
      },
    });

    return playerInMatch > 0;
  }

  async isTeamCaptain(ballChaserToCheck: string, teamToCheck: Team): Promise<boolean> {
    const isCaptain = await this.#Queue.count({
      where: {
        playerId: ballChaserToCheck,
        team: teamToCheck,
      },
    });

    return isCaptain > 0;
  }
}

export default new QueueRepository();
