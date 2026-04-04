import {
  ChannelType,
  PermissionFlagsBits,
  REST,
  RESTPostAPIApplicationCommandsJSONBody,
  Routes,
  SlashCommandBuilder,
} from "discord.js";

function isSoraEnabled(): boolean {
  return (process.env["ENABLE_SORA"] ?? "false").toLowerCase() === "true";
}

export async function registerAllSlashCommands(clientId: string, token: string) {
  const rest = new REST({ version: "10" }).setToken(token);

  const kickCommand = new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Removes a player from the queue.")
    .addUserOption((option) =>
      option.setName("player").setDescription("The player you want to remove.").setRequired(true)
    )
    .toJSON();

  const clearCommand = new SlashCommandBuilder().setName("clear").setDescription("Clears the queue.").toJSON();

  const prismaCommand = new SlashCommandBuilder()
    .setName("prisma")
    .setDescription("Launch Prisma Studio for this guild's database on the host machine.")
    .addStringOption((option) =>
      option.setName("password").setDescription("Host-side Prisma Studio password").setRequired(true)
    )
    .toJSON();

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
    .addStringOption((opt) => opt.setName("prompt").setDescription("Video prompt").setRequired(true))
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

  const setup = new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Configure this guild for the single-instance bot runtime.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((subcommand) => {
      return subcommand.setName("show").setDescription("Show the current guild configuration.");
    })
    .addSubcommand((subcommand) => {
      return subcommand.setName("disable").setDescription("Disable this guild configuration.");
    })
    .addSubcommand((subcommand) => {
      return subcommand
        .setName("set")
        .setDescription("Create or update the guild configuration.")
        .addChannelOption((option) =>
          option
            .setName("queue_channel")
            .setDescription("Queue channel")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
        .addChannelOption((option) =>
          option
            .setName("leaderboard_channel")
            .setDescription("Leaderboard channel")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
        .addChannelOption((option) =>
          option
            .setName("chat_channel")
            .setDescription("Chat channel where /norm and /sora may be used")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(true)
        )
        .addStringOption((option) =>
          option.setName("database_url").setDescription("Per-guild database URL").setRequired(true)
        )
        .addChannelOption((option) =>
          option
            .setName("api_status_channel")
            .setDescription("Optional API status channel")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false)
        )
        .addStringOption((option) =>
          option
            .setName("conversation_id")
            .setDescription("Optional existing OpenAI conversation ID to reuse")
            .setRequired(false)
        );
    })
    .toJSON();

  const commands: Array<RESTPostAPIApplicationCommandsJSONBody> = [
    setup,
    kickCommand,
    clearCommand,
    prismaCommand,
    norm,
  ];
  if (isSoraEnabled()) {
    commands.push(sora);
  }

  await rest.put(Routes.applicationCommands(clientId), { body: commands });
}
