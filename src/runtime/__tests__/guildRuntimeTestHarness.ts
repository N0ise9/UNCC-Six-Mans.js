import { ButtonInteraction, Client, Message, StringSelectMenuInteraction, TextChannel } from "discord.js";
import OpenAI from "openai";
import AsyncMutex from "../../utils/AsyncMutex";
import { DiscordWorkScheduler } from "../DiscordWorkScheduler";
import { GuildContext, GuildInstanceConfig } from "../types";
import { GuildConfigStore } from "../GuildConfigStore";
import { GuildRepositories } from "../GuildRepositories";
import { InteractiveSurfaceRegistry } from "../InteractiveSurfaceRegistry";
import { ButtonCustomID } from "../../utils/MessageHelper/CustomButtons";
import { MenuCustomID } from "../../utils/MessageHelper/MessageBuilder";

type FakeMessageOptions = {
  embeds?: Array<Record<string, unknown>>;
  id?: string;
  replyMessage?: Message;
};

let interactionSequence = 0;

export function createGuildConfig(guildId = "guild-1"): GuildInstanceConfig {
  return {
    chatChannelId: `${guildId}-chat`,
    createdAt: "2026-01-01T00:00:00.000Z",
    databaseUrl: `postgres:///${guildId}`,
    enabled: true,
    guildId,
    leaderboardChannelId: `${guildId}-leaderboard`,
    queueChannelId: `${guildId}-queue`,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

export function createDiscordMessage(options: FakeMessageOptions = {}): Message {
  const message = Object.create(Message.prototype) as Message & {
    delete: jest.Mock;
    edit: jest.Mock;
    reply: jest.Mock;
  };

  Object.assign(message, {
    delete: jest.fn(async () => undefined),
    edit: jest.fn(async () => message),
    embeds: options.embeds ?? [],
    id: options.id ?? "message-1",
    reply: jest.fn(async () => options.replyMessage ?? createDiscordMessage({ id: "reply-message-1" })),
  });

  return message;
}

export function createButtonInteraction(
  customId: ButtonCustomID,
  message: Message,
  userId: string,
  username = userId
) {
  return {
    customId,
    followUp: jest.fn(async () => undefined),
    id: `interaction-${++interactionSequence}-${customId}-${userId}`,
    message,
    user: {
      id: userId,
      username,
    },
  } as unknown as ButtonInteraction;
}

export function createSelectMenuInteraction(
  customId: MenuCustomID,
  values: string[],
  message: Message,
  userId: string
) {
  return {
    customId,
    message,
    user: {
      id: userId,
      username: userId,
    },
    values,
  } as unknown as StringSelectMenuInteraction;
}

export function createGuildRuntimeTestContext(
  repositories: GuildRepositories | GuildContext["repositories"] | Record<string, unknown>,
  overrides: Partial<GuildContext> = {}
): GuildContext {
  const config = overrides.config ?? createGuildConfig(overrides.guildId ?? "guild-1");
  const configStore = {
    updateGuildRuntimeFields: jest.fn((_guildId: string, fields: Partial<GuildInstanceConfig>) => ({
      ...config,
      ...fields,
    })),
  } as unknown as GuildConfigStore;
  const queueChannel = {
    send: jest.fn(async () => createDiscordMessage({ id: "queue-message-1" })),
  } as unknown as TextChannel;
  const leaderboardChannel = {
    send: jest.fn(async () => createDiscordMessage({ id: "leaderboard-message-1" })),
  } as unknown as TextChannel;

  return {
    channels: {
      leaderboardChannel,
      queueChannel,
    },
    client: {} as Client,
    config,
    configStore,
    guildId: config.guildId,
    guildName: overrides.guildName ?? `Guild ${config.guildId}`,
    leaderboardMessages: [],
    normProcessing: false,
    normQueue: [],
    openai: {} as OpenAI,
    prisma: {
      $disconnect: jest.fn(async () => undefined),
    } as unknown as GuildContext["prisma"],
    queueMessage: overrides.queueMessage ?? createDiscordMessage({ id: "queue-message-1" }),
    queueMutex: overrides.queueMutex ?? new AsyncMutex(),
    repositories: repositories as GuildContext["repositories"],
    scheduler: overrides.scheduler ?? new DiscordWorkScheduler(1, 0),
    surfaceRegistry: overrides.surfaceRegistry ?? new InteractiveSurfaceRegistry(),
    voteState: overrides.voteState ?? {
      captainsRandomVotes: new Map<string, string>(),
      twosEnabled: false,
      twosVotes: new Map<string, string>(),
    },
    ...overrides,
  };
}
