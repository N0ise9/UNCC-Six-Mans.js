import { Client, Message, TextChannel } from "discord.js";
import OpenAI from "openai";
import { GuildConfigReadResult, GuildConfigStore } from "../GuildConfigStore";
import { GuildRuntimeManager } from "../GuildRuntimeManager";
import { DiscordWorkScheduler } from "../DiscordWorkScheduler";
import { GuildContext, GuildInstanceConfig } from "../types";

function createConfig(guildId: string): GuildInstanceConfig {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    databaseUrl: `postgres:///${guildId}`,
    enabled: true,
    guildId,
    leaderboardChannelId: `${guildId}-leaderboard`,
    queueChannelId: `${guildId}-queue`,
    updatedAt: "2026-01-01T00:00:00.000Z",
    voiceChannelId: `${guildId}-voice`,
  };
}

function createContext(guildId: string): GuildContext {
  return {
    channels: {} as GuildContext["channels"],
    client: {} as Client,
    config: createConfig(guildId),
    configStore: {} as GuildConfigStore,
    guildId,
    leaderboardMessages: [],
    normProcessing: false,
    normQueue: [],
    openai: {} as OpenAI,
    prisma: {
      $disconnect: jest.fn(async () => undefined),
    } as unknown as GuildContext["prisma"],
    queueMessage: null,
    queueMutex: {} as GuildContext["queueMutex"],
    repositories: {} as GuildContext["repositories"],
    scheduler: new DiscordWorkScheduler(1, 0),
    surfaceRegistry: {} as GuildContext["surfaceRegistry"],
    voteState: {
      captainsRandomVotes: new Map(),
      twosEnabled: false,
      twosVotes: new Map(),
    },
  };
}

function createConfigResult(guildId: string): GuildConfigReadResult {
  return {
    config: createConfig(guildId),
    enabled: true,
    guildId,
  };
}

describe("GuildRuntimeManager", () => {
  it("continues initializing later guilds when an earlier guild context fails to load", async () => {
    const configs = [createConfigResult("guild-1"), createConfigResult("guild-2")];
    const configStore = {
      getGuildConfigResults: jest.fn(() => configs),
    } as unknown as GuildConfigStore;
    const manager = new GuildRuntimeManager(
      {} as Client,
      {} as OpenAI,
      configStore,
      new DiscordWorkScheduler(1, 0)
    );
    const loadedContext = createContext("guild-2");
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      jest
        .spyOn(manager as unknown as { createContext: (config: GuildInstanceConfig) => Promise<GuildContext> }, "createContext")
        .mockRejectedValueOnce(new Error("database unavailable"))
        .mockResolvedValueOnce(loadedContext);
      jest
        .spyOn(manager as unknown as { bootstrapContext: (context: GuildContext) => Promise<void> }, "bootstrapContext")
        .mockResolvedValue(undefined);

      await manager.initializeConfiguredGuilds();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(
        (manager as unknown as { contexts: Map<string, GuildContext> }).contexts.get("guild-1")
      ).toBeUndefined();
      expect(
        (manager as unknown as { contexts: Map<string, GuildContext> }).contexts.get("guild-2")
      ).toBe(loadedContext);
    } finally {
      errorSpy.mockRestore();
      await manager.dispose();
    }
  });

  it("skips a single unreadable stored guild config during startup without blocking later guilds", async () => {
    const configStore = {
      getGuildConfigResults: jest.fn(() => [
        {
          config: null,
          enabled: true,
          error: new Error("bad decrypt"),
          guildId: "guild-1",
        },
        createConfigResult("guild-2"),
      ]),
    } as unknown as GuildConfigStore;
    const manager = new GuildRuntimeManager(
      {} as Client,
      {} as OpenAI,
      configStore,
      new DiscordWorkScheduler(1, 0)
    );
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const loadedContext = createContext("guild-2");

    try {
      jest
        .spyOn(
          manager as unknown as { loadContext: (config: GuildInstanceConfig) => Promise<{ context: GuildContext | null }> },
          "loadContext"
        )
        .mockResolvedValue({
          context: loadedContext,
        } as { context: GuildContext | null });

      await manager.initializeConfiguredGuilds();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(
        (manager as unknown as { contexts: Map<string, GuildContext> }).contexts.get("guild-2")
      ).toBeUndefined();
      expect(
        (
          manager as unknown as {
            loadContext: jest.Mock;
          }
        ).loadContext
      ).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
      await manager.dispose();
    }
  });

  it("clears a stale stored queue message id when the message no longer exists", async () => {
    const configStore = {
      updateGuildRuntimeFields: jest.fn(),
    } as unknown as GuildConfigStore;
    const manager = new GuildRuntimeManager(
      {} as Client,
      {} as OpenAI,
      configStore,
      new DiscordWorkScheduler(1, 0)
    );
    const warningSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const queueChannel = {
      messages: {
        fetch: jest.fn(async () => {
          throw new Error("missing message");
        }),
      },
    } as unknown as TextChannel;

    try {
      const result = await (
        manager as unknown as {
          restoreQueueMessage: (config: GuildInstanceConfig, channel: TextChannel) => Promise<Message | null>;
        }
      ).restoreQueueMessage(
        {
          ...createConfig("guild-1"),
          queueMessageId: "queue-message-1",
        },
        queueChannel
      );

      expect(result).toBeNull();
      expect(configStore.updateGuildRuntimeFields).toHaveBeenCalledWith("guild-1", {
        queueMessageId: null,
      });
    } finally {
      warningSpy.mockRestore();
    }
  });

  it("persists only the surviving leaderboard message ids when some stored messages are stale", async () => {
    const configStore = {
      updateGuildRuntimeFields: jest.fn(),
    } as unknown as GuildConfigStore;
    const manager = new GuildRuntimeManager(
      {} as Client,
      {} as OpenAI,
      configStore,
      new DiscordWorkScheduler(1, 0)
    );
    const warningSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const keptMessage = { id: "leaderboard-message-1" } as Message;
    const leaderboardChannel = {
      messages: {
        fetch: jest.fn(async (messageId: string) => {
          if (messageId === "leaderboard-message-1") {
            return keptMessage;
          }

          throw new Error("missing message");
        }),
      },
    } as unknown as TextChannel;

    try {
      const result = await (
        manager as unknown as {
          restoreLeaderboardMessages: (config: GuildInstanceConfig, channel: TextChannel) => Promise<Message[]>;
        }
      ).restoreLeaderboardMessages(
        {
          ...createConfig("guild-1"),
          leaderboardMessageIds: ["leaderboard-message-1", "leaderboard-message-2"],
        },
        leaderboardChannel
      );

      expect(result).toEqual([keptMessage]);
      expect(configStore.updateGuildRuntimeFields).toHaveBeenCalledWith("guild-1", {
        leaderboardMessageIds: ["leaderboard-message-1"],
      });
    } finally {
      warningSpy.mockRestore();
    }
  });

  it("returns a config failure when reload cannot decrypt the stored guild config", async () => {
    const configStore = {
      getGuildConfigResult: jest.fn(() => ({
        config: null,
        enabled: true,
        error: new Error("decrypt failed"),
        guildId: "guild-1",
      })),
    } as unknown as GuildConfigStore;
    const manager = new GuildRuntimeManager(
      {} as Client,
      {} as OpenAI,
      configStore,
      new DiscordWorkScheduler(1, 0)
    );
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const result = await manager.reloadContext("guild-1");

      expect(result).toEqual({
        code: "config",
        message: "stored configuration could not be decrypted",
      });
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
      await manager.dispose();
    }
  });
});
