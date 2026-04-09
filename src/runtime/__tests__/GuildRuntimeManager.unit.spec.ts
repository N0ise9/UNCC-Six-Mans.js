import { ChannelType, Client, Message, MessageFlags, TextChannel } from "discord.js";
import { DateTime } from "luxon";
import OpenAI from "openai";
import * as EasterEggsController from "../../controllers/EasterEggs";
import { GuildConfigReadResult, GuildConfigStore } from "../GuildConfigStore";
import { PrismaStudioAccessGate } from "../PrismaStudioAccessGate";
import { GuildRuntimeManager, logInteractionAudit } from "../GuildRuntimeManager";
import { DiscordWorkScheduler } from "../DiscordWorkScheduler";
import { PrismaStudioManager } from "../PrismaStudioManager";
import { GuildContext, GuildInstanceConfig } from "../types";

function createConfig(guildId: string): GuildInstanceConfig {
  return {
    chatChannelId: `${guildId}-chat`,
    createdAt: "2026-01-01T00:00:00.000Z",
    databaseUrl: `postgres:///${guildId}`,
    enabled: true,
    guildId,
    leaderboardChannelId: `${guildId}-leaderboard`,
    queueChannelId: `${guildId}-queue`,
    soraEnabled: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function createContext(guildId: string): GuildContext {
  return {
    channels: {} as GuildContext["channels"],
    client: {} as Client,
    config: createConfig(guildId),
    configStore: {} as GuildConfigStore,
    guildId,
    guildName: `Guild ${guildId}`,
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

function createTextChannel(id: string): TextChannel {
  return {
    guild: {
      name: "Guild guild-1",
    },
    id,
    type: ChannelType.GuildText,
  } as unknown as TextChannel;
}

function createSetupInteraction(options?: {
  booleans?: Partial<Record<"sora_enabled", boolean>>;
  channels?: Partial<Record<"api_status_channel" | "chat_channel" | "leaderboard_channel" | "queue_channel", TextChannel>>;
  guildId?: string;
  hasManageGuild?: boolean;
  strings?: Partial<Record<"conversation_id" | "database_url", string>>;
  subcommand?: "disable" | "set" | "show";
}) {
  const booleans = options?.booleans ?? {};
  const channels = options?.channels ?? {};
  const strings = options?.strings ?? {};

  return {
    editReply: jest.fn(async () => undefined),
    guildId: options?.guildId ?? "guild-1",
    id: `setup-${options?.subcommand ?? "set"}`,
    memberPermissions: {
      has: jest.fn(() => options?.hasManageGuild ?? true),
    },
    options: {
      getBoolean: jest.fn((name: string) => booleans[name as keyof typeof booleans] ?? null),
      getChannel: jest.fn((name: string) => channels[name as keyof typeof channels] ?? null),
      getString: jest.fn((name: string) => strings[name as keyof typeof strings] ?? null),
      getSubcommand: jest.fn(() => options?.subcommand ?? "set"),
    },
  } as unknown as Parameters<GuildRuntimeManager["handleSetupCommand"]>[0];
}

describe("GuildRuntimeManager", () => {
  it("formats interaction audit logs with the guild name when one is available", () => {
    const infoSpy = jest.spyOn(console, "info").mockImplementation(() => undefined);

    try {
      logInteractionAudit({
        action: "Join Queue",
        guildId: "guild-1",
        guildName: "Norm Central",
        reason: "joined the queue",
        status: "processed",
        username: "Destroyer",
      });

      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining("[Norm Central (guild-1)]")
      );
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("falls back to the guild id in interaction audit logs when the guild name is unavailable", () => {
    const infoSpy = jest.spyOn(console, "info").mockImplementation(() => undefined);

    try {
      logInteractionAudit({
        action: "Join Queue",
        guildId: "guild-1",
        reason: "joined the queue",
        status: "processed",
        username: "Destroyer",
      });

      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("[guild-1]"));
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("continues initializing later guilds when an earlier guild context fails to load", async () => {
    const configs = [createConfigResult("guild-1"), createConfigResult("guild-2")];
    const configStore = {
      getGuildConfigResults: jest.fn(() => configs),
    } as unknown as GuildConfigStore;
    const manager = new GuildRuntimeManager({} as Client, {} as OpenAI, configStore, new DiscordWorkScheduler(1, 0));
    const loadedContext = createContext("guild-2");
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      jest
        .spyOn(
          manager as unknown as { createContext: (config: GuildInstanceConfig) => Promise<GuildContext> },
          "createContext"
        )
        .mockRejectedValueOnce(new Error("database unavailable"))
        .mockResolvedValueOnce(loadedContext);
      jest
        .spyOn(manager as unknown as { bootstrapContext: (context: GuildContext) => Promise<void> }, "bootstrapContext")
        .mockResolvedValue(undefined);

      await manager.initializeConfiguredGuilds();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect((manager as unknown as { contexts: Map<string, GuildContext> }).contexts.get("guild-1")).toBeUndefined();
      expect((manager as unknown as { contexts: Map<string, GuildContext> }).contexts.get("guild-2")).toBe(
        loadedContext
      );
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
    const manager = new GuildRuntimeManager({} as Client, {} as OpenAI, configStore, new DiscordWorkScheduler(1, 0));
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const loadedContext = createContext("guild-2");

    try {
      jest
        .spyOn(
          manager as unknown as {
            loadContext: (config: GuildInstanceConfig) => Promise<{ context: GuildContext | null }>;
          },
          "loadContext"
        )
        .mockResolvedValue({
          context: loadedContext,
        } as { context: GuildContext | null });

      await manager.initializeConfiguredGuilds();

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect((manager as unknown as { contexts: Map<string, GuildContext> }).contexts.get("guild-2")).toBeUndefined();
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
    const manager = new GuildRuntimeManager({} as Client, {} as OpenAI, configStore, new DiscordWorkScheduler(1, 0));
    const warningSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const queueChannel = {
      guild: {
        name: "Guild guild-1",
      },
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
    const manager = new GuildRuntimeManager({} as Client, {} as OpenAI, configStore, new DiscordWorkScheduler(1, 0));
    const warningSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const keptMessage = { id: "leaderboard-message-1" } as Message;
    const leaderboardChannel = {
      guild: {
        name: "Guild guild-1",
      },
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
    const manager = new GuildRuntimeManager({} as Client, {} as OpenAI, configStore, new DiscordWorkScheduler(1, 0));
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

  it("creates a default event during bootstrap when the guild database has none", async () => {
    const manager = new GuildRuntimeManager(
      {} as Client,
      {} as OpenAI,
      {} as GuildConfigStore,
      new DiscordWorkScheduler(1, 0)
    );
    const context = createContext("guild-1");
    const ensureCurrentEvent = jest.fn(async () => ({
      created: true,
      event: {
        endDate: null,
        id: 1,
        mmrMult: 1,
        name: "Default Event 123",
        startDate: new Date("2026-01-01T00:00:00.000Z"),
      },
    }));
    context.repositories = {
      event: {
        ensureCurrentEvent,
      },
    } as unknown as GuildContext["repositories"];

    const refreshLeaderboardSpy = jest
      .spyOn(
        manager as unknown as { refreshLeaderboard: (guildContext: GuildContext) => Promise<void> },
        "refreshLeaderboard"
      )
      .mockResolvedValue(undefined);
    const refreshQueueSurfaceSpy = jest
      .spyOn(
        manager as unknown as {
          refreshQueueSurface: (guildContext: GuildContext, players?: unknown) => Promise<void>;
        },
        "refreshQueueSurface"
      )
      .mockResolvedValue(undefined);
    const startQueueTimerSpy = jest
      .spyOn(manager as unknown as { startQueueTimer: (guildContext: GuildContext) => void }, "startQueueTimer")
      .mockImplementation(() => undefined);
    const infoSpy = jest.spyOn(console, "info").mockImplementation(() => undefined);

    try {
      await (
        manager as unknown as {
          bootstrapContext: (guildContext: GuildContext) => Promise<void>;
        }
      ).bootstrapContext(context);

      expect(ensureCurrentEvent).toHaveBeenCalledTimes(1);
      expect(refreshLeaderboardSpy).toHaveBeenCalledWith(context);
      expect(refreshQueueSurfaceSpy).toHaveBeenCalledWith(context);
      expect(startQueueTimerSpy).toHaveBeenCalledWith(context);
      expect(infoSpy).toHaveBeenCalledWith(
        '[Guild guild-1 (guild-1)] No active event was found in the guild database. Created default event "Default Event 123".'
      );
    } finally {
      refreshLeaderboardSpy.mockRestore();
      refreshQueueSurfaceSpy.mockRestore();
      startQueueTimerSpy.mockRestore();
      infoSpy.mockRestore();
      await manager.dispose();
    }
  });

  it("refreshes the queue surface on the minute even when no players expire", async () => {
    const manager = new GuildRuntimeManager(
      {} as Client,
      {} as OpenAI,
      {} as GuildConfigStore,
      new DiscordWorkScheduler(1, 0)
    );
    const context = createContext("guild-1");
    const queuedPlayers = [
      {
        id: "player-1",
        isCap: false,
        mmr: 100,
        name: "Player One",
        queueTime: DateTime.now().plus({ minutes: 30 }),
        team: null,
      },
    ];
    const release = jest.fn();
    context.queueMutex = {
      acquire: jest.fn(async () => release),
    } as unknown as GuildContext["queueMutex"];
    context.repositories = {
      queue: {
        getAllBallChasersInQueue: jest.fn(async () => queuedPlayers),
        removeBallChaserFromQueue: jest.fn(async () => undefined),
      },
    } as unknown as GuildContext["repositories"];

    const refreshQueueSurfaceSpy = jest
      .spyOn(
        manager as unknown as {
          refreshQueueSurface: (guildContext: GuildContext, players?: typeof queuedPlayers) => Promise<void>;
        },
        "refreshQueueSurface"
      )
      .mockResolvedValue(undefined);

    try {
      await (
        manager as unknown as {
          runQueueTimer: (guildContext: GuildContext) => Promise<void>;
        }
      ).runQueueTimer(context);

      expect(refreshQueueSurfaceSpy).toHaveBeenCalledWith(context, queuedPlayers);
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      refreshQueueSurfaceSpy.mockRestore();
      await manager.dispose();
    }
  });

  it("allows first-time /setup set when all required fields are provided", async () => {
    const configStore = {
      getGuildConfigResult: jest.fn(() => null),
      setGuildConfig: jest.fn(() => createConfig("guild-1")),
    } as unknown as GuildConfigStore;
    const manager = new GuildRuntimeManager({} as Client, {} as OpenAI, configStore, new DiscordWorkScheduler(1, 0));
    const interaction = createSetupInteraction({
      channels: {
        chat_channel: createTextChannel("guild-1-chat-new"),
        leaderboard_channel: createTextChannel("guild-1-leaderboard-new"),
        queue_channel: createTextChannel("guild-1-queue-new"),
      },
      strings: {
        database_url: "postgres:///guild-1-new",
      },
    });
    const reloadSpy = jest.spyOn(manager, "reloadContext").mockResolvedValue(null);

    try {
      await manager.handleSetupCommand(interaction);

      expect(configStore.getGuildConfigResult).toHaveBeenCalledWith("guild-1");
      expect(configStore.setGuildConfig).toHaveBeenCalledWith({
        apiStatusChannelId: undefined,
        chatChannelId: "guild-1-chat-new",
        databaseUrl: "postgres:///guild-1-new",
        guildId: "guild-1",
        leaderboardChannelId: "guild-1-leaderboard-new",
        openAiConversationId: undefined,
        queueChannelId: "guild-1-queue-new",
        soraEnabled: false,
      });
      expect(reloadSpy).toHaveBeenCalledWith("guild-1");
      expect(interaction.editReply).toHaveBeenCalledWith("Guild configuration saved and runtime refreshed.");
    } finally {
      reloadSpy.mockRestore();
      await manager.dispose();
    }
  });

  it("allows first-time /setup set without a chat channel", async () => {
    const configStore = {
      getGuildConfigResult: jest.fn(() => null),
      setGuildConfig: jest.fn(() => createConfig("guild-1")),
    } as unknown as GuildConfigStore;
    const manager = new GuildRuntimeManager({} as Client, {} as OpenAI, configStore, new DiscordWorkScheduler(1, 0));
    const interaction = createSetupInteraction({
      channels: {
        leaderboard_channel: createTextChannel("guild-1-leaderboard-new"),
        queue_channel: createTextChannel("guild-1-queue-new"),
      },
      strings: {
        database_url: "postgres:///guild-1-new",
      },
    });
    const reloadSpy = jest.spyOn(manager, "reloadContext").mockResolvedValue(null);

    try {
      await manager.handleSetupCommand(interaction);

      expect(configStore.setGuildConfig).toHaveBeenCalledWith({
        apiStatusChannelId: undefined,
        chatChannelId: undefined,
        databaseUrl: "postgres:///guild-1-new",
        guildId: "guild-1",
        leaderboardChannelId: "guild-1-leaderboard-new",
        openAiConversationId: undefined,
        queueChannelId: "guild-1-queue-new",
        soraEnabled: false,
      });
      expect(interaction.editReply).toHaveBeenCalledWith("Guild configuration saved and runtime refreshed.");
    } finally {
      reloadSpy.mockRestore();
      await manager.dispose();
    }
  });

  it("requires the missing core fields on first-time /setup set", async () => {
    const configStore = {
      getGuildConfigResult: jest.fn(() => null),
      setGuildConfig: jest.fn(),
    } as unknown as GuildConfigStore;
    const manager = new GuildRuntimeManager({} as Client, {} as OpenAI, configStore, new DiscordWorkScheduler(1, 0));
    const interaction = createSetupInteraction({
      channels: {
        leaderboard_channel: createTextChannel("guild-1-leaderboard-new"),
      },
    });
    const reloadSpy = jest.spyOn(manager, "reloadContext").mockResolvedValue(null);

    try {
      await manager.handleSetupCommand(interaction);

      expect(configStore.setGuildConfig).not.toHaveBeenCalled();
      expect(reloadSpy).not.toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith(
        "This guild is not configured yet. Provide these required options: queue_channel, database_url."
      );
    } finally {
      reloadSpy.mockRestore();
      await manager.dispose();
    }
  });

  it("updates only the leaderboard channel when /setup set omits the other stored fields", async () => {
    const existingConfig = {
      ...createConfig("guild-1"),
      apiStatusChannelId: "guild-1-status-old",
      openAiConversationId: "conversation-1",
    };
    const configStore = {
      getGuildConfigResult: jest.fn(() => ({
        config: existingConfig,
        enabled: true,
        guildId: "guild-1",
      })),
      setGuildConfig: jest.fn(() => existingConfig),
    } as unknown as GuildConfigStore;
    const manager = new GuildRuntimeManager({} as Client, {} as OpenAI, configStore, new DiscordWorkScheduler(1, 0));
    const interaction = createSetupInteraction({
      channels: {
        leaderboard_channel: createTextChannel("guild-1-leaderboard-new"),
      },
    });
    const reloadSpy = jest.spyOn(manager, "reloadContext").mockResolvedValue(null);

    try {
      await manager.handleSetupCommand(interaction);

      expect(configStore.setGuildConfig).toHaveBeenCalledWith({
        apiStatusChannelId: "guild-1-status-old",
        chatChannelId: "guild-1-chat",
        databaseUrl: "postgres:///guild-1",
        guildId: "guild-1",
        leaderboardChannelId: "guild-1-leaderboard-new",
        openAiConversationId: "conversation-1",
        queueChannelId: "guild-1-queue",
        soraEnabled: false,
      });
      expect(interaction.editReply).toHaveBeenCalledWith("Guild configuration saved and runtime refreshed.");
    } finally {
      reloadSpy.mockRestore();
      await manager.dispose();
    }
  });

  it("updates only the database URL when /setup set omits the other stored fields", async () => {
    const existingConfig = {
      ...createConfig("guild-1"),
      apiStatusChannelId: "guild-1-status-old",
      openAiConversationId: "conversation-1",
    };
    const configStore = {
      getGuildConfigResult: jest.fn(() => ({
        config: existingConfig,
        enabled: true,
        guildId: "guild-1",
      })),
      setGuildConfig: jest.fn(() => existingConfig),
    } as unknown as GuildConfigStore;
    const manager = new GuildRuntimeManager({} as Client, {} as OpenAI, configStore, new DiscordWorkScheduler(1, 0));
    const interaction = createSetupInteraction({
      strings: {
        database_url: "postgres:///guild-1-replacement",
      },
    });
    const reloadSpy = jest.spyOn(manager, "reloadContext").mockResolvedValue(null);

    try {
      await manager.handleSetupCommand(interaction);

      expect(configStore.setGuildConfig).toHaveBeenCalledWith({
        apiStatusChannelId: "guild-1-status-old",
        chatChannelId: "guild-1-chat",
        databaseUrl: "postgres:///guild-1-replacement",
        guildId: "guild-1",
        leaderboardChannelId: "guild-1-leaderboard",
        openAiConversationId: "conversation-1",
        queueChannelId: "guild-1-queue",
        soraEnabled: false,
      });
    } finally {
      reloadSpy.mockRestore();
      await manager.dispose();
    }
  });

  it("updates only the API status channel when /setup set omits the other stored fields", async () => {
    const existingConfig = {
      ...createConfig("guild-1"),
      apiStatusChannelId: "guild-1-status-old",
    };
    const configStore = {
      getGuildConfigResult: jest.fn(() => ({
        config: existingConfig,
        enabled: true,
        guildId: "guild-1",
      })),
      setGuildConfig: jest.fn(() => existingConfig),
    } as unknown as GuildConfigStore;
    const manager = new GuildRuntimeManager({} as Client, {} as OpenAI, configStore, new DiscordWorkScheduler(1, 0));
    const interaction = createSetupInteraction({
      channels: {
        api_status_channel: createTextChannel("guild-1-status-new"),
      },
    });
    const reloadSpy = jest.spyOn(manager, "reloadContext").mockResolvedValue(null);

    try {
      await manager.handleSetupCommand(interaction);

      expect(configStore.setGuildConfig).toHaveBeenCalledWith({
        apiStatusChannelId: "guild-1-status-new",
        chatChannelId: "guild-1-chat",
        databaseUrl: "postgres:///guild-1",
        guildId: "guild-1",
        leaderboardChannelId: "guild-1-leaderboard",
        openAiConversationId: undefined,
        queueChannelId: "guild-1-queue",
        soraEnabled: false,
      });
    } finally {
      reloadSpy.mockRestore();
      await manager.dispose();
    }
  });

  it("updates only the Sora toggle when /setup set omits the other stored fields", async () => {
    const existingConfig = {
      ...createConfig("guild-1"),
      soraEnabled: false,
    };
    const configStore = {
      getGuildConfigResult: jest.fn(() => ({
        config: existingConfig,
        enabled: true,
        guildId: "guild-1",
      })),
      setGuildConfig: jest.fn(() => ({
        ...existingConfig,
        soraEnabled: true,
      })),
    } as unknown as GuildConfigStore;
    const manager = new GuildRuntimeManager({} as Client, {} as OpenAI, configStore, new DiscordWorkScheduler(1, 0));
    const interaction = createSetupInteraction({
      booleans: {
        sora_enabled: true,
      },
    });
    const reloadSpy = jest.spyOn(manager, "reloadContext").mockResolvedValue(null);

    try {
      await manager.handleSetupCommand(interaction);

      expect(configStore.setGuildConfig).toHaveBeenCalledWith({
        apiStatusChannelId: undefined,
        chatChannelId: "guild-1-chat",
        databaseUrl: "postgres:///guild-1",
        guildId: "guild-1",
        leaderboardChannelId: "guild-1-leaderboard",
        openAiConversationId: undefined,
        queueChannelId: "guild-1-queue",
        soraEnabled: true,
      });
    } finally {
      reloadSpy.mockRestore();
      await manager.dispose();
    }
  });

  it("preserves the stored conversation id when /setup set omits conversation_id", async () => {
    const existingConfig = {
      ...createConfig("guild-1"),
      openAiConversationId: "conversation-keep",
    };
    const configStore = {
      getGuildConfigResult: jest.fn(() => ({
        config: existingConfig,
        enabled: true,
        guildId: "guild-1",
      })),
      setGuildConfig: jest.fn(() => existingConfig),
    } as unknown as GuildConfigStore;
    const manager = new GuildRuntimeManager({} as Client, {} as OpenAI, configStore, new DiscordWorkScheduler(1, 0));
    const interaction = createSetupInteraction({
      channels: {
        queue_channel: createTextChannel("guild-1-queue-new"),
      },
    });
    const reloadSpy = jest.spyOn(manager, "reloadContext").mockResolvedValue(null);

    try {
      await manager.handleSetupCommand(interaction);

      expect(configStore.setGuildConfig).toHaveBeenCalledWith({
        apiStatusChannelId: undefined,
        chatChannelId: "guild-1-chat",
        databaseUrl: "postgres:///guild-1",
        guildId: "guild-1",
        leaderboardChannelId: "guild-1-leaderboard",
        openAiConversationId: "conversation-keep",
        queueChannelId: "guild-1-queue-new",
        soraEnabled: false,
      });
    } finally {
      reloadSpy.mockRestore();
      await manager.dispose();
    }
  });

  it("preserves the stored Sora toggle when /setup set omits sora_enabled", async () => {
    const existingConfig = {
      ...createConfig("guild-1"),
      soraEnabled: true,
    };
    const configStore = {
      getGuildConfigResult: jest.fn(() => ({
        config: existingConfig,
        enabled: true,
        guildId: "guild-1",
      })),
      setGuildConfig: jest.fn(() => existingConfig),
    } as unknown as GuildConfigStore;
    const manager = new GuildRuntimeManager({} as Client, {} as OpenAI, configStore, new DiscordWorkScheduler(1, 0));
    const interaction = createSetupInteraction({
      channels: {
        queue_channel: createTextChannel("guild-1-queue-new"),
      },
    });
    const reloadSpy = jest.spyOn(manager, "reloadContext").mockResolvedValue(null);

    try {
      await manager.handleSetupCommand(interaction);

      expect(configStore.setGuildConfig).toHaveBeenCalledWith({
        apiStatusChannelId: undefined,
        chatChannelId: "guild-1-chat",
        databaseUrl: "postgres:///guild-1",
        guildId: "guild-1",
        leaderboardChannelId: "guild-1-leaderboard",
        openAiConversationId: undefined,
        queueChannelId: "guild-1-queue-new",
        soraEnabled: true,
      });
    } finally {
      reloadSpy.mockRestore();
      await manager.dispose();
    }
  });

  it("returns an actionable error when stored setup data cannot be decrypted for a partial update", async () => {
    const configStore = {
      getGuildConfigResult: jest.fn(() => ({
        config: null,
        enabled: true,
        error: new Error("decrypt failed"),
        guildId: "guild-1",
      })),
      setGuildConfig: jest.fn(),
    } as unknown as GuildConfigStore;
    const manager = new GuildRuntimeManager({} as Client, {} as OpenAI, configStore, new DiscordWorkScheduler(1, 0));
    const interaction = createSetupInteraction({
      channels: {
        leaderboard_channel: createTextChannel("guild-1-leaderboard-new"),
      },
    });
    const reloadSpy = jest.spyOn(manager, "reloadContext").mockResolvedValue(null);

    try {
      await manager.handleSetupCommand(interaction);

      expect(configStore.setGuildConfig).not.toHaveBeenCalled();
      expect(reloadSpy).not.toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith(
        "This guild already has stored setup data, but I couldn't read it. Check CONFIG_ENCRYPTION_KEY and rerun /setup set with queue_channel, leaderboard_channel, and database_url."
      );
    } finally {
      reloadSpy.mockRestore();
      await manager.dispose();
    }
  });

  it("shows the current guild Sora status in /setup show", async () => {
    const configStore = {
      getGuildConfigResult: jest.fn(() => ({
        config: {
          ...createConfig("guild-1"),
          apiStatusChannelId: "guild-1-status",
          openAiConversationId: "conversation-1",
          queueMessageId: "queue-message-1",
          soraEnabled: true,
        },
        enabled: true,
        guildId: "guild-1",
      })),
    } as unknown as GuildConfigStore;
    const manager = new GuildRuntimeManager({} as Client, {} as OpenAI, configStore, new DiscordWorkScheduler(1, 0));
    const interaction = createSetupInteraction({
      subcommand: "show",
    });

    try {
      await manager.handleSetupCommand(interaction);

      expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining("Sora: enabled"));
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.stringContaining("Chat channel: guild-1-chat")
      );
    } finally {
      await manager.dispose();
    }
  });

  it("rejects /norm outside the configured chat channel", async () => {
    const manager = new GuildRuntimeManager(
      {} as Client,
      {} as OpenAI,
      {} as GuildConfigStore,
      new DiscordWorkScheduler(1, 0)
    );
    const context = createContext("guild-1");
    const interaction = {
      channelId: "wrong-channel",
      commandName: "norm",
      guildId: "guild-1",
      reply: jest.fn(async () => undefined),
      user: {
        username: "Destroyer",
      },
    } as unknown as Parameters<GuildRuntimeManager["handleSlashCommand"]>[0];
    const infoSpy = jest.spyOn(console, "info").mockImplementation(() => undefined);

    try {
      jest.spyOn(manager, "ensureContext").mockResolvedValue(context);

      await manager.handleSlashCommand(interaction);

      expect(interaction.reply).toHaveBeenCalledWith({
        content: "Use this command in <#guild-1-chat>.",
        flags: MessageFlags.Ephemeral,
      });
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("Destroyer | /norm | IGNORED | wrong channel"));
    } finally {
      infoSpy.mockRestore();
    }
  });

  it("rejects /sora when the guild has not enabled Sora yet", async () => {
    const manager = new GuildRuntimeManager(
      {} as Client,
      {} as OpenAI,
      {} as GuildConfigStore,
      new DiscordWorkScheduler(1, 0)
    );
    const context = createContext("guild-1");
    const interaction = {
      channelId: "guild-1-chat",
      commandName: "sora",
      guildId: "guild-1",
      reply: jest.fn(async () => undefined),
    } as unknown as Parameters<GuildRuntimeManager["handleSlashCommand"]>[0];

    jest.spyOn(manager, "ensureContext").mockResolvedValue(context);

    await manager.handleSlashCommand(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "Sora is disabled for this server. A server admin can enable it with /setup set.",
      flags: MessageFlags.Ephemeral,
    });
  });

  it("rejects /sora when the guild has not configured an OpenAI chat channel yet", async () => {
    const manager = new GuildRuntimeManager(
      {} as Client,
      {} as OpenAI,
      {} as GuildConfigStore,
      new DiscordWorkScheduler(1, 0)
    );
    const context = createContext("guild-1");
    context.config.chatChannelId = undefined;
    context.config.soraEnabled = true;
    const interaction = {
      channelId: "guild-1-chat",
      commandName: "sora",
      guildId: "guild-1",
      reply: jest.fn(async () => undefined),
    } as unknown as Parameters<GuildRuntimeManager["handleSlashCommand"]>[0];

    jest.spyOn(manager, "ensureContext").mockResolvedValue(context);

    await manager.handleSlashCommand(interaction);

    expect(interaction.reply).toHaveBeenCalledWith({
      content: "This guild is missing its OpenAI chat channel. A server admin needs to rerun /setup set.",
      flags: MessageFlags.Ephemeral,
    });
  });

  it("allows /norm in the configured chat channel", async () => {
    const manager = new GuildRuntimeManager(
      {} as Client,
      {} as OpenAI,
      {} as GuildConfigStore,
      new DiscordWorkScheduler(1, 0)
    );
    const context = createContext("guild-1");
    const interaction = {
      channelId: "guild-1-chat",
      commandName: "norm",
      deferReply: jest.fn(async () => undefined),
      guildId: "guild-1",
      user: {
        username: "Destroyer",
      },
    } as unknown as Parameters<GuildRuntimeManager["handleSlashCommand"]>[0];
    const handlerSpy = jest.spyOn(EasterEggsController, "handleEasterEggSlashInteraction").mockResolvedValue(undefined);
    const infoSpy = jest.spyOn(console, "info").mockImplementation(() => undefined);

    try {
      jest.spyOn(manager, "ensureContext").mockResolvedValue(context);

      await manager.handleSlashCommand(interaction);

      expect(interaction.deferReply).toHaveBeenCalledTimes(1);
      expect(handlerSpy).toHaveBeenCalledWith(context, interaction);
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("Destroyer | /norm | PROCESSED | OpenAI"));
    } finally {
      infoSpy.mockRestore();
      handlerSpy.mockRestore();
    }
  });

  it("rejects /prisma for users who are not Bot Admins", async () => {
    const prismaStudioManager = {
      launchForGuild: jest.fn(async () => undefined),
    } as unknown as PrismaStudioManager;
    const manager = new GuildRuntimeManager(
      {} as Client,
      {} as OpenAI,
      {} as GuildConfigStore,
      new DiscordWorkScheduler(1, 0),
      undefined,
      prismaStudioManager
    );
    const interaction = {
      editReply: jest.fn(async () => undefined),
      guildId: "guild-1",
      id: "interaction-1",
      options: {
        getString: jest.fn(() => "secret"),
      },
      member: {
        roles: {
          cache: [],
        },
      },
    } as unknown as Parameters<GuildRuntimeManager["handlePrismaCommand"]>[0];

    await manager.handlePrismaCommand(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(
      "What do you think you're doing? Trying to run an admin command when you're not a Bot Admin. Typical."
    );
    expect(prismaStudioManager.launchForGuild as jest.Mock).not.toHaveBeenCalled();
  });

  it("launches Prisma Studio for the configured guild database without leaking the URL in Discord", async () => {
    const prismaStudioManager = {
      launchForGuild: jest.fn(async () => undefined),
    } as unknown as PrismaStudioManager;
    const prismaStudioAccessGate = {
      authorize: jest.fn(() => ({ allowed: true })),
      recordSuccessfulLaunch: jest.fn(),
    } as unknown as PrismaStudioAccessGate;
    const configStore = {
      getGuildConfigResult: jest.fn(() => createConfigResult("guild-1")),
    } as unknown as GuildConfigStore;
    const manager = new GuildRuntimeManager(
      {} as Client,
      {} as OpenAI,
      configStore,
      new DiscordWorkScheduler(1, 0),
      undefined,
      prismaStudioManager,
      prismaStudioAccessGate
    );
    const interaction = {
      editReply: jest.fn(async () => undefined),
      guildId: "guild-1",
      id: "interaction-2",
      options: {
        getString: jest.fn(() => "secret"),
      },
      member: {
        roles: {
          cache: [{ name: "Bot Admin" }],
          some: (predicate: (role: { name: string }) => boolean) => predicate({ name: "Bot Admin" }),
        },
      },
    } as unknown as Parameters<GuildRuntimeManager["handlePrismaCommand"]>[0];

    await manager.handlePrismaCommand(interaction);

    expect(prismaStudioAccessGate.authorize as jest.Mock).toHaveBeenCalledWith("secret");
    expect(prismaStudioAccessGate.recordSuccessfulLaunch as jest.Mock).toHaveBeenCalledTimes(1);
    expect(prismaStudioManager.launchForGuild as jest.Mock).toHaveBeenCalledWith(createConfig("guild-1"));
    expect(interaction.editReply).toHaveBeenCalledWith("Prisma Studio was launched on the host machine.");
    expect(interaction.editReply).not.toHaveBeenCalledWith(expect.stringContaining("postgresql://"));
  });

  it("rejects /prisma when the password gate denies the request", async () => {
    const prismaStudioManager = {
      launchForGuild: jest.fn(async () => undefined),
    } as unknown as PrismaStudioManager;
    const prismaStudioAccessGate = {
      authorize: jest.fn(() => ({
        allowed: false,
        message: "Prisma Studio request was rejected.",
        reason: "rejected",
      })),
      recordSuccessfulLaunch: jest.fn(),
    } as unknown as PrismaStudioAccessGate;
    const configStore = {
      getGuildConfigResult: jest.fn(() => createConfigResult("guild-1")),
    } as unknown as GuildConfigStore;
    const manager = new GuildRuntimeManager(
      {} as Client,
      {} as OpenAI,
      configStore,
      new DiscordWorkScheduler(1, 0),
      undefined,
      prismaStudioManager,
      prismaStudioAccessGate
    );
    const interaction = {
      editReply: jest.fn(async () => undefined),
      guildId: "guild-1",
      id: "interaction-3",
      options: {
        getString: jest.fn(() => "wrong"),
      },
      member: {
        roles: {
          cache: [{ name: "Bot Admin" }],
          some: (predicate: (role: { name: string }) => boolean) => predicate({ name: "Bot Admin" }),
        },
      },
    } as unknown as Parameters<GuildRuntimeManager["handlePrismaCommand"]>[0];

    await manager.handlePrismaCommand(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith("Prisma Studio request was rejected.");
    expect(prismaStudioManager.launchForGuild as jest.Mock).not.toHaveBeenCalled();
    expect(prismaStudioAccessGate.recordSuccessfulLaunch as jest.Mock).not.toHaveBeenCalled();
  });
});
