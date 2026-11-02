import { Client } from "discord.js";
import { registerAllSlashCommands } from "../controllers/CommandRegistry";
import { GuildConfigStore } from "./GuildConfigStore";
import { GuildRuntimeManager } from "./GuildRuntimeManager";

type RegisterAllSlashCommands = typeof registerAllSlashCommands;

export async function runClientReadyStartup({
  configStore,
  discordToken,
  readyClient,
  registerSlashCommands = registerAllSlashCommands,
  runtimeManager,
}: {
  configStore: GuildConfigStore;
  discordToken: string;
  readyClient: Client;
  registerSlashCommands?: RegisterAllSlashCommands;
  runtimeManager: GuildRuntimeManager | null;
}): Promise<void> {
  console.info("NormJS single-instance runtime is starting.");

  if (!readyClient.user) throw new Error("No client id");

  await runtimeManager?.prepareStartupQueueSurfaces();
  const guilds = await readyClient.guilds.fetch();
  await registerSlashCommands(
    readyClient.user.id,
    discordToken,
    guilds.map((guild) => guild.id)
  );
  await runtimeManager?.initializeConfiguredGuilds();

  console.info(`NormJS is running with config store at ${configStore.getConfigPath()}.`);
}
