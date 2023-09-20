import { CommandInteraction, GuildMemberRoleManager, Message, Routes } from "discord.js";
import { RESTPostAPIApplicationCommandsJSONBody, SlashCommandBuilder, REST } from "discord.js";
import QueueRepository from "../repositories/QueueRepository";
import { kickPlayerFromQueue } from "../services/AdminService";
import { InvalidCommand } from "../utils/InvalidCommand";
import MessageBuilder from "../utils/MessageHelper/MessageBuilder";

const enum AdminCommandOptions {
  Kick = "kick",
  Clear = "clear",
}

export async function handleAdminInteraction(slashCommandInteraction: CommandInteraction, queueEmbed: Message) {
  const memberRoles = slashCommandInteraction.member?.roles;
  if (
    !memberRoles ||
    (memberRoles instanceof GuildMemberRoleManager && memberRoles.cache.every((role) => role.name !== "Bot Admin")) ||
    (Array.isArray(memberRoles) && !memberRoles.includes("Bot Admin"))
  ) {
    await slashCommandInteraction.editReply(
      // eslint-disable-next-line max-len
      "What do you think you're doing? Trying to run an admin command when you're not a Bot Admin. Typical. How dare you even consider that my parents didn't think to check this. You think this is their first time writing code? Of course not! Now scram before I call my parents to come pick me up."
    );
    return;
  }

  switch (slashCommandInteraction.commandName) {
    case AdminCommandOptions.Kick: {
      const playerToRemove = slashCommandInteraction.options.getUser("player");
      if (!playerToRemove) return;

      try {
        const updatedList = await kickPlayerFromQueue(playerToRemove.id);

        await Promise.all([
          queueEmbed.edit(MessageBuilder.queueMessage(updatedList)),
          slashCommandInteraction.editReply(`${playerToRemove.username} has been removed from the queue.`),
        ]);
      } catch (err) {
        if (err instanceof InvalidCommand) {
          await slashCommandInteraction.editReply(
            `Error trying to remove: ${playerToRemove.username}\n${err.name}: ${err.message}`
          );
        }
      }

      break;
    }
    case AdminCommandOptions.Clear:
      // leaving this out of the Promise.all in case it fails we don't want to do the other two
      await QueueRepository.removeAllBallChasersFromQueue();
      await Promise.all([
        queueEmbed.edit(MessageBuilder.queueMessage([])),
        slashCommandInteraction.editReply("Queue has been cleared."),
      ]);
      break;
  }
}

export async function registerAdminSlashCommands(clientId: string, guildId: string, token: string) {
  const rest = new REST({ version: "9" }).setToken(token);

  const kickCommand = new SlashCommandBuilder()
    .setName(AdminCommandOptions.Kick)
    .setDescription("Removes a player from the queue.")
    .addUserOption((option) => {
      return option.setName("player").setDescription("The player you want to remove.").setRequired(true);
    })
    .toJSON();

  const clearCommand = new SlashCommandBuilder()
    .setName(AdminCommandOptions.Clear)
    .setDescription("Clears the queue.")
    .toJSON();

  try {
    const commands: Array<RESTPostAPIApplicationCommandsJSONBody> = [kickCommand, clearCommand];

    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
  } catch (error) {
    console.error(error);
  }
}
