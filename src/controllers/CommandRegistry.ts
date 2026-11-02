import {
  ChannelType,
  REST,
  RESTPostAPIApplicationCommandsJSONBody,
  Routes,
  SlashCommandBuilder,
  SlashCommandSubcommandBuilder,
} from "discord.js";

function addMatchTierOptions(subcommand: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder {
  let builder = subcommand;
  for (let matchSize = 1; matchSize <= 12; matchSize += 1) {
    builder = builder.addBooleanOption((option) =>
      option
        .setName(`enable_${matchSize}v${matchSize}`)
        .setDescription(`Enable ${matchSize}v${matchSize} matches for this guild`)
        .setRequired(false)
    );
  }

  return builder;
}

function buildSlashCommands(): Array<RESTPostAPIApplicationCommandsJSONBody> {
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
    .addAttachmentOption((opt) => opt.setName("file1").setDescription("Optional image or file 1"))
    .addAttachmentOption((opt) => opt.setName("file2").setDescription("Optional image or file 2"))
    .addAttachmentOption((opt) => opt.setName("file3").setDescription("Optional image or file 3"))
    .toJSON();

  const setup = new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Configure this guild for the single-instance bot runtime.")
    // Discord permissions apply to the whole command; each subcommand is authorized at runtime.
    .setDefaultMemberPermissions(null)
    .addSubcommand((subcommand) => {
      return subcommand.setName("show").setDescription("Show the current guild configuration.");
    })
    .addSubcommand((subcommand) => {
      return subcommand.setName("disable").setDescription("Disable this guild configuration.");
    })
    .addSubcommand((subcommand) => {
      return addMatchTierOptions(
        subcommand
        .setName("set")
        .setDescription("Create or update the guild configuration.")
        .addChannelOption((option) =>
          option
            .setName("queue_channel")
            .setDescription("Queue channel")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false)
        )
        .addChannelOption((option) =>
          option
            .setName("leaderboard_channel")
            .setDescription("Leaderboard channel")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false)
        )
        .addChannelOption((option) =>
          option
            .setName("chat_channel")
            .setDescription("Chat channel where /norm may be used")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false)
        )
        .addStringOption((option) =>
          option.setName("database_url").setDescription("Per-guild database URL").setRequired(false)
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
        )
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
  return commands;
}

async function pruneGlobalSlashCommands(rest: REST, clientId: string): Promise<void> {
  await rest.put(Routes.applicationCommands(clientId), {
    body: [],
  });
}

export async function registerGuildSlashCommands(clientId: string, token: string, guildId: string): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(token);
  const commands = buildSlashCommands();
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
    body: commands,
  });
}

export async function registerAllSlashCommands(clientId: string, token: string, guildIds: string[] = []) {
  const rest = new REST({ version: "10" }).setToken(token);
  const commands = buildSlashCommands();

  const uniqueGuildIds = [...new Set(guildIds)];
  await pruneGlobalSlashCommands(rest, clientId);

  for (const guildId of uniqueGuildIds) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
      body: commands,
    });
  }

  const commandNames = commands.map((command) => command.name).join(", ");
  console.info(`[SlashCommands] Registered guild commands: ${commandNames}`);

  if (uniqueGuildIds.length > 0) {
    const guildWord = uniqueGuildIds.length === 1 ? "guild" : "guilds";
    console.info(
      `[SlashCommands] Registered guild commands for ${uniqueGuildIds.length} ${guildWord}.`
    );
  }
}
