import { Message } from "discord.js";
import QueueRepository from "../repositories/QueueRepository";
import { checkQueueTimes } from "../services/QueueService";
import MessageBuilder from "../utils/MessageHelper/MessageBuilder";

export function startQueueTimer(queueEmbed: Message) {
  let minuteCounter = 0;

  setInterval(async () => {
    minuteCounter++;

    const updatedList = await checkQueueTimes();

    if (updatedList) {
      await queueEmbed.edit(MessageBuilder.queueMessage(updatedList));
      minuteCounter = 0;
    } else if (minuteCounter >= 5) {
      const allPlayers = await QueueRepository.getAllBallChasersInQueue();

      if (allPlayers.length > 0 && allPlayers.length < 6) {
        await queueEmbed.edit(MessageBuilder.queueMessage(allPlayers));
      }

      minuteCounter = 0;
    }
    // every 1 minute
  }, 1 * 60 * 1000);
}
