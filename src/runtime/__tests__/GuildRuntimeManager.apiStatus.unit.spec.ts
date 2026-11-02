import {
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  Collection,
  Message,
  PermissionFlagsBits,
  PermissionsBitField,
  TextChannel,
} from "discord.js";
import OpenAI from "openai";
import { createUnknownServiceStatus, ServiceConfig, ServiceStatus } from "../../services/ApiStatusService";
import { ApiStatusRuntime } from "../ApiStatusRuntime";
import { DiscordWorkScheduler } from "../DiscordWorkScheduler";
import { GuildConfigReadResult, GuildConfigStore } from "../GuildConfigStore";
import { GuildRuntimeManager } from "../GuildRuntimeManager";
import { GuildConfigUpsertInput, GuildContext, GuildInstanceConfig } from "../types";
import { createGuildConfig, createGuildRuntimeTestContext } from "./guildRuntimeTestHarness";

type StatusMessage = Message & { delete: jest.Mock; edit: jest.Mock };
type StatusChannel = TextChannel & { sentMessages: StatusMessage[] };

function createStatusChannel(id: string): StatusChannel {
  const messages = new Collection<string, Message>();
  const sentMessages: StatusMessage[] = [];
  return {
    client: { user: { id: "bot-user" } },
    id,
    messages: { fetch: jest.fn(async () => messages.clone()) },
    send: jest.fn(async () => {
      const message = {
        author: { id: "bot-user" },
        channelId: id,
        createdTimestamp: Date.now(),
        delete: jest.fn(async () => { messages.delete(message.id); }),
        edit: jest.fn(async () => message),
        embeds: [{ footer: { text: "NormJS Status Summary | Page 1" } }],
        id: `${id}-message-${sentMessages.length}`,
      } as unknown as StatusMessage;
      messages.set(message.id, message);
      sentMessages.push(message);
      return message;
    }),
    sentMessages,
    type: ChannelType.GuildText,
  } as unknown as StatusChannel;
}

function createSetupInteraction(
  channels: Partial<Record<"chat_channel" | "api_status_channel", TextChannel>> = {},
  subcommand = "set"
): ChatInputCommandInteraction {
  return {
    editReply: jest.fn(async () => undefined),
    guildId: "guild-1",
    id: "setup-status-regression",
    memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild),
    options: {
      getBoolean: jest.fn(() => null),
      getChannel: jest.fn((name: keyof typeof channels) => channels[name] ?? null),
      getString: jest.fn(() => null),
      getSubcommand: jest.fn(() => subcommand),
    },
  } as unknown as ChatInputCommandInteraction;
}

async function createRuntime() {
  let config: GuildInstanceConfig = { ...createGuildConfig(), apiStatusChannelId: "status-1" };
  const configStore = {
    disableGuild: jest.fn(() => {
      config = { ...config, enabled: false };
      return config;
    }),
    getGuildConfigResult: jest.fn((): GuildConfigReadResult | null => ({
      config,
      enabled: config.enabled,
      guildId: config.guildId,
    })),
    setGuildConfig: jest.fn((input: GuildConfigUpsertInput) => {
      config = { ...config, ...input, enabled: true };
      return config;
    }),
  };
  const channel = createStatusChannel("status-1");
  const channels = new Map<string, StatusChannel>([[channel.id, channel]]);
  const service: ServiceConfig = {
    id: "test-service",
    name: "Test Service",
    pageUrl: "https://example.test/status",
    type: "generic",
  };
  const checkService = jest.fn<Promise<ServiceStatus>, []>(async () => ({
    ...createUnknownServiceStatus(service),
    lastChecked: new Date(),
    status: "operational" as const,
  }));
  const scheduler = new DiscordWorkScheduler(1, 0);
  const apiStatusRuntime = new ApiStatusRuntime(scheduler, {
    catalog: {
      awsChildren: [],
      awsRoot: null,
      displayCategories: [{ name: "Services", services: [service] }],
      generalServices: [{ categoryName: "Services", service }],
    },
    checkService,
    generalSweepMs: 100,
    publishDebounceMs: 0,
  });
  const registerSpy = jest.spyOn(apiStatusRuntime, "registerGuild");
  const unregisterSpy = jest.spyOn(apiStatusRuntime, "unregisterGuild");
  const manager = new GuildRuntimeManager(
    {} as Client,
    {} as OpenAI,
    configStore as unknown as GuildConfigStore,
    scheduler,
    apiStatusRuntime
  );
  const internals = manager as unknown as {
    createContext: (config: GuildInstanceConfig) => Promise<GuildContext>;
    refreshLeaderboard: (context: GuildContext) => Promise<void>;
    refreshQueueSurface: (context: GuildContext) => Promise<void>;
    startQueueTimer: (context: GuildContext) => void;
  };
  const createContextSpy = jest.spyOn(internals, "createContext").mockImplementation(async (nextConfig) => {
    const context = createGuildRuntimeTestContext({
      event: { ensureCurrentEvent: jest.fn(async () => ({ created: false, event: { name: "Default" } })) },
    }, { config: nextConfig, scheduler });
    context.channels.apiStatusChannel = channels.get(nextConfig.apiStatusChannelId ?? "") ?? null;
    context.channels.chatChannel = { id: nextConfig.chatChannelId, type: ChannelType.GuildText } as TextChannel;
    return context;
  });
  jest.spyOn(internals, "refreshLeaderboard").mockResolvedValue(undefined);
  jest.spyOn(internals, "refreshQueueSurface").mockResolvedValue(undefined);
  jest.spyOn(internals, "startQueueTimer").mockImplementation(() => undefined);

  await manager.ensureContext("guild-1");
  expect(channel.sentMessages).toHaveLength(1);
  jest.clearAllMocks();
  return {
    apiStatusRuntime, channel, channels, checkService, configStore, createContextSpy, manager,
    registerSpy, service, unregisterSpy,
  };
}

