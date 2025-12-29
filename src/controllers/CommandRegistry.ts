import { REST, RESTPostAPIApplicationCommandsJSONBody, Routes, SlashCommandBuilder } from "discord.js";

/**
 * Registers all application slash commands in a single request so they cannot overwrite each other.
 * Combines Admin and EasterEggs commands.
 */
export async function registerAllSlashCommands(clientId: string, guildId: string, token: string) {
  const rest = new REST({ version: "9" }).setToken(token);

  //   // Admin commands
  //   const kickCommand = new SlashCommandBuilder()
  //     .setName("kick")
  //     .setDescription("Removes a player from the queue.")
  //     .addUserOption((option) =>
  //       option.setName("player").setDescription("The player you want to remove.").setRequired(true)
  //     )
  //     .toJSON();

  //   const clearCommand = new SlashCommandBuilder().setName("clear").setDescription("Clears the queue.").toJSON();

  // Easter eggs commands
  const norm = new SlashCommandBuilder()
    .setName("norm")
    .setDescription("Ask Norm anything.")
    .addStringOption((opt) => opt.setName("prompt").setDescription("What do you want to say?").setRequired(true))
    .addAttachmentOption((opt) => opt.setName("image1").setDescription("Optional image 1"))
    .addAttachmentOption((opt) => opt.setName("image2").setDescription("Optional image 2"))
    .addAttachmentOption((opt) => opt.setName("image3").setDescription("Optional image 3"))
    .toJSON();

  const sora = new SlashCommandBuilder()
    .setName("sora")
    .setDescription("Generate a short video with Sora.")
    .addStringOption((opt) => opt.setName("prompt").setDescription("Video Prompt").setRequired(true))
    .addStringOption((opt) =>
      opt
        .setName("duration")
        .setDescription("Duration in seconds (4, 8, 12)")
        .setRequired(false)
        .addChoices(
          { name: "4 seconds", value: "4" },
          { name: "8 seconds", value: "8" },
          { name: "12 seconds", value: "12" }
        )
    )
    .toJSON();

  try {
    const commands: Array<RESTPostAPIApplicationCommandsJSONBody> = [norm, sora];
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
  } catch (error) {
    console.error(error);
  }
}
