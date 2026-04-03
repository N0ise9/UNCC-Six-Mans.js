import { Message } from "discord.js";
import QueueRepository from "../repositories/QueueRepository";
import { checkQueueTimes } from "../services/QueueService";
import MessageBuilder from "../utils/MessageHelper/MessageBuilder";
import { messageEditScheduler } from "../utils/MessageEditScheduler";

export function startQueueTimer(queueEmbed: Message) {
  let minuteCounter = 0;

  setInterval(
    async () => {
      minuteCounter++;

      const updatedList = await checkQueueTimes();

      if (updatedList) {
        messageEditScheduler.schedule(queueEmbed, MessageBuilder.queueMessage(updatedList));
        minuteCounter = 0;
        return;
      }

      if (minuteCounter >= 5) {
        const allPlayers = await QueueRepository.getAllBallChasersInQueue();
        const target = QueueRepository.getTwosEnabled() ? 4 : 6;

        if (allPlayers.length > 0 && allPlayers.length < target) {
          messageEditScheduler.schedule(queueEmbed, MessageBuilder.queueMessage(allPlayers));
        }

        minuteCounter = 0;
      }
    },
    1 * 60 * 1000
  );
}
