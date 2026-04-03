import { Client } from "discord.js";
import OpenAI from "openai";
import { registerAllSlashCommands } from "./controllers/CommandRegistry";
import { DiscordWorkScheduler } from "./runtime/DiscordWorkScheduler";
import { GuildConfigStore } from "./runtime/GuildConfigStore";
import { GuildRuntimeManager } from "./runtime/GuildRuntimeManager";
import { getEnvVariable } from "./utils";

const NormClient = new Client({
  intents: ["Guilds", "GuildMessages", "GuildVoiceStates", "MessageContent"],
});

const discordToken = getEnvVariable("token");
const openai = new OpenAI({ apiKey: getEnvVariable("openai") });
const scheduler = new DiscordWorkScheduler(2, 75);
const configStore = new GuildConfigStore();
const runtimeManager = new GuildRuntimeManager(NormClient, openai, configStore, scheduler);

NormClient.on("clientReady", async (client) => {
  console.info("NormJS single-instance runtime is starting.");

  if (!client.user) throw new Error("No client id");
  await registerAllSlashCommands(client.user.id, discordToken);
  await runtimeManager.initializeConfiguredGuilds();

  console.info(`NormJS is running with config store at ${configStore.getConfigPath()}.`);
});

NormClient.on("interactionCreate", async (interaction) => {
  if (!interaction.inCachedGuild()) {
    return;
  }

  if (interaction.isButton()) {
    await interaction.deferUpdate();
    const context = await runtimeManager.ensureContext(interaction.guildId);
    if (!context) return;
    await runtimeManager.handleButtonInteraction(context, interaction);
    return;
  }

  if (interaction.isStringSelectMenu()) {
    await interaction.deferUpdate();
    const context = await runtimeManager.ensureContext(interaction.guildId);
    if (!context) return;
    await runtimeManager.handleSelectMenuInteraction(context, interaction);
    return;
  }

  if (interaction.isChatInputCommand()) {
    await runtimeManager.handleSlashCommand(interaction);
  }
});

NormClient.on("messageCreate", async (message) => {
  await runtimeManager.handleMessage(message);
});

NormClient.on("error", (error) => {
  console.error("Discord client error:", error);
});

process.on("SIGINT", async () => {
  await runtimeManager.dispose();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await runtimeManager.dispose();
  process.exit(0);
});

NormClient.login(discordToken);
