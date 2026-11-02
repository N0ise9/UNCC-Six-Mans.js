import { BallChaser, Queue } from "../../prisma";
import { DateTime } from "luxon";
import { Team } from "../../types/common";

export interface UpdateBallChaserInQueueInput {
  id: string;
  isCap?: boolean;
  team?: Team | null;
  queueTime?: DateTime;
}

export type PlayerInQueue = {
  id: string;
  isCap: boolean;
  mmr: number;
  name: string;
  queueTime: DateTime;
  team: Team | null;
};

export interface AddBallChaserToQueueInput {
  id: string;
  name: string;
  queueTime: DateTime;
}

export type QueueWithBallChaser = Queue & { player: BallChaser; team: Team | null };