describe("guild reload API status lifecycle", () => {
  let runtime: Awaited<ReturnType<typeof createRuntime>>;

  beforeEach(async () => {
    jest.useFakeTimers();
    runtime = await createRuntime();
  });

  afterEach(async () => {
    await runtime.manager.dispose();
    await runtime.apiStatusRuntime.dispose();
    jest.useRealTimers();
  });

  it("updates only the chat channel without rebuilding statuses or resetting the next poll", async () => {
    const { apiStatusRuntime, channel, checkService, manager, registerSpy, unregisterSpy } = runtime;
    const interaction = createSetupInteraction({
      chat_channel: { id: "new-chat", type: ChannelType.GuildText } as TextChannel,
    });

    await jest.advanceTimersByTimeAsync(40);
    await manager.handleSetupCommand(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith("Guild configuration saved and runtime refreshed.");
    const reloaded = await manager.ensureContext("guild-1");
    expect(reloaded?.config.chatChannelId).toBe("new-chat");
    expect(reloaded?.channels.chatChannel?.id).toBe("new-chat");
    expect(apiStatusRuntime.isGuildRegistered("guild-1", channel.id)).toBe(true);
    expect(registerSpy).not.toHaveBeenCalled();
    expect(unregisterSpy).not.toHaveBeenCalled();
    expect(checkService).not.toHaveBeenCalled();
    expect(channel.messages.fetch).not.toHaveBeenCalled();
    expect(channel.send).not.toHaveBeenCalled();
    expect(channel.sentMessages[0].delete).not.toHaveBeenCalled();
    expect(channel.sentMessages[0].edit).not.toHaveBeenCalled();

    checkService.mockResolvedValueOnce({
      ...createUnknownServiceStatus(runtime.service),
      description: "Scheduled status update",
      status: "degraded_performance",
    });
    await jest.advanceTimersByTimeAsync(59);
    expect(checkService).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(2);
    expect(checkService).toHaveBeenCalledTimes(1);
    expect(channel.sentMessages[0].edit).toHaveBeenCalled();
    expect(channel.sentMessages).toHaveLength(1);
    expect(channel.sentMessages[0].delete).not.toHaveBeenCalled();
  });

  it("loads config saved while the previous context is disconnecting without resetting statuses", async () => {
    const { apiStatusRuntime, configStore, manager, registerSpy, unregisterSpy } = runtime;
    const previousContext = (await manager.ensureContext("guild-1"))!;
    let releaseDisconnect!: () => void;
    let confirmDisconnect!: () => void;
    const disconnecting = new Promise<void>((resolve) => { confirmDisconnect = resolve; });
    const pausedDisconnect = new Promise<void>((resolve) => { releaseDisconnect = resolve; });
    (previousContext.prisma.$disconnect as jest.Mock).mockImplementationOnce(async () => {
      confirmDisconnect();
      await pausedDisconnect;
    });
    configStore.setGuildConfig({ ...previousContext.config, chatChannelId: "chat-a" });

    const reload = manager.reloadContext("guild-1");
    try {
      await disconnecting;
      configStore.setGuildConfig({ ...previousContext.config, chatChannelId: "chat-b" });
      releaseDisconnect();
      await expect(reload).resolves.toBeNull();

      const reloaded = await manager.ensureContext("guild-1");
      expect(reloaded?.config.chatChannelId).toBe("chat-b");
      expect(reloaded?.channels.chatChannel?.id).toBe("chat-b");
      expect(apiStatusRuntime.isGuildRegistered("guild-1", "status-1")).toBe(true);
      expect(registerSpy).not.toHaveBeenCalled();
      expect(unregisterSpy).not.toHaveBeenCalled();
      expect(runtime.checkService).not.toHaveBeenCalled();
      expect(runtime.channel.send).not.toHaveBeenCalled();
      expect(runtime.channel.sentMessages[0].delete).not.toHaveBeenCalled();
    } finally {
      releaseDisconnect();
      await reload;
    }
  });

  it("re-registers API statuses when the configured status channel changes", async () => {
    const replacement = createStatusChannel("status-2");
    runtime.channels.set(replacement.id, replacement);

    await runtime.manager.handleSetupCommand(createSetupInteraction({ api_status_channel: replacement }));

    expect(runtime.unregisterSpy).toHaveBeenCalledWith("guild-1");
    expect(runtime.registerSpy).toHaveBeenCalledWith("guild-1", replacement);
    expect(runtime.apiStatusRuntime.isGuildRegistered("guild-1", "status-1")).toBe(false);
    expect(runtime.apiStatusRuntime.isGuildRegistered("guild-1", "status-2")).toBe(true);
    expect(replacement.messages.fetch).toHaveBeenCalledTimes(1);
    expect(replacement.send).toHaveBeenCalledTimes(1);
  });

  it("unregisters API statuses when setup disables the guild", async () => {
    await runtime.manager.handleSetupCommand(createSetupInteraction({}, "disable"));

    expect(runtime.unregisterSpy).toHaveBeenCalledWith("guild-1");
    expect(runtime.registerSpy).not.toHaveBeenCalled();
    expect(runtime.apiStatusRuntime.isGuildRegistered("guild-1", "status-1")).toBe(false);
    await jest.advanceTimersByTimeAsync(200);
    expect(runtime.checkService).not.toHaveBeenCalled();
  });

  it("cleans up a preserved registration when the replacement context fails to load", async () => {
    runtime.createContextSpy.mockRejectedValueOnce(new Error("Database unavailable"));
    jest.spyOn(console, "error").mockImplementation(() => undefined);

    const failure = await runtime.manager.reloadContext("guild-1");

    expect(failure).not.toBeNull();
    expect(runtime.unregisterSpy).toHaveBeenCalledWith("guild-1");
    expect(runtime.registerSpy).not.toHaveBeenCalled();
    expect(runtime.apiStatusRuntime.isGuildRegistered("guild-1", "status-1")).toBe(false);
    await jest.advanceTimersByTimeAsync(200);
    expect(runtime.checkService).not.toHaveBeenCalled();
  });

  it.each(["missing", "unreadable"])("unregisters API statuses when the config is %s", async (kind) => {
    runtime.configStore.getGuildConfigResult.mockReturnValueOnce(kind === "missing" ? null : {
      config: null,
      enabled: true,
      error: new Error("Decryption failed"),
      guildId: "guild-1",
    });
    jest.spyOn(console, "error").mockImplementation(() => undefined);

    await runtime.manager.reloadContext("guild-1");

    expect(runtime.unregisterSpy).toHaveBeenCalledWith("guild-1");
    expect(runtime.registerSpy).not.toHaveBeenCalled();
    expect(runtime.apiStatusRuntime.isGuildRegistered("guild-1", "status-1")).toBe(false);
  });

  it("unregisters API statuses when reading the config throws", async () => {
    runtime.configStore.getGuildConfigResult.mockImplementationOnce(() => {
      throw new Error("Config read failed");
    });

    await expect(runtime.manager.reloadContext("guild-1")).rejects.toThrow("Config read failed");

    expect(runtime.unregisterSpy).toHaveBeenCalledWith("guild-1");
    expect(runtime.registerSpy).not.toHaveBeenCalled();
    expect(runtime.apiStatusRuntime.isGuildRegistered("guild-1", "status-1")).toBe(false);
  });

  it("unregisters preserved statuses when the configured channel cannot be resolved", async () => {
    runtime.channels.delete("status-1");

    await runtime.manager.reloadContext("guild-1");

    expect(runtime.unregisterSpy).toHaveBeenCalledWith("guild-1");
    expect(runtime.registerSpy).not.toHaveBeenCalled();
    expect(runtime.apiStatusRuntime.isGuildRegistered("guild-1", "status-1")).toBe(false);
  });
});
