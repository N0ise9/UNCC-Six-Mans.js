import { Message, StringSelectMenuInteraction } from "discord.js";
import QueueRepository from "../repositories/QueueRepository";
import { PlayerInQueue } from "../repositories/QueueRepository/types";
import { createMatchFromChosenTeams } from "../services/MatchService";
import { bluePlayerChosen, orangePlayerChosen } from "../services/TeamAssignmentService";
import { Team } from "../types/common";
import MessageBuilder, { MenuCustomID } from "../utils/MessageHelper/MessageBuilder";
import AsyncMutex from "../utils/AsyncMutex";
import { messageEditScheduler } from "../utils/MessageEditScheduler";

const queueMutex = new AsyncMutex();

export async function handleMenuInteraction(menuInteraction: StringSelectMenuInteraction): Promise<void> {
  const { message } = menuInteraction;
  if (!(message instanceof Message)) return;

  const isDev = process.env["ENVIRONMENT"] === "dev";

  switch (menuInteraction.customId) {
    case MenuCustomID.BlueSelect: {
      const release = await queueMutex.acquire();
      try {
        const isCaptain = await QueueRepository.isTeamCaptain(menuInteraction.user.id, Team.Blue);
        if (!isCaptain && !isDev) return;

        const playersLeft = await bluePlayerChosen(menuInteraction.values[0]);

        if (QueueRepository.getTwosEnabled()) {
          const emptyQueue: PlayerInQueue[] = [];
          const newActiveMatch = await createMatchFromChosenTeams();

          await message.reply(await MessageBuilder.activeMatchMessage(newActiveMatch));
          messageEditScheduler.schedule(message, MessageBuilder.queueMessage(emptyQueue));

          QueueRepository.resetCaptainsRandomVoters();
          QueueRepository.resetTwosVoters();
          QueueRepository.resetTwosEnabled();
        } else {
          messageEditScheduler.schedule(message, MessageBuilder.captainChooseMessage(false, playersLeft, false));
        }
      } finally {
        release();
      }
      break;
    }

    case MenuCustomID.OrangeSelect: {
      const release = await queueMutex.acquire();
      try {
        const isCaptain = await QueueRepository.isTeamCaptain(menuInteraction.user.id, Team.Orange);
        if (!isCaptain && !isDev) return;

        const emptyQueue: PlayerInQueue[] = [];
        await orangePlayerChosen(menuInteraction.values);

        const newActiveMatch = await createMatchFromChosenTeams();

        await message.reply(await MessageBuilder.activeMatchMessage(newActiveMatch));
        messageEditScheduler.schedule(message, MessageBuilder.queueMessage(emptyQueue));

        QueueRepository.resetCaptainsRandomVoters();
        QueueRepository.resetTwosVoters();
        QueueRepository.resetTwosEnabled();
      } finally {
        release();
      }
      break;
    }
  }
}
