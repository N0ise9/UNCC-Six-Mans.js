import { DateTime } from "luxon";
import QueueRepository from "../repositories/QueueRepository";
import { PlayerInQueue, AddBallChaserToQueueInput } from "../repositories/QueueRepository/types";

export async function fillTeams(): Promise<ReadonlyArray<PlayerInQueue>> {
  const ballchasers = await QueueRepository.getAllBallChasersInQueue();
  const numPlayersToFill = 6 - ballchasers.length;

  for (let i = 0; i < numPlayersToFill; i++) {
    const player = testPlayers[i];
    await QueueRepository.addBallChaserToQueue(player);
  }

  const updatedQueue = await QueueRepository.getAllBallChasersInQueue();

  return updatedQueue;
}

const testPlayers: AddBallChaserToQueueInput[] = [
  {
    id: "346838372649795595",
    name: "Tux",
    queueTime: DateTime.now(),
  },
  {
    id: "528369347807412227",
    name: "Don",
    queueTime: DateTime.now(),
  },
  {
    id: "163667436229361664",
    name: "h.",
    queueTime: DateTime.now(),
  },
  {
    id: "457671314988204033",
    name: "capchaotic",
    queueTime: DateTime.now(),
  },
  {
    id: "698269832537309225",
    name: "Omen",
    queueTime: DateTime.now(),
  },
  {
    id: "366398370056634370",
    name: "destroyerkille1",
    queueTime: DateTime.now(),
  },
];
