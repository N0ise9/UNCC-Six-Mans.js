import { ButtonInteraction, Message } from "discord.js";
import QueueRepository from "../repositories/QueueRepository";
import ActiveMatchRepository from "../repositories/ActiveMatchRepository";
import MessageBuilder from "../utils/MessageHelper/MessageBuilder";
import { fillTeams } from "../utils/devFillTeams";
import { ButtonCustomID } from "../utils/MessageHelper/CustomButtons";

export async function handleDevInteraction(buttonInteraction: ButtonInteraction): Promise<void> {
  const { message } = buttonInteraction;
  if (!(message instanceof Message)) return;

  switch (buttonInteraction.customId) {
    case ButtonCustomID.FillTeam: {
      const fullTeam = await fillTeams();

      await message.edit(MessageBuilder.fullQueueMessage(fullTeam));
      break;
    }
    case ButtonCustomID.RemoveAll: {
      await QueueRepository.removeAllBallChasersFromQueue();

      const ballChasers = await QueueRepository.getAllBallChasersInQueue();
      await message.edit(MessageBuilder.queueMessage(ballChasers));
      break;
    }
    case ButtonCustomID.BreakMatch: {
      await ActiveMatchRepository.removeAllPlayersInActiveMatch("346838372649795595");
      await message.delete();
      break;
    }
  }
}
