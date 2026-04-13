import { Client, Message, TextChannel } from "discord.js";
import OpenAI from "openai";
import { PrismaClient } from "../prisma";
import AsyncMutex from "../utils/AsyncMutex";
import { MenuCustomID } from "../utils/MessageHelper/MessageBuilder";
import { GuildRepositories } from "./GuildRepositories";
import { DiscordWorkScheduler } from "./DiscordWorkScheduler";
import { InteractiveSurfaceRegistry } from "./InteractiveSurfaceRegistry";
import { GuildConfigStore } from "./GuildConfigStore";

export type SurfaceAction = string | MenuCustomID;

export type InteractiveSurfaceState =
  | "queue_open"
  | "queue_full"
  | "captain_blue_pick"
  | "captain_orange_pick"
  | "match_active"
  | "closed";

export interface EncryptedValue {
  authTag: string;
  ciphertext: string;
  iv: string;
}

export interface GuildInstanceStoredConfig {
  apiStatusChannelId?: string;
  chatChannelId?: string;
  createdAt: string;
  databaseUrl: EncryptedValue;
  enabledMatchSizes: number[];
  enabled: boolean;
  guildId: string;
  leaderboardChannelId: string;
  leaderboardMessageIds?: string[];
  openAiConversationId?: string;
  queueChannelId: string;
  queueMessageId?: string;
  soraEnabled: boolean;
  updatedAt: string;
}

export interface GuildInstanceConfig {
  apiStatusChannelId?: string;
  chatChannelId?: string;
  createdAt: string;
  databaseUrl: string;
  enabledMatchSizes: number[];
  enabled: boolean;
  guildId: string;
  leaderboardChannelId: string;
  leaderboardMessageIds?: string[];
  openAiConversationId?: string;
  queueChannelId: string;
  queueMessageId?: string;
  soraEnabled: boolean;
  updatedAt: string;
}

export interface GuildConfigUpsertInput {
  apiStatusChannelId?: string;
  chatChannelId?: string;
  databaseUrl: string;
  enabledMatchSizes?: number[];
  guildId: string;
  leaderboardChannelId: string;
  openAiConversationId?: string;
  queueChannelId: string;
  soraEnabled?: boolean;
}

export interface InteractiveSurfaceRecord {
  allowedActions: ReadonlySet<string>;
  allowedValues?: ReadonlySet<string>;
  kind: "queue" | "match";
  messageId: string;
  revision: number;
  state: InteractiveSurfaceState;
}

export interface GuildVoteState {
  captainsRandomVotes: Map<string, string>;
  captainDraftStepIndex: number;
  selectedMatchSize: number | null;
  sizeVotes: Map<string, number>;
}

export interface GuildChannels {
  apiStatusChannel?: TextChannel | null;
  chatChannel?: TextChannel | null;
  leaderboardChannel: TextChannel;
  queueChannel: TextChannel;
}

export interface GuildContext {
  channels: GuildChannels;
  client: Client;
  config: GuildInstanceConfig;
  configStore: GuildConfigStore;
  guildId: string;
  guildName?: string;
  leaderboardMessages: Message[];
  normProcessing: boolean;
  normQueue: Array<() => Promise<void>>;
  openai: OpenAI;
  prisma: PrismaClient;
  queueMessage: Message | null;
  queueMutex: AsyncMutex;
  repositories: GuildRepositories;
  scheduler: DiscordWorkScheduler;
  surfaceRegistry: InteractiveSurfaceRegistry;
  voteState: GuildVoteState;
}

export interface ActiveSurfaceState {
  allowedActions: Set<string>;
  allowedValues?: Set<string>;
  state: InteractiveSurfaceState;
}
