import { Client } from "discord.js";
import OpenAI from "openai";
import { registerAllSlashCommands } from "./controllers/CommandRegistry";
import { assertSoraRuntimeSupport } from "./controllers/EasterEggs";
import { ApiStatusRuntime } from "./runtime/ApiStatusRuntime";
import { DiscordWorkScheduler } from "./runtime/DiscordWorkScheduler";
import { GuildConfigStore } from "./runtime/GuildConfigStore";
import { GuildRuntimeManager } from "./runtime/GuildRuntimeManager";
import { startGeneratedMediaPruner } from "./runtime/generatedMediaRetention";
import { loadRuntimeEnv } from "./runtime/runtimePaths";
import { getEnvVariable } from "./utils";

loadRuntimeEnv();

const NormClient = new Client({
  intents: ["Guilds"],
});

const discordToken = getEnvVariable("token");
const openai = new OpenAI({ apiKey: getEnvVariable("openai") });
assertSoraRuntimeSupport(openai);
const scheduler = new DiscordWorkScheduler(2, 75);
const apiStatusRuntime = new ApiStatusRuntime(scheduler);
const configStore = new GuildConfigStore();
const runtimeManager = new GuildRuntimeManager(NormClient, openai, configStore, scheduler, apiStatusRuntime);
const generatedMediaPruner = startGeneratedMediaPruner();
let shutdownInFlight: Promise<void> | null = null;

async function runSafely(label: string, handler: () => Promise<void>): Promise<void> {
  try {
    await handler();
  } catch (error) {
    console.error(`${label} failed:`, error);
  }
}

async function shutdown(code: number, reason: string, error?: unknown): Promise<void> {
  if (shutdownInFlight) {
    await shutdownInFlight;
    return;
  }

  shutdownInFlight = (async () => {
    if (error !== undefined) {
      console.error(`[Shutdown] ${reason}:`, error);
    } else {
      console.info(`[Shutdown] ${reason}.`);
    }

    clearInterval(generatedMediaPruner);

    try {
      await runtimeManager.dispose();
    } catch (disposeError) {
      console.error("[Shutdown] Failed to dispose guild runtime manager:", disposeError);
    }

    try {
      await apiStatusRuntime.dispose();
    } catch (disposeError) {
      console.error("[Shutdown] Failed to dispose API status runtime:", disposeError);
    }

    try {
      await NormClient.destroy();
    } catch (destroyError) {
      console.error("[Shutdown] Failed to destroy Discord client:", destroyError);
    }

    process.exit(code);
  })();

  await shutdownInFlight;
}

NormClient.on("clientReady", async (client) => {
  await runSafely("clientReady", async () => {
    console.info("NormJS single-instance runtime is starting.");

    if (!client.user) throw new Error("No client id");
    await registerAllSlashCommands(client.user.id, discordToken);
    await runtimeManager.initializeConfiguredGuilds();

    console.info(`NormJS is running with config store at ${configStore.getConfigPath()}.`);
  });
});

NormClient.on("interactionCreate", async (interaction) => {
  await runSafely("interactionCreate", async () => {
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
});

NormClient.on("error", (error) => {
  console.error("Discord client error:", error);
});

process.on("SIGINT", async () => {
  await shutdown(0, "Received SIGINT");
});

process.on("SIGTERM", async () => {
  await shutdown(0, "Received SIGTERM");
});

process.on("uncaughtException", (error) => {
  void shutdown(1, "Uncaught exception", error);
});

process.on("unhandledRejection", (reason) => {
  void shutdown(1, "Unhandled promise rejection", reason);
});

void NormClient.login(discordToken).catch((error) => {
  void shutdown(1, "Discord login failed", error);
});
