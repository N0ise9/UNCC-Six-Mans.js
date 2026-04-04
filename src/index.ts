import { Client } from "discord.js";
import OpenAI from "openai";
import { registerAllSlashCommands } from "./controllers/CommandRegistry";
import { assertSoraRuntimeSupport } from "./controllers/EasterEggs";
import { ApiStatusRuntime } from "./runtime/ApiStatusRuntime";
import { DiscordWorkScheduler } from "./runtime/DiscordWorkScheduler";
import { GuildConfigStore } from "./runtime/GuildConfigStore";
import { GuildRuntimeManager } from "./runtime/GuildRuntimeManager";
import { startGeneratedMediaPruner } from "./runtime/generatedMediaRetention";
import { ensurePrismaStudioAssetsExtracted } from "./runtime/PrismaStudioAssets";
import { loadRuntimeEnv } from "./runtime/runtimePaths";
import { getEnvVariable } from "./utils";

loadRuntimeEnv();

const scheduler = new DiscordWorkScheduler(2, 75);
const apiStatusRuntime = new ApiStatusRuntime(scheduler);
const configStore = new GuildConfigStore();
let generatedMediaPruner: NodeJS.Timeout | null = null;
let normClient: Client | null = null;
let runtimeManager: GuildRuntimeManager | null = null;
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

    if (generatedMediaPruner) {
      clearInterval(generatedMediaPruner);
      generatedMediaPruner = null;
    }

    try {
      await runtimeManager?.dispose();
    } catch (disposeError) {
      console.error("[Shutdown] Failed to dispose guild runtime manager:", disposeError);
    }

    try {
      await apiStatusRuntime.dispose();
    } catch (disposeError) {
      console.error("[Shutdown] Failed to dispose API status runtime:", disposeError);
    }

    try {
      await normClient?.destroy();
    } catch (destroyError) {
      console.error("[Shutdown] Failed to destroy Discord client:", destroyError);
    }

    process.exit(code);
  })();

  await shutdownInFlight;
}

async function maybeRunCliMode(args: string[]): Promise<boolean> {
  if (!args.includes("--extract-internal-assets")) {
    return false;
  }

  const extractedRoot = ensurePrismaStudioAssetsExtracted();
  console.info(`Extracted internal Prisma Studio assets to ${extractedRoot}.`);
  return true;
}

function registerProcessLifecycleHandlers(): void {
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
}

function registerDiscordHandlers(client: Client, discordToken: string): void {
  client.on("clientReady", async (readyClient) => {
    await runSafely("clientReady", async () => {
      console.info("NormJS single-instance runtime is starting.");

      if (!readyClient.user) throw new Error("No client id");
      await registerAllSlashCommands(readyClient.user.id, discordToken);
      await runtimeManager?.initializeConfiguredGuilds();

      console.info(`NormJS is running with config store at ${configStore.getConfigPath()}.`);
    });
  });

  client.on("interactionCreate", async (interaction) => {
    await runSafely("interactionCreate", async () => {
      if (!interaction.inCachedGuild() || !runtimeManager) {
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

  client.on("error", (error) => {
    console.error("Discord client error:", error);
  });
}

async function startBot(): Promise<void> {
  const discordToken = getEnvVariable("token");
  const openai = new OpenAI({ apiKey: getEnvVariable("openai") });
  assertSoraRuntimeSupport(openai);

  normClient = new Client({
    intents: ["Guilds"],
  });
  runtimeManager = new GuildRuntimeManager(normClient, openai, configStore, scheduler, apiStatusRuntime);
  generatedMediaPruner = startGeneratedMediaPruner();

  registerProcessLifecycleHandlers();
  registerDiscordHandlers(normClient, discordToken);

  await normClient.login(discordToken).catch((error) => {
    return shutdown(1, "Discord login failed", error);
  });
}

async function main(): Promise<void> {
  if (await maybeRunCliMode(process.argv.slice(2))) {
    return;
  }

  await startBot();
}

void main().catch((error) => {
  console.error("NormJS failed to start:", error);
  process.exit(1);
});
