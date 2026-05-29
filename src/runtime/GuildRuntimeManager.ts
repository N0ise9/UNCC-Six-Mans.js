import {
  BaseMessageOptions,
  ButtonInteraction,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  MessageFlags,
  Message,
  PermissionFlagsBits,
  StringSelectMenuInteraction,
  TextChannel,
} from "discord.js";
import { DateTime } from "luxon";
import OpenAI from "openai";
import { createPrismaClient } from "../prisma";
import AsyncMutex from "../utils/AsyncMutex";
import { waitForAllPromises } from "../utils";
import { ActiveMatchCreated } from "../domain/match";
import { handleEasterEggSlashInteraction } from "../controllers/EasterEggs";
import { Team } from "../types/common";
import MessageBuilder, { MenuCustomID } from "../utils/MessageHelper/MessageBuilder";
import { ButtonCustomID } from "../utils/MessageHelper/CustomButtons";
import { ApiStatusRuntime } from "./ApiStatusRuntime";
import { GuildConfigStore, maskSecret } from "./GuildConfigStore";
import { DiscordWorkScheduler } from "./DiscordWorkScheduler";
import { GuildRepositories } from "./GuildRepositories";
import { InteractiveSurfaceRegistry } from "./InteractiveSurfaceRegistry";
import { PrismaStudioManager } from "./PrismaStudioManager";
import { PrismaStudioAccessGate } from "./PrismaStudioAccessGate";
import { reconcileTrackedMessages } from "./reconcileTrackedMessages";
import { createScheduledCommandResponder } from "./createScheduledCommandResponder";
import {
  calculateMMR,
  calculateProbability,
  calculateProbabilityDecimal,
  chooseCaptains,
  countCaptainsRandomVotes,
  countMatchSizeVotes,
  createRandomTeams,
  DEFAULT_ENABLED_MATCH_SIZES,
  formatMatchSizeLabel,
  getCaptainDraftSteps,
  getCaptainsRandomVoteThreshold,
  getHighestEnabledMatchSize,
  getLowerTierVoteMatchSize,
  getQueueTargetSize,
  normalizeEnabledMatchSizes,
  resolveMatchReport,
} from "./sixMansRules";
import {
  ActiveMatchTeams,
  NewActiveMatchInput,
  PlayerInActiveMatch,
} from "../repositories/ActiveMatchRepository/types";
import { AddBallChaserToQueueInput, PlayerInQueue } from "../repositories/QueueRepository/types";
import { ActiveSurfaceState, GuildChannels, GuildConfigUpsertInput, GuildContext, GuildInstanceConfig } from "./types";
import { createVoteMatchSizeCustomId, parseVoteMatchSizeCustomId } from "../utils/MessageHelper/CustomButtons";

type QueueRender = {
  players: ReadonlyArray<Readonly<PlayerInQueue>>;
  surface: ActiveSurfaceState;
  view: Awaited<ReturnType<typeof MessageBuilder.activeMatchMessage>> | ReturnType<typeof MessageBuilder.queueMessage>;
};

type MessageComponents = NonNullable<BaseMessageOptions["components"]>;

type StartupQueueSurfaceSnapshot = {
  components: MessageComponents;
  message: Message;
};

type PostCommitEffect = () => Promise<void> | void;

type RenderCoordinator = {
  lastSuccessfulFingerprint: string | null;
  lastSuccessfulRenderAt: number | null;
  lastSuccessfulVersion: number;
  latestFingerprint: string | null;
  latestVersion: number;
  nextDispatchId: number;
  pendingDispatchId: number | null;
  pendingVersion: number | null;
  render: ((version: number, dispatchId: number) => Promise<boolean>) | null;
  scheduledTimer: NodeJS.Timeout | null;
};

type GuildRuntimeFailureCode = "bootstrap" | "channels" | "config" | "database" | "unknown";

type GuildRuntimeLoadFailure = {
  code: GuildRuntimeFailureCode;
  message: string;
};

type GuildRuntimeLoadResult = {
  context: GuildContext | null;
  failure: GuildRuntimeLoadFailure | null;
};

type InteractionAuditStatus = "processed" | "ignored";

type InteractionAuditResult = {
  reason: string;
  status: InteractionAuditStatus;
};

type SetupConfigMergeInput = {
  apiStatusChannelId?: string;
  chatChannelId?: string;
  databaseUrl?: string;
  enabledMatchSizes?: number[];
  guildId: string;
  leaderboardChannelId?: string;
  openAiConversationId?: string;
  queueChannelId?: string;
  soraEnabled?: boolean;
};

type QueueInteractionAuditResult = InteractionAuditResult & {
  players: ReadonlyArray<PlayerInQueue> | null;
};

class GuildRuntimeInitializationError extends Error {
  constructor(
    readonly code: Exclude<GuildRuntimeFailureCode, "config" | "unknown">,
    message: string,
    readonly cause: unknown
  ) {
    super(message);
    this.name = "GuildRuntimeInitializationError";
  }
}

export class GuildRuntimeManager {
  private static readonly HOT_SURFACE_RENDER_INTERVAL_MS = 1250;

  private readonly contexts = new Map<string, GuildContext>();
  private readonly contextLoads = new Map<string, Promise<GuildRuntimeLoadResult>>();
  private readonly queueTimers = new Map<string, NodeJS.Timeout>();
  private readonly queueMessageCreates = new Map<string, Promise<Message | undefined>>();
  private readonly renderCoordinators = new Map<string, RenderCoordinator>();
  private readonly startupQueueSurfaceSnapshots = new Map<string, StartupQueueSurfaceSnapshot>();

  constructor(
    private readonly client: Client,
    private readonly openai: OpenAI,
    private readonly configStore: GuildConfigStore,
    private readonly scheduler: DiscordWorkScheduler,
    private readonly apiStatusRuntime?: ApiStatusRuntime,
    private readonly prismaStudioManager: PrismaStudioManager = new PrismaStudioManager(),
    private readonly prismaStudioAccessGate: PrismaStudioAccessGate = new PrismaStudioAccessGate()
  ) {}

  private formatGuildLogLabel(guildId: string, guildName?: string): string {
    return formatGuildLogLabel(
      guildId,
      guildName ??
        this.contexts.get(guildId)?.guildName ??
        (this.client as Partial<Client>).guilds?.cache.get(guildId)?.name
    );
  }

  private formatRenderLogLabel(key: string): string {
    const [, guildId] = key.split(":");
    if (!guildId) {
      return key;
    }

    return this.formatGuildLogLabel(guildId);
  }

  async dispose(): Promise<void> {
    for (const timer of this.queueTimers.values()) {
      clearInterval(timer);
    }
    this.queueTimers.clear();
    for (const coordinator of this.renderCoordinators.values()) {
      if (coordinator.scheduledTimer) {
        clearTimeout(coordinator.scheduledTimer);
      }
    }
    this.renderCoordinators.clear();
    this.queueMessageCreates.clear();
    this.contextLoads.clear();
    this.startupQueueSurfaceSnapshots.clear();

    for (const context of this.contexts.values()) {
      this.apiStatusRuntime?.unregisterGuild(context.guildId);
      await context.prisma.$disconnect().catch(() => undefined);
    }
    this.contexts.clear();
    await this.prismaStudioManager.dispose();
  }

  async ensureContext(guildId: string): Promise<GuildContext | null> {
    const existing = this.contexts.get(guildId);
    if (existing) return existing;

    const existingLoad = this.contextLoads.get(guildId);
    if (existingLoad) {
      return (await existingLoad).context;
    }

    const configResult = this.configStore.getGuildConfigResult(guildId);
    if (!configResult) {
      return null;
    }

    if (configResult.error) {
      console.error(
        `[${this.formatGuildLogLabel(guildId)}] Failed to decrypt stored guild configuration. ` +
          "Check CONFIG_ENCRYPTION_KEY and config file integrity.",
        configResult.error
      );
      return null;
    }

    const config = configResult.config;
    if (!config || !config.enabled) {
      return null;
    }

    return (await this.loadContextOnce(config)).context;
  }

  async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      if (interaction.commandName === "norm") {
        logInteractionAudit({
          action: "/norm",
          guildId: null,
          reason: "command only works inside a server",
          status: "ignored",
          username: interaction.user.username,
        });
      }
      await interaction.reply({
        content: "This command only works inside a server.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.commandName === "setup") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await this.handleSetupCommand(interaction);
      return;
    }

    if (interaction.commandName === "prisma") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await this.handlePrismaCommand(interaction);
      return;
    }

    const context = await this.ensureContext(interaction.guildId);
    if (!context) {
      const configResult = this.configStore.getGuildConfigResult(interaction.guildId);
      if (configResult?.error) {
        if (interaction.commandName === "norm") {
          logInteractionAudit({
            action: "/norm",
            guildId: interaction.guildId,
            guildName: interaction.guild?.name,
            reason: "stored guild configuration could not be decrypted",
            status: "ignored",
            username: interaction.user.username,
          });
        }
        await interaction.reply({
          content:
            "This guild is configured, but I couldn't read its stored configuration. " +
            "Check CONFIG_ENCRYPTION_KEY and rerun /setup set.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (configResult?.config?.enabled) {
        if (interaction.commandName === "norm") {
          logInteractionAudit({
            action: "/norm",
            guildId: interaction.guildId,
            guildName: interaction.guild?.name,
            reason: "guild runtime is configured but failed to load",
            status: "ignored",
            username: interaction.user.username,
          });
        }
        await interaction.reply({
          content:
            "This guild is configured, but the runtime failed to load. Check the configured channels " +
            "and database URL, then rerun /setup set.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === "norm") {
        logInteractionAudit({
          action: "/norm",
          guildId: interaction.guildId,
          guildName: interaction.guild?.name,
          reason: "guild has not been configured yet",
          status: "ignored",
          username: interaction.user.username,
        });
      }
      await interaction.reply({
        content: "This guild has not been configured yet. Run /setup set first.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.commandName === "kick" || interaction.commandName === "clear") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await this.handleAdminCommand(context, interaction);
      return;
    }

    if (interaction.commandName === "norm" || interaction.commandName === "sora") {
      if (interaction.commandName === "sora" && !context.config.soraEnabled) {
        await interaction.reply({
          content: "Sora is disabled for this server. A server admin can enable it with /setup set.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (!context.config.chatChannelId) {
        if (interaction.commandName === "norm") {
          logInteractionAudit({
            action: "/norm",
            guildId: interaction.guildId,
            guildName: context.guildName,
            reason: "OpenAI chat channel is not configured",
            status: "ignored",
            username: interaction.user.username,
          });
        }
        await interaction.reply({
          content: "This guild is missing its OpenAI chat channel. A server admin needs to rerun /setup set.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.channelId !== context.config.chatChannelId) {
        if (interaction.commandName === "norm") {
          logInteractionAudit({
            action: "/norm",
            guildId: interaction.guildId,
            guildName: context.guildName,
            reason: `wrong channel; use ${context.config.chatChannelId}`,
            status: "ignored",
            username: interaction.user.username,
          });
        }
        await interaction.reply({
          content: `Use this command in <#${context.config.chatChannelId}>.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.commandName === "norm") {
        logInteractionAudit({
          action: "/norm",
          guildId: interaction.guildId,
          guildName: context.guildName,
          reason: "OpenAI",
          status: "processed",
          username: interaction.user.username,
        });
      }
      await interaction.deferReply();
      await handleEasterEggSlashInteraction(context, interaction);
    }
  }

  async handlePrismaCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const responder = createScheduledCommandResponder(interaction, this.scheduler, "prisma", "high");
    const password = interaction.options.getString("password", true);

    if (!interaction.guildId) {
      await responder.edit("This command only works inside a server.");
      return;
    }

    if (!isBotAdmin(interaction)) {
      await responder.edit(
        "What do you think you're doing? Trying to run an admin command when you're not a Bot Admin. Typical."
      );
      return;
    }

    const accessDecision = this.prismaStudioAccessGate.authorize(password);
    if (!accessDecision.allowed) {
      await responder.edit(accessDecision.message);
      return;
    }

    const configResult = this.configStore.getGuildConfigResult(interaction.guildId);
    if (configResult?.error) {
      await responder.edit(
        "This guild is configured, but I couldn't read its stored configuration. Check CONFIG_ENCRYPTION_KEY."
      );
      return;
    }

    if (!configResult?.config || !configResult.enabled) {
      await responder.edit("This guild has not been configured yet. Run /setup set first.");
      return;
    }

    try {
      await this.prismaStudioManager.launchForGuild(configResult.config);
      this.prismaStudioAccessGate.recordSuccessfulLaunch();
      await responder.edit("Prisma Studio was launched on the host machine.");
    } catch (error) {
      console.error(
        `[${this.formatGuildLogLabel(interaction.guildId, interaction.guild?.name)}] ` +
          "Failed to launch Prisma Studio:",
        error
      );
      await responder.edit("Prisma Studio request could not be completed. Check the bot console for details.");
    }
  }

  async handleSetupCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const responder = createScheduledCommandResponder(interaction, this.scheduler, "setup", "high");

    if (!interaction.guildId) {
      await responder.edit("This command only works inside a server.");
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await responder.edit("You need Manage Server permissions to run setup.");
      return;
    }

    switch (interaction.options.getSubcommand()) {
      case "show": {
        const configResult = this.configStore.getGuildConfigResult(interaction.guildId);
        if (!configResult) {
          await responder.edit("This guild has not been configured yet.");
          return;
        }

        if (configResult.error || !configResult.config) {
          await responder.edit(
            "This guild is configured, but I couldn't read its stored configuration. " +
              "Check CONFIG_ENCRYPTION_KEY and rerun /setup set."
          );
          return;
        }

        const config = configResult.config;
        await responder.edit(
          [
            `Guild: ${config.guildId}`,
            `Enabled: ${config.enabled}`,
            `Match types: ${config.enabledMatchSizes.map((matchSize) => formatMatchSizeLabel(matchSize)).join(", ")}`,
            `Queue channel: ${config.queueChannelId}`,
            `Leaderboard channel: ${config.leaderboardChannelId}`,
            `Leaderboard messages: ${config.leaderboardMessageIds?.join(", ") ?? "not created yet"}`,
            `Chat channel: ${config.chatChannelId ?? "not configured; /norm and /sora unavailable"}`,
            `API status channel: ${config.apiStatusChannelId ?? "none"}`,
            `Sora: ${config.soraEnabled ? "enabled" : "disabled"}`,
            `Database URL: ${maskSecret(config.databaseUrl)}`,
            `Queue message: ${config.queueMessageId ?? "not created yet"}`,
            `Conversation: ${config.openAiConversationId ?? "not created yet"}`,
          ].join("\n")
        );
        return;
      }
      case "disable": {
        const config = this.configStore.disableGuild(interaction.guildId);
        await this.reloadContext(interaction.guildId);
        await responder.edit(config ? "Guild configuration disabled." : "No guild configuration was found.");
        return;
      }
      case "set": {
        const existingConfigResult = this.configStore.getGuildConfigResult(interaction.guildId);
        if (existingConfigResult?.error) {
          await responder.edit(
            "This guild already has stored setup data, but I couldn't read it. " +
              "Check CONFIG_ENCRYPTION_KEY and rerun /setup set with queue_channel, " +
              "leaderboard_channel, and database_url."
          );
          return;
        }

        const existingConfig = existingConfigResult?.config ?? null;
        const queueChannel = interaction.options.getChannel("queue_channel");
        const leaderboardChannel = interaction.options.getChannel("leaderboard_channel");
        const chatChannel = interaction.options.getChannel("chat_channel");
        const apiStatusChannel = interaction.options.getChannel("api_status_channel");
        const databaseUrl = interaction.options.getString("database_url") ?? undefined;
        const conversationId = interaction.options.getString("conversation_id") ?? undefined;
        const soraEnabled = interaction.options.getBoolean("sora_enabled") ?? undefined;
        const matchSizeOverrides = getSetupMatchSizeOverrides(interaction);

        if (queueChannel && queueChannel.type !== ChannelType.GuildText) {
          await responder.edit("Queue channel must be a text channel.");
          return;
        }
        if (leaderboardChannel && leaderboardChannel.type !== ChannelType.GuildText) {
          await responder.edit("Leaderboard channel must be a text channel.");
          return;
        }
        if (chatChannel && chatChannel.type !== ChannelType.GuildText) {
          await responder.edit("Chat channel must be a text channel.");
          return;
        }
        if (apiStatusChannel && apiStatusChannel.type !== ChannelType.GuildText) {
          await responder.edit("API status channel must be a text channel.");
          return;
        }

        const mergedInput = {
          apiStatusChannelId: apiStatusChannel?.id ?? existingConfig?.apiStatusChannelId,
          chatChannelId: chatChannel?.id ?? existingConfig?.chatChannelId,
          databaseUrl: databaseUrl ?? existingConfig?.databaseUrl,
          enabledMatchSizes: mergeEnabledMatchSizes(existingConfig?.enabledMatchSizes, matchSizeOverrides),
          guildId: interaction.guildId,
          leaderboardChannelId: leaderboardChannel?.id ?? existingConfig?.leaderboardChannelId,
          openAiConversationId: conversationId ?? existingConfig?.openAiConversationId,
          queueChannelId: queueChannel?.id ?? existingConfig?.queueChannelId,
          soraEnabled: soraEnabled ?? existingConfig?.soraEnabled ?? false,
        };

        const missingFields = getMissingRequiredSetupFields(mergedInput);
        if (missingFields.length > 0) {
          const prefix = existingConfig
            ? "Stored guild configuration is missing required values."
            : "This guild is not configured yet.";
          await responder.edit(`${prefix} Provide these required options: ${missingFields.join(", ")}.`);
          return;
        }
        if ((mergedInput.enabledMatchSizes?.length ?? 0) === 0) {
          await responder.edit("At least one match type must stay enabled.");
          return;
        }

        const input: GuildConfigUpsertInput = {
          apiStatusChannelId: mergedInput.apiStatusChannelId,
          chatChannelId: mergedInput.chatChannelId,
          databaseUrl: mergedInput.databaseUrl!,
          enabledMatchSizes: mergedInput.enabledMatchSizes,
          guildId: mergedInput.guildId,
          leaderboardChannelId: mergedInput.leaderboardChannelId!,
          openAiConversationId: mergedInput.openAiConversationId,
          queueChannelId: mergedInput.queueChannelId!,
          soraEnabled: mergedInput.soraEnabled,
        };

        this.configStore.setGuildConfig(input);
        const reloadFailure = await this.reloadContext(interaction.guildId);
        if (reloadFailure) {
          await responder.edit(`Guild configuration saved, but the runtime failed to load: ${reloadFailure.message}`);
          return;
        }

        await responder.edit("Guild configuration saved and runtime refreshed.");
        return;
      }
    }
  }

  async initializeConfiguredGuilds(): Promise<void> {
    const configs = this.configStore.getGuildConfigResults();
    for (const configResult of configs) {
      if (configResult.error) {
        console.error(
          `[${this.formatGuildLogLabel(configResult.guildId)}] ` +
            "Failed to decrypt stored guild configuration during startup.",
          configResult.error
        );
        continue;
      }

      if (!configResult.config?.enabled) {
        continue;
      }

      await this.loadContextOnce(configResult.config);
    }
  }

  async prepareStartupQueueSurfaces(): Promise<void> {
    const configs = this.configStore.getGuildConfigResults();
    for (const configResult of configs) {
      if (configResult.error) {
        console.error(
          `[${this.formatGuildLogLabel(configResult.guildId)}] ` +
            "Failed to decrypt stored guild configuration during startup queue preparation.",
          configResult.error
        );
        continue;
      }

      const config = configResult.config;
      if (!config?.enabled || !config.queueMessageId) {
        continue;
      }

      try {
        const queueChannel = await fetchTextChannel(this.client, config.queueChannelId);
        const queueMessage = await this.restoreQueueMessage(config, queueChannel);
        if (!queueMessage || queueMessage.embeds.length === 0 || queueMessage.components.length === 0) {
          continue;
        }

        if (!this.startupQueueSurfaceSnapshots.has(config.guildId)) {
          this.startupQueueSurfaceSnapshots.set(config.guildId, {
            components: serializeMessageComponents(queueMessage),
            message: queueMessage,
          });
        }

        await this.scheduler.enqueue(
          async () => await queueMessage.edit(MessageBuilder.queueStartupLoadingComponents()),
          {
            coalesce: "replace",
            dedupeKey: `message-edit:${queueMessage.id}`,
            label: `queue-startup-lockdown:${config.guildId}`,
            priority: "high",
            rateLimitKey: getMessageEditLane(queueMessage.id),
          }
        );
      } catch (error) {
        console.error(
          `[${this.formatGuildLogLabel(config.guildId)}] Failed to prepare the startup queue surface:`,
          error
        );
      }
    }
  }

  async reloadContext(guildId: string): Promise<GuildRuntimeLoadFailure | null> {
    const activeLoad = this.contextLoads.get(guildId);
    if (activeLoad) {
      await activeLoad;
    }

    await this.teardownContext(guildId);

    const configResult = this.configStore.getGuildConfigResult(guildId);
    if (!configResult) {
      return null;
    }

    if (configResult.error) {
      console.error(
        `[${this.formatGuildLogLabel(guildId)}] Failed to decrypt stored guild configuration during reload.`,
        configResult.error
      );
      return {
        code: "config",
        message: "stored configuration could not be decrypted",
      };
    }

    const config = configResult.config;
    if (!config || !config.enabled) {
      return null;
    }

    const result = await this.loadContextOnce(config);
    return result.failure;
  }

  private async loadContextOnce(config: GuildInstanceConfig): Promise<GuildRuntimeLoadResult> {
    const activeLoad = this.contextLoads.get(config.guildId);
    if (activeLoad) {
      return await activeLoad;
    }

    const load = this.loadContext(config);
    this.contextLoads.set(config.guildId, load);

    try {
      return await load;
    } finally {
      if (this.contextLoads.get(config.guildId) === load) {
        this.contextLoads.delete(config.guildId);
      }
    }
  }

  private async bootstrapContext(context: GuildContext): Promise<void> {
    const ensuredEvent = await context.repositories.event.ensureCurrentEvent();
    if (ensuredEvent.created) {
      console.info(
        `[${this.formatGuildLogLabel(context.guildId, context.guildName)}] ` +
          "No active event was found in the guild database. " +
          `Created default event "${ensuredEvent.event.name}".`
      );
    }

    await this.refreshLeaderboard(context);
    if (context.channels.apiStatusChannel) {
      await this.apiStatusRuntime?.registerGuild(context.guildId, context.channels.apiStatusChannel);
    } else {
      this.apiStatusRuntime?.unregisterGuild(context.guildId);
    }
    await this.refreshQueueSurface(context);
    this.clearStartupQueueSurfaceSnapshot(context.guildId);
    this.startQueueTimer(context);
  }

  private async createContext(config: GuildInstanceConfig): Promise<GuildContext> {
    let channels: GuildChannels;
    try {
      channels = await this.fetchChannels(config);
    } catch (error) {
      throw new GuildRuntimeInitializationError(
        "channels",
        "one or more configured Discord channels could not be fetched",
        error
      );
    }

    const prisma = createPrismaClient(config.databaseUrl);
    try {
      await prisma.$connect();
      await prisma.$queryRawUnsafe("SELECT 1");
    } catch (error) {
      await prisma.$disconnect().catch(() => undefined);
      throw new GuildRuntimeInitializationError(
        "database",
        "the configured Postgres database URL could not be reached",
        error
      );
    }

    return {
      channels,
      client: this.client,
      config,
      configStore: this.configStore,
      guildId: config.guildId,
      guildName: channels.queueChannel.guild.name,
      leaderboardMessages: await this.restoreLeaderboardMessages(config, channels.leaderboardChannel),
      normProcessing: false,
      normQueue: [],
      openai: this.openai,
      prisma,
      queueMessage: await this.restoreQueueMessage(config, channels.queueChannel),
      queueMutex: new AsyncMutex(),
      repositories: new GuildRepositories(prisma),
      scheduler: this.scheduler,
      surfaceRegistry: new InteractiveSurfaceRegistry(),
      voteState: {
        captainDraftStepIndex: 0,
        captainsRandomVotes: new Map<string, string>(),
        selectedMatchSize: null,
        sizeVotes: new Map<string, number>(),
      },
    };
  }

  private async fetchChannels(config: GuildInstanceConfig): Promise<GuildChannels> {
    const queueChannel = await fetchTextChannel(this.client, config.queueChannelId);
    const leaderboardChannel = await fetchTextChannel(this.client, config.leaderboardChannelId);
    const chatChannel = config.chatChannelId ? await fetchTextChannel(this.client, config.chatChannelId) : null;
    const apiStatusChannel = config.apiStatusChannelId
      ? await fetchTextChannel(this.client, config.apiStatusChannelId).catch(() => null)
      : null;

    return {
      apiStatusChannel,
      chatChannel,
      leaderboardChannel,
      queueChannel,
    };
  }

  private async restoreQueueMessage(config: GuildInstanceConfig, queueChannel: TextChannel): Promise<Message | null> {
    if (!config.queueMessageId) {
      return null;
    }

    try {
      return await queueChannel.messages.fetch(config.queueMessageId);
    } catch {
      console.warn(
        `[${this.formatGuildLogLabel(config.guildId, queueChannel.guild.name)}] ` +
          `Stored queue message ${config.queueMessageId} no longer exists; recreating.`
      );
      this.configStore.updateGuildRuntimeFields(config.guildId, { queueMessageId: null });
      return null;
    }
  }

  private async restoreLeaderboardMessages(
    config: GuildInstanceConfig,
    leaderboardChannel: TextChannel
  ): Promise<Message[]> {
    const leaderboardMessageIds = config.leaderboardMessageIds ?? [];
    if (leaderboardMessageIds.length === 0) {
      return [];
    }

    const restoredMessages: Message[] = [];
    let missingMessages = false;

    for (const messageId of leaderboardMessageIds) {
      try {
        restoredMessages.push(await leaderboardChannel.messages.fetch(messageId));
      } catch {
        missingMessages = true;
        console.warn(
          `[${this.formatGuildLogLabel(config.guildId, leaderboardChannel.guild.name)}] ` +
            `Stored leaderboard message ${messageId} no longer exists; recreating.`
        );
      }
    }

    if (missingMessages) {
      this.configStore.updateGuildRuntimeFields(config.guildId, {
        leaderboardMessageIds: restoredMessages.length > 0 ? restoredMessages.map((message) => message.id) : null,
      });
    }

    return restoredMessages;
  }

  private async loadContext(config: GuildInstanceConfig): Promise<GuildRuntimeLoadResult> {
    let context: GuildContext | null = null;

    try {
      context = await this.createContext(config);
      try {
        await this.bootstrapContext(context);
      } catch (error) {
        throw new GuildRuntimeInitializationError(
          "bootstrap",
          "the guild runtime loaded but failed during bootstrap",
          error
        );
      }

      this.contexts.set(config.guildId, context);
      return {
        context,
        failure: null,
      };
    } catch (error) {
      const failure = classifyGuildRuntimeFailure(error);
      console.error(
        `[${this.formatGuildLogLabel(config.guildId)}] Failed to initialize guild runtime: ${failure.message}`,
        error
      );
      this.apiStatusRuntime?.unregisterGuild(config.guildId);
      await this.restoreStartupQueueSurfaceSnapshot(config.guildId).catch((restoreError) => {
        console.error(
          `[${this.formatGuildLogLabel(config.guildId)}] ` +
            "Failed to restore startup queue components after initialization failure:",
          restoreError
        );
      });
      if (context) {
        await context.prisma.$disconnect().catch(() => undefined);
      }
      return {
        context: null,
        failure,
      };
    }
  }

  private async teardownContext(guildId: string): Promise<void> {
    const timer = this.queueTimers.get(guildId);
    if (timer) {
      clearInterval(timer);
      this.queueTimers.delete(guildId);
    }

    this.cancelRenderCoordinatorsForGuild(guildId);
    this.queueMessageCreates.delete(guildId);
    this.startupQueueSurfaceSnapshots.delete(guildId);

    const existing = this.contexts.get(guildId);
    if (!existing) {
      this.apiStatusRuntime?.unregisterGuild(guildId);
      return;
    }

    this.apiStatusRuntime?.unregisterGuild(guildId);
    await existing.prisma.$disconnect().catch(() => undefined);
    this.contexts.delete(guildId);
  }

  async handleAdminCommand(context: GuildContext, interaction: ChatInputCommandInteraction): Promise<void> {
    const responder = createScheduledCommandResponder(interaction, this.scheduler, `admin-${interaction.commandName}`);

    if (!isBotAdmin(interaction)) {
      await responder.edit(
        "What do you think you're doing? Trying to run an admin command when you're not a Bot Admin. Typical."
      );
      return;
    }

    const release = await context.queueMutex.acquire();
    try {
      switch (interaction.commandName) {
        case "kick": {
          const playerToRemove = interaction.options.getUser("player");
          if (!playerToRemove) {
            await responder.edit("No player was provided.");
            return;
          }

          await kickPlayerFromQueue(context, playerToRemove.id);
          await this.refreshQueueSurface(context);
          await responder.edit(`${playerToRemove.username} has been removed from the queue.`);
          return;
        }
        case "clear": {
          await context.repositories.queue.removeAllBallChasersFromQueue();
          resetVoteState(context);
          await this.refreshQueueSurface(context);
          await responder.edit("Queue has been cleared.");
          return;
        }
      }
    } finally {
      release();
    }
  }

  async handleButtonInteraction(context: GuildContext, interaction: ButtonInteraction): Promise<void> {
    const action = describeButtonInteractionAction(interaction.customId);
    const message = interaction.message;
    if (!(message instanceof Message)) {
      logInteractionAudit({
        action,
        guildId: context.guildId,
        guildName: context.guildName,
        reason: "interaction did not include a full Discord message",
        status: "ignored",
        username: interaction.user.username,
      });
      return;
    }

    const postCommitEffects: PostCommitEffect[] = [];
    let auditResult!: InteractionAuditResult;

    const release = await context.queueMutex.acquire();
    try {
      if (!context.surfaceRegistry.isInteractionAllowed(message.id, interaction.customId)) {
        auditResult = {
          reason: `stale interaction on message ${message.id}`,
          status: "ignored",
        };
      } else {
        const voteMatchSize = parseVoteMatchSizeCustomId(interaction.customId);
        if (voteMatchSize !== null) {
          const result = await this.handleMatchSizeVote(
            context,
            message,
            interaction.user.id,
            voteMatchSize,
            postCommitEffects
          );
          if (result.status === "processed") {
            postCommitEffects.push(() => this.refreshQueueSurface(context));
          }
          auditResult = {
            reason: result.reason,
            status: result.status,
          };
        } else {
          switch (interaction.customId) {
            case ButtonCustomID.JoinQueue: {
              const result = await joinQueue(context, interaction.user.id, interaction.user.username);
              if (result.players) {
                const players = result.players;
                postCommitEffects.push(() => this.refreshQueueSurface(context, players));
              }
              auditResult = {
                reason: result.reason,
                status: result.status,
              };
              break;
            }
            case ButtonCustomID.LeaveQueue: {
              const result = await leaveQueue(context, interaction.user.id);
              if (result.players) {
                const players = result.players;
                postCommitEffects.push(() => this.refreshQueueSurface(context, players));
              }
              auditResult = {
                reason: result.reason,
                status: result.status,
              };
              break;
            }
            case ButtonCustomID.ChooseTeam:
            case ButtonCustomID.CreateRandomTeam: {
              auditResult = await this.handleCaptainsOrRandomVote(
                context,
                interaction.customId,
                message,
                interaction.user.id,
                postCommitEffects
              );
              break;
            }
            case ButtonCustomID.ReportBlue: {
              auditResult = await this.handleMatchReport(context, interaction, Team.Blue, postCommitEffects);
              break;
            }
            case ButtonCustomID.ReportOrange: {
              auditResult = await this.handleMatchReport(context, interaction, Team.Orange, postCommitEffects);
              break;
            }
            case ButtonCustomID.BrokenQueue: {
              auditResult = await this.handleBrokenQueueVote(context, interaction, postCommitEffects);
              break;
            }
            default:
              auditResult = {
                reason: "button action is not recognized by the runtime",
                status: "ignored",
              };
              break;
          }
        }
      }
    } finally {
      release();
    }

    try {
      await this.runPostCommitEffects(postCommitEffects);
    } finally {
      logInteractionAudit({
        action,
        guildId: context.guildId,
        guildName: context.guildName,
        reason: auditResult.reason,
        status: auditResult.status,
        username: interaction.user.username,
      });
    }
  }

  async handleSelectMenuInteraction(context: GuildContext, interaction: StringSelectMenuInteraction): Promise<void> {
    const message = interaction.message;
    if (!(message instanceof Message)) return;

    const postCommitEffects: PostCommitEffect[] = [];
    const release = await context.queueMutex.acquire();
    try {
      if (!context.surfaceRegistry.isInteractionAllowed(message.id, interaction.customId, interaction.values)) {
        console.info(
          `[${this.formatGuildLogLabel(context.guildId, context.guildName)}] ` +
            `Ignoring stale select interaction ${interaction.customId} on message ${message.id}.`
        );
      } else {
        switch (interaction.customId) {
          case MenuCustomID.BlueSelect: {
            const currentDraftStep = getCurrentCaptainDraftStep(context);
            if (!currentDraftStep || currentDraftStep.team !== Team.Blue) break;

            const isCaptain = await context.repositories.queue.isTeamCaptain(interaction.user.id, Team.Blue);
            if (!isCaptain && !isDevEnvironment()) break;
            if (interaction.values.length !== currentDraftStep.picks) break;

            await assignPlayersToTeam(context, interaction.values, Team.Blue);
            context.voteState.captainDraftStepIndex += 1;
            if (isCaptainDraftComplete(context)) {
              await autoAssignRemainingDraftPlayers(context);
              const activeMatch = await createMatchFromChosenTeams(context);
              resetVoteState(context);
              postCommitEffects.push(() => this.publishActiveMatch(context, message, activeMatch));
              postCommitEffects.push(() => this.refreshQueueSurface(context));
            } else {
              postCommitEffects.push(() => this.refreshQueueSurface(context));
            }
            break;
          }
          case MenuCustomID.OrangeSelect: {
            const currentDraftStep = getCurrentCaptainDraftStep(context);
            if (!currentDraftStep || currentDraftStep.team !== Team.Orange) break;

            const isCaptain = await context.repositories.queue.isTeamCaptain(interaction.user.id, Team.Orange);
            if (!isCaptain && !isDevEnvironment()) break;
            if (interaction.values.length !== currentDraftStep.picks) break;

            await assignPlayersToTeam(context, interaction.values, Team.Orange);
            context.voteState.captainDraftStepIndex += 1;
            if (isCaptainDraftComplete(context)) {
              await autoAssignRemainingDraftPlayers(context);
              const activeMatch = await createMatchFromChosenTeams(context);
              resetVoteState(context);
              postCommitEffects.push(() => this.publishActiveMatch(context, message, activeMatch));
              postCommitEffects.push(() => this.refreshQueueSurface(context));
            } else {
              postCommitEffects.push(() => this.refreshQueueSurface(context));
            }
            break;
          }
        }
      }
    } finally {
      release();
    }

    await this.runPostCommitEffects(postCommitEffects);
  }

  private async handleBrokenQueueVote(
    context: GuildContext,
    interaction: ButtonInteraction,
    postCommitEffects: PostCommitEffect[]
  ): Promise<InteractionAuditResult> {
    const message = interaction.message;
    if (!(message instanceof Message)) {
      return {
        reason: "interaction did not include a full Discord message",
        status: "ignored",
      };
    }

    const playerInMatch = await context.repositories.activeMatch.isPlayerInActiveMatch(interaction.user.id);
    if (!playerInMatch) {
      return {
        reason: "user is not part of the active match",
        status: "ignored",
      };
    }

    const playerVoting = await context.repositories.activeMatch.getPlayerInActiveMatch(interaction.user.id);
    if (!playerVoting) {
      return {
        reason: "active match state could not find the player",
        status: "ignored",
      };
    }

    const vote = playerVoting?.brokenQueue === false;
    await context.repositories.activeMatch.updatePlayerInActiveMatch(interaction.user.id, {
      brokenQueue: vote,
    });

    const brokenQueueVotes = await context.repositories.activeMatch.getAllBrokenQueueVotesInActiveMatch(
      interaction.user.id
    );
    if (brokenQueueVotes >= 4) {
      context.surfaceRegistry.close(message.id, "match");
      await context.repositories.activeMatch.removeAllPlayersInActiveMatch(interaction.user.id);
      postCommitEffects.push(() => this.deleteMatchSurface(context, message));
      return {
        reason: "broken queue vote reached threshold and cancelled the match",
        status: "processed",
      };
    }

    const teams = await context.repositories.activeMatch.getAllBrokenQueueVotersInActiveMatch(interaction.user.id);
    const currentMatch = await getActiveMatch(context, interaction.user.id);
    const event = await context.repositories.event.getCurrentEvent();
    const payload = await MessageBuilder.voteBrokenQueueMessage(currentMatch, teams, brokenQueueVotes, event.mmrMult);

    postCommitEffects.push(() => this.editMatchSurface(context, message, payload));

    return {
      reason: vote ? "recorded broken queue vote" : "removed broken queue vote",
      status: "processed",
    };
  }

  private async handleCaptainsOrRandomVote(
    context: GuildContext,
    customId: ButtonCustomID.ChooseTeam | ButtonCustomID.CreateRandomTeam,
    sourceMessage: Message,
    userId: string,
    postCommitEffects: PostCommitEffect[]
  ): Promise<InteractionAuditResult> {
    const playerInQueue = await context.repositories.queue.isPlayerInQueue(userId);
    if (!playerInQueue) {
      return {
        reason: "user is not currently in the queue",
        status: "ignored",
      };
    }

    const queue = await context.repositories.queue.getAllBallChasersInQueue();
    const target = getQueueTargetSize(context.voteState.selectedMatchSize, context.config.enabledMatchSizes);
    if (queue.length !== target) {
      return {
        reason: `queue is not ready for voting (${queue.length}/${target})`,
        status: "ignored",
      };
    }

    context.voteState.captainsRandomVotes.set(userId, customId);
    const { captains, random } = countCaptainsRandomVotes(context.voteState.captainsRandomVotes);
    const threshold = getCaptainsRandomVoteThreshold(queue.length);

    if (captains === threshold) {
      await setCaptains(context, queue);
      context.voteState.captainDraftStepIndex = 0;
      postCommitEffects.push(() => this.refreshQueueSurface(context));
      return {
        reason: "captains vote reached threshold",
        status: "processed",
      };
    }

    if (random === threshold) {
      const activeMatch = await createRandomMatch(context);
      resetVoteState(context);
      postCommitEffects.push(() => this.publishActiveMatch(context, sourceMessage, activeMatch));
      postCommitEffects.push(() => this.refreshQueueSurface(context));
      return {
        reason: "random teams vote reached threshold",
        status: "processed",
      };
    }

    postCommitEffects.push(() => this.refreshQueueSurface(context));
    return {
      reason: customId === ButtonCustomID.ChooseTeam ? "recorded captains vote" : "recorded random teams vote",
      status: "processed",
    };
  }

  private async handleMatchSizeVote(
    context: GuildContext,
    sourceMessage: Message,
    userId: string,
    requestedMatchSize: number,
    postCommitEffects: PostCommitEffect[]
  ): Promise<InteractionAuditResult> {
    const ballChasers = await context.repositories.queue.getAllBallChasersInQueue();
    const voteMatchSize = getLowerTierVoteMatchSize(
      ballChasers.length,
      context.config.enabledMatchSizes,
      context.voteState.selectedMatchSize
    );

    if (voteMatchSize === null || voteMatchSize !== requestedMatchSize) {
      return {
        reason: `${formatMatchSizeLabel(requestedMatchSize)} voting is unavailable at the current queue size`,
        status: "ignored",
      };
    }
    if (!ballChasers.some((player) => player.id === userId)) {
      return {
        reason: "user is not currently in the queue",
        status: "ignored",
      };
    }

    context.voteState.sizeVotes.set(userId, requestedMatchSize);
    let reason = `recorded ${formatMatchSizeLabel(requestedMatchSize)} vote`;
    if (countMatchSizeVotes(context.voteState.sizeVotes, requestedMatchSize) >= ballChasers.length) {
      context.voteState.selectedMatchSize = requestedMatchSize;
      context.voteState.sizeVotes.clear();
      context.voteState.captainsRandomVotes.clear();
      context.voteState.captainDraftStepIndex = 0;

      if (requestedMatchSize === 1) {
        const activeMatch = await createOneVOneMatch(context);
        resetVoteState(context);
        postCommitEffects.push(() => this.publishActiveMatch(context, sourceMessage, activeMatch));
        reason = "1v1 vote reached threshold and started the match";
      } else {
        reason = `${formatMatchSizeLabel(requestedMatchSize)} vote reached threshold and selected the queue size`;
      }
    }

    return {
      reason,
      status: "processed",
    };
  }

  private async handleMatchReport(
    context: GuildContext,
    interaction: ButtonInteraction,
    team: Team,
    postCommitEffects: PostCommitEffect[]
  ): Promise<InteractionAuditResult> {
    const message = interaction.message;
    if (!(message instanceof Message)) {
      return {
        reason: "interaction did not include a full Discord message",
        status: "ignored",
      };
    }

    const playerInMatch = await context.repositories.activeMatch.isPlayerInActiveMatch(interaction.user.id);
    if (!playerInMatch) {
      return {
        reason: "user is not part of the active match",
        status: "ignored",
      };
    }

    const reportResolution = await checkReport(context, team, interaction.user.id);
    if (reportResolution.kind === "confirm") {
      context.surfaceRegistry.close(message.id, "match");
      postCommitEffects.push(() => this.deleteMatchSurface(context, message));
      postCommitEffects.push(() => this.refreshLeaderboard(context));
      return {
        reason: `confirmed ${team === Team.Blue ? "blue" : "orange"} team match result`,
        status: "processed",
      };
    }

    if (reportResolution.kind === "ignore") {
      return {
        reason: "matching report from the same team is already recorded",
        status: "ignored",
      };
    }

    const previousEmbed = message.embeds[0];
    const payload = MessageBuilder.reportedTeamButtons(interaction, EmbedBuilder.from(previousEmbed));
    postCommitEffects.push(() => this.editMatchSurface(context, message, payload));

    return {
      reason: `recorded ${team === Team.Blue ? "blue" : "orange"} team match report`,
      status: "processed",
    };
  }

  private async publishActiveMatch(
    context: GuildContext,
    sourceMessage: Message,
    activeMatch: ActiveMatchCreated
  ): Promise<void> {
    const event = await context.repositories.event.getCurrentEvent();
    const payload = await MessageBuilder.activeMatchMessage(activeMatch, event.mmrMult);
    void this.scheduler
      .enqueue(async () => await sourceMessage.reply(payload), {
        label: "match-send",
        priority: "normal",
        rateLimitKey: getMessageReplyLane(sourceMessage),
      })
      .then((activeMatchMessage) => {
        if (activeMatchMessage) {
          context.surfaceRegistry.upsert(activeMatchMessage.id, "match", matchSurfaceState());
        }
      })
      .catch((error) => {
        console.error(
          `[${this.formatGuildLogLabel(context.guildId, context.guildName)}] Failed to publish active match message:`,
          error
        );
      });
  }

  private async runPostCommitEffects(effects: PostCommitEffect[]): Promise<void> {
    for (const effect of effects) {
      await effect();
    }
  }

  private editMatchSurface(
    context: GuildContext,
    message: Message,
    payload: Parameters<Message["edit"]>[0]
  ): void {
    const key = this.getMatchRenderKey(context.guildId, message.id);
    const fingerprint = fingerprintDiscordPayload(payload);
    if (context.surfaceRegistry.get(message.id) && !this.shouldRequestCollapsedRender(key, fingerprint)) {
      return;
    }

    const revision = context.surfaceRegistry.upsert(message.id, "match", matchSurfaceState());
    this.requestCollapsedRender(key, fingerprint, async (version, dispatchId) => {
      const edited = await this.scheduler.enqueue(async () => await message.edit(payload), {
        coalesce: "replace",
        dedupeKey: `message-edit:${message.id}`,
        label: "match-edit",
        onRateLimit: ({ global, retryAfterMs }) =>
          this.handleHotSurfaceRateLimit(key, version, dispatchId, retryAfterMs, global),
        priority: "normal",
        rateLimitKey: getMessageEditLane(message.id),
        shouldRun: () =>
          context.surfaceRegistry.hasRevision(message.id, revision) && this.isRenderVersionCurrent(key, version),
      });
      return edited !== undefined;
    });
  }

  private async deleteMatchSurface(context: GuildContext, message: Message): Promise<void> {
    this.cancelCollapsedRender(this.getMatchRenderKey(context.guildId, message.id));

    await this.scheduler.enqueue(async () => await message.delete(), {
      coalesce: "replace",
      dedupeKey: `message-delete:${message.id}`,
      label: "match-delete",
      priority: "normal",
      rateLimitKey: getMessageDeleteLane(message.id),
    });
  }

  private getMatchRenderKey(guildId: string, messageId: string): string {
    return `match:${guildId}:${messageId}`;
  }

  private getQueueRenderKey(guildId: string): string {
    return `queue:${guildId}`;
  }

  private requestCollapsedRender(
    key: string,
    fingerprint: string,
    render: (version: number, dispatchId: number) => Promise<boolean>
  ): boolean {
    const coordinator = this.getOrCreateRenderCoordinator(key);
    if (!this.shouldRequestCollapsedRenderForCoordinator(coordinator, fingerprint)) {
      return false;
    }

    coordinator.latestVersion += 1;
    coordinator.latestFingerprint = fingerprint;
    coordinator.render = render;
    this.armCollapsedRender(key);
    return true;
  }

  private shouldRequestCollapsedRender(key: string, fingerprint: string): boolean {
    const coordinator = this.renderCoordinators.get(key);
    return !coordinator || this.shouldRequestCollapsedRenderForCoordinator(coordinator, fingerprint);
  }

  private shouldRequestCollapsedRenderForCoordinator(
    coordinator: RenderCoordinator,
    fingerprint: string
  ): boolean {
    if (
      coordinator.latestFingerprint === fingerprint &&
      coordinator.latestVersion > coordinator.lastSuccessfulVersion
    ) {
      return false;
    }

    return !(
      coordinator.lastSuccessfulFingerprint === fingerprint &&
      coordinator.latestVersion <= coordinator.lastSuccessfulVersion &&
      coordinator.pendingDispatchId === null &&
      !coordinator.scheduledTimer
    );
  }

  private getOrCreateRenderCoordinator(key: string): RenderCoordinator {
    const existing = this.renderCoordinators.get(key);
    if (existing) {
      return existing;
    }

    const created: RenderCoordinator = {
      lastSuccessfulFingerprint: null,
      lastSuccessfulRenderAt: null,
      lastSuccessfulVersion: 0,
      latestFingerprint: null,
      latestVersion: 0,
      nextDispatchId: 1,
      pendingDispatchId: null,
      pendingVersion: null,
      render: null,
      scheduledTimer: null,
    };
    this.renderCoordinators.set(key, created);
    return created;
  }

  private armCollapsedRender(key: string): void {
    const coordinator = this.renderCoordinators.get(key);
    if (!coordinator) {
      return;
    }

    if (!coordinator.render) {
      return;
    }

    if (coordinator.pendingDispatchId !== null || coordinator.latestVersion <= coordinator.lastSuccessfulVersion) {
      this.clearScheduledRender(coordinator);
      this.cleanupRenderCoordinator(key);
      return;
    }

    if (
      coordinator.latestFingerprint !== null &&
      coordinator.latestFingerprint === coordinator.lastSuccessfulFingerprint
    ) {
      coordinator.lastSuccessfulVersion = Math.max(coordinator.lastSuccessfulVersion, coordinator.latestVersion);
      this.clearScheduledRender(coordinator);
      this.cleanupRenderCoordinator(key);
      return;
    }

    const nextAllowedRenderAt =
      coordinator.lastSuccessfulRenderAt === null
        ? 0
        : coordinator.lastSuccessfulRenderAt + GuildRuntimeManager.HOT_SURFACE_RENDER_INTERVAL_MS;
    if (nextAllowedRenderAt <= Date.now()) {
      this.dispatchCollapsedRender(key);
      return;
    }

    this.scheduleRenderAt(key, nextAllowedRenderAt);
  }

  private scheduleRenderAt(key: string, runAt: number): void {
    const coordinator = this.renderCoordinators.get(key);
    if (!coordinator) {
      return;
    }

    this.clearScheduledRender(coordinator);

    coordinator.scheduledTimer = setTimeout(
      () => {
        const currentCoordinator = this.renderCoordinators.get(key);
        if (!currentCoordinator) {
          return;
        }

        currentCoordinator.scheduledTimer = null;
        this.dispatchCollapsedRender(key);
      },
      Math.max(0, runAt - Date.now())
    );
    coordinator.scheduledTimer.unref?.();
  }

  private dispatchCollapsedRender(key: string): void {
    const coordinator = this.renderCoordinators.get(key);
    if (!coordinator) {
      return;
    }

    this.clearScheduledRender(coordinator);

    if (!coordinator.render || coordinator.pendingDispatchId !== null) {
      this.cleanupRenderCoordinator(key);
      return;
    }

    if (coordinator.latestVersion <= coordinator.lastSuccessfulVersion) {
      this.cleanupRenderCoordinator(key);
      return;
    }

    if (
      coordinator.latestFingerprint !== null &&
      coordinator.latestFingerprint === coordinator.lastSuccessfulFingerprint
    ) {
      coordinator.lastSuccessfulVersion = Math.max(coordinator.lastSuccessfulVersion, coordinator.latestVersion);
      this.cleanupRenderCoordinator(key);
      return;
    }

    const nextAllowedRenderAt =
      coordinator.lastSuccessfulRenderAt === null
        ? 0
        : coordinator.lastSuccessfulRenderAt + GuildRuntimeManager.HOT_SURFACE_RENDER_INTERVAL_MS;
    if (nextAllowedRenderAt > Date.now()) {
      this.scheduleRenderAt(key, nextAllowedRenderAt);
      return;
    }

    const version = coordinator.latestVersion;
    const fingerprint = coordinator.latestFingerprint;
    const dispatchId = coordinator.nextDispatchId++;
    const render = coordinator.render;
    coordinator.pendingDispatchId = dispatchId;
    coordinator.pendingVersion = version;

    void render(version, dispatchId)
      .then((didRender) => {
        const currentCoordinator = this.renderCoordinators.get(key);
        if (!currentCoordinator) {
          return;
        }

        if (currentCoordinator.pendingDispatchId === dispatchId) {
          currentCoordinator.pendingDispatchId = null;
          currentCoordinator.pendingVersion = null;
        }

        if (!didRender) {
          if (currentCoordinator.latestVersion > version) {
            console.info(
              `[${this.formatRenderLogLabel(key)}] Superseded hot-surface render ` +
                `v${version} with newer v${currentCoordinator.latestVersion}.`
            );
          } else {
            console.info(
              `[${this.formatRenderLogLabel(key)}] Hot-surface render ` +
                `v${version} resolved without applying a visible edit.`
            );
          }
          this.armCollapsedRender(key);
          return;
        }

        currentCoordinator.lastSuccessfulFingerprint = fingerprint;
        currentCoordinator.lastSuccessfulRenderAt = Date.now();
        currentCoordinator.lastSuccessfulVersion = version;
        this.armCollapsedRender(key);
      })
      .catch((error) => {
        const currentCoordinator = this.renderCoordinators.get(key);
        if (currentCoordinator?.pendingDispatchId === dispatchId) {
          currentCoordinator.pendingDispatchId = null;
          currentCoordinator.pendingVersion = null;
        }
        console.error(`[${this.formatRenderLogLabel(key)}] Failed to flush Discord surface render:`, error);
        this.armCollapsedRender(key);
      });
  }

  private clearScheduledRender(coordinator: RenderCoordinator): void {
    if (!coordinator.scheduledTimer) {
      return;
    }

    clearTimeout(coordinator.scheduledTimer);
    coordinator.scheduledTimer = null;
  }

  private isRenderVersionCurrent(key: string, version: number): boolean {
    const coordinator = this.renderCoordinators.get(key);
    return coordinator?.latestVersion === version;
  }

  private handleHotSurfaceRateLimit(
    key: string,
    version: number,
    dispatchId: number,
    retryAfterMs: number,
    global: boolean
  ): void {
    const coordinator = this.renderCoordinators.get(key);
    if (!coordinator || coordinator.pendingDispatchId !== dispatchId) {
      return;
    }

    coordinator.pendingDispatchId = null;
    coordinator.pendingVersion = null;
    console.warn(
      `[${this.formatRenderLogLabel(key)}] Hot-surface render v${version} ` +
        `rate limited for ${retryAfterMs}ms${global ? " (global)" : ""}.`
    );
    if (coordinator.latestVersion > version) {
      this.armCollapsedRender(key);
    }
  }

  private cleanupRenderCoordinator(key: string): void {
    const coordinator = this.renderCoordinators.get(key);
    if (!coordinator) {
      return;
    }

    if (
      coordinator.scheduledTimer ||
      coordinator.pendingDispatchId !== null ||
      coordinator.latestVersion > coordinator.lastSuccessfulVersion ||
      coordinator.lastSuccessfulRenderAt !== null
    ) {
      return;
    }
    this.renderCoordinators.delete(key);
  }

  private cancelCollapsedRender(key: string): void {
    const coordinator = this.renderCoordinators.get(key);
    if (coordinator) {
      this.clearScheduledRender(coordinator);
    }
    this.renderCoordinators.delete(key);
  }

  private cancelRenderCoordinatorsForGuild(guildId: string): void {
    const queueKey = this.getQueueRenderKey(guildId);
    this.cancelCollapsedRender(queueKey);

    for (const key of this.renderCoordinators.keys()) {
      if (key.startsWith(`match:${guildId}:`)) {
        this.cancelCollapsedRender(key);
      }
    }
  }

  private clearStartupQueueSurfaceSnapshot(guildId: string): void {
    this.startupQueueSurfaceSnapshots.delete(guildId);
  }

  private async restoreStartupQueueSurfaceSnapshot(guildId: string): Promise<void> {
    const snapshot = this.startupQueueSurfaceSnapshots.get(guildId);
    if (!snapshot) {
      return;
    }

    this.startupQueueSurfaceSnapshots.delete(guildId);
    await this.scheduler.enqueue(async () => await snapshot.message.edit({ components: snapshot.components }), {
      coalesce: "replace",
      dedupeKey: `message-edit:${snapshot.message.id}`,
      label: `queue-startup-restore:${guildId}`,
      priority: "high",
      rateLimitKey: getMessageEditLane(snapshot.message.id),
    });
  }

  private async refreshLeaderboard(context: GuildContext): Promise<void> {
    const strings = await leaderboardToStrings(context);
    const payloads = MessageBuilder.leaderboardMessage(strings);
    context.leaderboardMessages = await reconcileTrackedMessages({
      channel: context.channels.leaderboardChannel,
      labelPrefix: `leaderboard:${context.guildId}`,
      payloads,
      priority: "low",
      scheduler: this.scheduler,
      trackedMessages: context.leaderboardMessages,
    });
    context.config = context.configStore.updateGuildRuntimeFields(context.guildId, {
      leaderboardMessageIds:
        context.leaderboardMessages.length > 0 ? context.leaderboardMessages.map((message) => message.id) : null,
    });
  }

  private async refreshQueueSurface(
    context: GuildContext,
    cachedPlayers?: ReadonlyArray<Readonly<PlayerInQueue>>
  ): Promise<void> {
    const render = await buildQueueRender(context, cachedPlayers);
    const existingQueueMessage = context.queueMessage;
    if (!existingQueueMessage) {
      await this.ensureQueueMessage(context, render);
      return;
    }

    const expectedMessageId = existingQueueMessage.id;
    const key = this.getQueueRenderKey(context.guildId);
    const fingerprint = fingerprintDiscordPayload(render.view);
    if (context.surfaceRegistry.get(existingQueueMessage.id) && !this.shouldRequestCollapsedRender(key, fingerprint)) {
      return;
    }

    const revision = context.surfaceRegistry.upsert(existingQueueMessage.id, "queue", render.surface);
    this.requestCollapsedRender(key, fingerprint, async (version, dispatchId) => {
      const currentQueueMessage = context.queueMessage;
      if (!currentQueueMessage) {
        await this.ensureQueueMessage(context, render);
        return false;
      }

      const currentMessageId = currentQueueMessage.id;
      const currentRevision =
        expectedMessageId === currentMessageId
          ? revision
          : context.surfaceRegistry.upsert(currentMessageId, "queue", render.surface);

      const edited = await this.scheduler.enqueue(async () => await currentQueueMessage.edit(render.view), {
        coalesce: "replace",
        dedupeKey: `message-edit:${currentMessageId}`,
        label: "queue-message-edit",
        onRateLimit: ({ global, retryAfterMs }) =>
          this.handleHotSurfaceRateLimit(key, version, dispatchId, retryAfterMs, global),
        priority: "normal",
        rateLimitKey: getMessageEditLane(currentMessageId),
        shouldRun: () =>
          context.surfaceRegistry.hasRevision(currentMessageId, currentRevision) &&
          this.isRenderVersionCurrent(key, version),
      });
      return edited !== undefined;
    });
  }

  private async ensureQueueMessage(context: GuildContext, render: QueueRender): Promise<void> {
    if (context.queueMessage) {
      return;
    }

    const existingCreate = this.queueMessageCreates.get(context.guildId);
    if (existingCreate) {
      await existingCreate;
      const currentQueueMessage = context.queueMessage as Message | null;
      if (currentQueueMessage) {
        const currentRevision = context.surfaceRegistry.upsert(currentQueueMessage.id, "queue", render.surface);
        const key = this.getQueueRenderKey(context.guildId);
        const fingerprint = fingerprintDiscordPayload(render.view);
        this.requestCollapsedRender(key, fingerprint, async (version, dispatchId) => {
          const latestQueueMessage = context.queueMessage as Message | null;
          if (!latestQueueMessage) {
            return false;
          }

          const edited = await this.scheduler.enqueue(async () => await latestQueueMessage.edit(render.view), {
            coalesce: "replace",
            dedupeKey: `message-edit:${latestQueueMessage.id}`,
            label: "queue-message-edit",
            onRateLimit: ({ global, retryAfterMs }) =>
              this.handleHotSurfaceRateLimit(key, version, dispatchId, retryAfterMs, global),
            priority: "normal",
            rateLimitKey: getMessageEditLane(latestQueueMessage.id),
            shouldRun: () =>
              context.surfaceRegistry.hasRevision(latestQueueMessage.id, currentRevision) &&
              this.isRenderVersionCurrent(key, version),
          });
          return edited !== undefined;
        });
      }
      return;
    }

    const createPromise = this.scheduler.enqueue(async () => await context.channels.queueChannel.send(render.view), {
      label: "queue-message-create",
      priority: "normal",
      rateLimitKey: getChannelSendLane(context.channels.queueChannel.id),
    });
    this.queueMessageCreates.set(context.guildId, createPromise);

    try {
      const queueMessage = await createPromise;
      if (!queueMessage) {
        throw new Error(`Failed to create queue message for guild ${context.guildId}.`);
      }

      context.queueMessage = queueMessage;
      context.config = context.configStore.updateGuildRuntimeFields(context.guildId, {
        queueMessageId: queueMessage.id,
      });
      context.surfaceRegistry.upsert(queueMessage.id, "queue", render.surface);
    } finally {
      if (this.queueMessageCreates.get(context.guildId) === createPromise) {
        this.queueMessageCreates.delete(context.guildId);
      }
    }
  }

  private startQueueTimer(context: GuildContext): void {
    const timer = setInterval(() => {
      void this.runQueueTimer(context);
    }, 60 * 1000);

    this.queueTimers.set(context.guildId, timer);
  }

  private async runQueueTimer(context: GuildContext): Promise<void> {
    let playersToRender: ReadonlyArray<Readonly<PlayerInQueue>> | null = null;
    const release = await context.queueMutex.acquire();
    try {
      const updatedList = await checkQueueTimes(context);
      if (updatedList) {
        resetVoteState(context);
        playersToRender = updatedList;
      } else {
        const queuedPlayers = await context.repositories.queue.getAllBallChasersInQueue();
        if (queuedPlayers.length > 0) {
          playersToRender = queuedPlayers;
        }
      }
    } catch (error) {
      console.error(
        `[${this.formatGuildLogLabel(context.guildId, context.guildName)}] Queue timer refresh failed:`,
        error
      );
    } finally {
      release();
    }

    if (playersToRender) {
      await this.refreshQueueSurface(context, playersToRender);
    }
  }
}

async function fetchTextChannel(client: Client, channelId: string): Promise<TextChannel> {
  const channel = await client.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error(`Channel ${channelId} is not a guild text channel.`);
  }
  return channel;
}

function matchSurfaceState(): ActiveSurfaceState {
  return {
    allowedActions: new Set<string>([
      ButtonCustomID.BrokenQueue,
      ButtonCustomID.ReportBlue,
      ButtonCustomID.ReportOrange,
    ]),
    state: "match_active",
  };
}

function getChannelSendLane(channelId: string): string {
  return `channel:${channelId}:send`;
}

function getMessageDeleteLane(messageId: string): string {
  return `message:${messageId}:delete`;
}

function getMessageEditLane(messageId: string): string {
  return `message:${messageId}:edit`;
}

function getMessageReplyLane(message: Message): string {
  return `channel:${message.channelId}:reply`;
}

function serializeMessageComponents(message: Message): MessageComponents {
  return message.components.map((component) => component.toJSON()) as MessageComponents;
}

function fingerprintDiscordPayload(payload: unknown): string {
  return JSON.stringify(normalizeDiscordPayload(payload));
}

function normalizeDiscordPayload(payload: unknown): unknown {
  if (payload === null || payload === undefined) {
    return payload;
  }

  if (typeof payload !== "object") {
    return payload;
  }

  if (typeof payload === "object" && "toJSON" in payload && typeof payload.toJSON === "function") {
    return normalizeDiscordPayload(payload.toJSON());
  }

  if (Array.isArray(payload)) {
    return payload.map((entry) => normalizeDiscordPayload(entry));
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload).sort(([left], [right]) => left.localeCompare(right))) {
    if (value === undefined || typeof value === "function") {
      continue;
    }

    normalized[key] = normalizeDiscordPayload(value);
  }

  return normalized;
}

function formatInteractionAuditTimestamp(now = DateTime.now()): string {
  return now.toFormat("MM-dd-yyyy hh:mm:ss");
}

function getMissingRequiredSetupFields(input: SetupConfigMergeInput): string[] {
  const missingFields: string[] = [];
  if (!input.queueChannelId) {
    missingFields.push("queue_channel");
  }
  if (!input.leaderboardChannelId) {
    missingFields.push("leaderboard_channel");
  }
  if (!input.databaseUrl) {
    missingFields.push("database_url");
  }
  return missingFields;
}

export function describeButtonInteractionAction(customId: string): string {
  const voteMatchSize = parseVoteMatchSizeCustomId(customId);
  if (voteMatchSize !== null) {
    return `Vote ${formatMatchSizeLabel(voteMatchSize)}`;
  }

  switch (customId) {
    case ButtonCustomID.JoinQueue:
      return "Join Queue";
    case ButtonCustomID.LeaveQueue:
      return "Leave Queue";
    case ButtonCustomID.ChooseTeam:
      return "Vote Captains";
    case ButtonCustomID.CreateRandomTeam:
      return "Vote Random Teams";
    case ButtonCustomID.ReportBlue:
      return "Report Blue Win";
    case ButtonCustomID.ReportOrange:
      return "Report Orange Win";
    case ButtonCustomID.BrokenQueue:
      return "Vote Broken Queue";
    default:
      return `Button:${customId}`;
  }
}

export function logInteractionAudit(entry: {
  action: string;
  guildId: string | null;
  guildName?: string;
  reason: string;
  status: InteractionAuditStatus;
  username: string;
}): void {
  const guildPrefix = entry.guildId ? `[${formatGuildLogLabel(entry.guildId, entry.guildName)}] ` : "";
  const statusLabel = entry.status === "ignored" ? "IGNORED" : "PROCESSED";
  console.info(
    `${guildPrefix}(${formatInteractionAuditTimestamp()}) | ${entry.username} | ` +
      `${entry.action} | ${statusLabel} | ${entry.reason}`
  );
}

function formatGuildLogLabel(guildId: string, guildName?: string): string {
  const normalizedGuildName = guildName?.trim();
  if (!normalizedGuildName) {
    return guildId;
  }

  return `${normalizedGuildName} (${guildId})`;
}

function isBotAdmin(interaction: ChatInputCommandInteraction): boolean {
  const memberRoles = interaction.member?.roles;
  if (!memberRoles) return false;

  if (Array.isArray(memberRoles)) {
    return memberRoles.includes("Bot Admin");
  }

  return memberRoles.cache.some((role) => role.name === "Bot Admin");
}

function isDevEnvironment(): boolean {
  return process.env["ENVIRONMENT"] === "dev";
}

function resetVoteState(context: GuildContext): void {
  context.voteState.captainsRandomVotes.clear();
  context.voteState.captainDraftStepIndex = 0;
  context.voteState.selectedMatchSize = null;
  context.voteState.sizeVotes.clear();
}

function getActiveQueueMatchSize(context: GuildContext): number {
  return context.voteState.selectedMatchSize ?? getHighestEnabledMatchSize(context.config.enabledMatchSizes);
}

function getCurrentCaptainDraftStep(context: GuildContext) {
  return getCaptainDraftSteps(getActiveQueueMatchSize(context))[context.voteState.captainDraftStepIndex] ?? null;
}

function isCaptainDraftComplete(context: GuildContext): boolean {
  return getCurrentCaptainDraftStep(context) === null;
}

async function autoAssignRemainingDraftPlayers(context: GuildContext): Promise<void> {
  const queue = await context.repositories.queue.getAllBallChasersInQueue();
  const unassignedPlayers = queue.filter((player) => player.team === null);
  if (unassignedPlayers.length === 0) {
    return;
  }

  const matchSize = getActiveQueueMatchSize(context);
  const blueCount = queue.filter((player) => player.team === Team.Blue).length;
  const teamToFill =
    blueCount < matchSize ? Team.Blue : Team.Orange;

  await assignPlayersToTeam(
    context,
    unassignedPlayers.map((player) => player.id),
    teamToFill
  );
}

function getSetupMatchSizeOptionName(matchSize: number): string {
  return `enable_${matchSize}v${matchSize}`;
}

function getSetupMatchSizeOverrides(interaction: ChatInputCommandInteraction): Map<number, boolean> {
  const overrides = new Map<number, boolean>();
  for (let matchSize = 1; matchSize <= 12; matchSize += 1) {
    const value = interaction.options.getBoolean(getSetupMatchSizeOptionName(matchSize));
    if (value !== null) {
      overrides.set(matchSize, value);
    }
  }

  return overrides;
}

function mergeEnabledMatchSizes(
  existingMatchSizes: ReadonlyArray<number> | undefined,
  overrides: ReadonlyMap<number, boolean>
): number[] {
  const merged = new Set<number>(
    normalizeEnabledMatchSizes(existingMatchSizes ?? [...DEFAULT_ENABLED_MATCH_SIZES])
  );

  for (const [matchSize, enabled] of overrides.entries()) {
    if (enabled) {
      merged.add(matchSize);
    } else {
      merged.delete(matchSize);
    }
  }

  return normalizeEnabledMatchSizes([...merged]);
}

function getVoterList<T>(
  players: ReadonlyArray<Readonly<PlayerInQueue>>,
  votes: ReadonlyMap<string, T>,
  expectedValue?: T
): PlayerInQueue[] {
  return players.filter((player): player is PlayerInQueue => {
    if (!votes.has(player.id)) {
      return false;
    }

    return expectedValue === undefined || votes.get(player.id) === expectedValue;
  });
}

async function buildQueueRender(
  context: GuildContext,
  cachedPlayers?: ReadonlyArray<Readonly<PlayerInQueue>>
): Promise<QueueRender> {
  const players = cachedPlayers ?? (await context.repositories.queue.getAllBallChasersInQueue());
  const unassignedPlayers = players.filter((player) => player.team === null);
  const captainCount = players.filter((player) => player.isCap).length;
  const activeMatchSize = getActiveQueueMatchSize(context);
  const currentDraftStep = getCurrentCaptainDraftStep(context);

  if (captainCount > 0 && unassignedPlayers.length > 0 && currentDraftStep) {
    const isBluePick = currentDraftStep.team === Team.Blue;
    return {
      players,
      surface: {
        allowedActions: new Set<string>([isBluePick ? MenuCustomID.BlueSelect : MenuCustomID.OrangeSelect]),
        allowedValues: new Set<string>(unassignedPlayers.map((player) => player.id)),
        state: isBluePick ? "captain_blue_pick" : "captain_orange_pick",
      },
      view: MessageBuilder.captainChooseMessage(currentDraftStep, players),
    };
  }

  const targetSize = getQueueTargetSize(context.voteState.selectedMatchSize, context.config.enabledMatchSizes);
  if (players.length >= targetSize) {
    const { captains, random } = countCaptainsRandomVotes(context.voteState.captainsRandomVotes);
    const voterList = getVoterList(players, context.voteState.captainsRandomVotes);
    return {
      players,
      surface: {
        allowedActions: new Set<string>([
          ButtonCustomID.LeaveQueue,
          ButtonCustomID.CreateRandomTeam,
          ButtonCustomID.ChooseTeam,
        ]),
        state: "queue_full",
      },
      view:
        captains > 0 || random > 0
          ? MessageBuilder.voteCaptainsOrRandomMessage(
              players,
              captains,
              random,
              voterList,
              context.voteState.captainsRandomVotes
            )
          : MessageBuilder.fullQueueMessage(players, activeMatchSize),
    };
  }

  const voteMatchSize = getLowerTierVoteMatchSize(
    players.length,
    context.config.enabledMatchSizes,
    context.voteState.selectedMatchSize
  );
  const allowedActions = new Set<string>([ButtonCustomID.JoinQueue, ButtonCustomID.LeaveQueue]);
  if (voteMatchSize !== null) {
    allowedActions.add(createVoteMatchSizeCustomId(voteMatchSize));
  }

  const matchSizeVotes = voteMatchSize === null ? 0 : countMatchSizeVotes(context.voteState.sizeVotes, voteMatchSize);
  const voterList =
    voteMatchSize === null ? [] : getVoterList(players, context.voteState.sizeVotes, voteMatchSize);
  return {
    players,
    surface: {
      allowedActions,
      state: "queue_open",
    },
    view:
      matchSizeVotes > 0 && voteMatchSize !== null
        ? MessageBuilder.voteMatchSizeMessage(
            players,
            voteMatchSize,
            matchSizeVotes,
            voterList,
            context.voteState.sizeVotes
          )
        : MessageBuilder.queueMessage(players, targetSize, voteMatchSize),
  };
}

async function joinQueue(
  context: GuildContext,
  userId: string,
  userName: string
): Promise<QueueInteractionAuditResult> {
  const activeMatchMember = await context.repositories.activeMatch.isPlayerInActiveMatch(userId);
  if (activeMatchMember) {
    return {
      players: null,
      reason: "user is already in an active match",
      status: "ignored",
    };
  }

  const queue = await context.repositories.queue.getAllBallChasersInQueue();
  const target = getQueueTargetSize(context.voteState.selectedMatchSize, context.config.enabledMatchSizes);
  const queueMember = await context.repositories.queue.getBallChaserInQueue(userId);

  if (!queueMember && queue.length >= target) {
    return {
      players: null,
      reason: `queue is already full (${target}/${target})`,
      status: "ignored",
    };
  }

  const queuePayload: AddBallChaserToQueueInput = {
    id: userId,
    name: userName,
    queueTime: DateTime.now().plus({ minutes: 60 }).set({ millisecond: 0, second: 0 }),
  };

  if (!queueMember) {
    await context.repositories.queue.addBallChaserToQueue(queuePayload);
  } else {
    await context.repositories.queue.updateBallChaserInQueue({
      id: userId,
      queueTime: queuePayload.queueTime,
    });
  }

  if (!queueMember) {
    resetVoteState(context);
  }

  return {
    players: await context.repositories.queue.getAllBallChasersInQueue(),
    reason: queueMember ? "refreshed queue timer" : "joined the queue",
    status: "processed",
  };
}

async function leaveQueue(context: GuildContext, userId: string): Promise<QueueInteractionAuditResult> {
  const playerInQueue = await context.repositories.queue.getBallChaserInQueue(userId);
  if (!playerInQueue) {
    return {
      players: null,
      reason: "user is not currently in the queue",
      status: "ignored",
    };
  }

  await context.repositories.queue.removeBallChaserFromQueue(userId);
  resetVoteState(context);
  return {
    players: await context.repositories.queue.getAllBallChasersInQueue(),
    reason: "left the queue",
    status: "processed",
  };
}

async function checkQueueTimes(context: GuildContext): Promise<ReadonlyArray<PlayerInQueue> | null> {
  const allPlayers = await context.repositories.queue.getAllBallChasersInQueue();
  const queueIsPopped = allPlayers.some((player) => player.isCap);
  const playersToRemove = allPlayers.filter((player) => player.queueTime.diffNow().as("minutes") <= 0);

  if (playersToRemove.length === 0 || queueIsPopped) {
    return null;
  }

  await waitForAllPromises(playersToRemove, async (player) => {
    await context.repositories.queue.removeBallChaserFromQueue(player.id);
  });

  return await context.repositories.queue.getAllBallChasersInQueue();
}

async function kickPlayerFromQueue(
  context: GuildContext,
  playerIdToRemove: string
): Promise<ReadonlyArray<PlayerInQueue>> {
  const playersInQueue = await context.repositories.queue.getAllBallChasersInQueue();
  if (playersInQueue.length === 0) {
    throw new Error("Queue is empty, who are you trying to remove?");
  }
  if (playersInQueue.some((player) => player.isCap)) {
    throw new Error("Can't kick a player after captains have been chosen.");
  }

  const updatedList = await leaveQueue(context, playerIdToRemove);
  return updatedList.players ?? playersInQueue;
}

async function setCaptains(
  context: GuildContext,
  ballChasers: ReadonlyArray<PlayerInQueue>
): Promise<ReadonlyArray<PlayerInQueue>> {
  const { blueCaptainId, orangeCaptainId } = chooseCaptains(ballChasers);

  await Promise.all([
    context.repositories.queue.updateBallChaserInQueue({
      id: orangeCaptainId,
      isCap: true,
      team: Team.Orange,
    }),
    context.repositories.queue.updateBallChaserInQueue({
      id: blueCaptainId,
      isCap: true,
      team: Team.Blue,
    }),
  ]);

  return await context.repositories.queue.getAllBallChasersInQueue();
}

async function assignPlayersToTeam(context: GuildContext, chosenPlayers: string[], team: Team): Promise<void> {
  for (const playerId of chosenPlayers) {
    await context.repositories.queue.updateBallChaserInQueue({
      id: playerId,
      team,
    });
  }
}

async function startMatch(
  context: GuildContext,
  createdTeams: Array<NewActiveMatchInput>
): Promise<ActiveMatchCreated> {
  await Promise.all([
    context.repositories.activeMatch.addActiveMatch(createdTeams),
    context.repositories.queue.removeAllBallChasersFromQueue(),
  ]);

  const teams = await context.repositories.activeMatch.getAllPlayersInActiveMatch(createdTeams[0].id);
  const { blueProbabilityDecimal, orangeProbabilityDecimal } = calculateProbabilityDecimal(teams);

  return {
    blue: {
      mmrStake: calculateMMR(blueProbabilityDecimal),
      players: teams.blueTeam,
      winProbability: calculateProbability(blueProbabilityDecimal),
    },
    orange: {
      mmrStake: calculateMMR(orangeProbabilityDecimal),
      players: teams.orangeTeam,
      winProbability: calculateProbability(orangeProbabilityDecimal),
    },
  };
}

async function createRandomMatch(context: GuildContext): Promise<ActiveMatchCreated> {
  const ballChasers = await context.repositories.queue.getAllBallChasersInQueue();
  return await startMatch(context, createRandomTeams(ballChasers));
}

async function createOneVOneMatch(context: GuildContext): Promise<ActiveMatchCreated> {
  const ballChasers = await context.repositories.queue.getAllBallChasersInQueue();
  const players = ballChasers.slice(0, 2);
  const shuffle = Math.random() >= 0.5 ? players : players.slice().reverse();

  return await startMatch(context, [
    { id: shuffle[0]!.id, team: Team.Blue },
    { id: shuffle[1]!.id, team: Team.Orange },
  ]);
}

async function getActiveMatch(context: GuildContext, playerInMatchId: string): Promise<ActiveMatchCreated> {
  const teams = await context.repositories.activeMatch.getAllPlayersInActiveMatch(playerInMatchId);
  const { blueProbabilityDecimal, orangeProbabilityDecimal } = calculateProbabilityDecimal(teams);

  return {
    blue: {
      mmrStake: calculateMMR(blueProbabilityDecimal),
      players: teams.blueTeam,
      winProbability: calculateProbability(blueProbabilityDecimal),
    },
    orange: {
      mmrStake: calculateMMR(orangeProbabilityDecimal),
      players: teams.orangeTeam,
      winProbability: calculateProbability(orangeProbabilityDecimal),
    },
  };
}

async function createMatchFromChosenTeams(context: GuildContext): Promise<ActiveMatchCreated> {
  const createdTeams: NewActiveMatchInput[] = [];
  const ballchasers = await context.repositories.queue.getAllBallChasersInQueue();
  const sortedBallChasers = ballchasers.slice().sort((a, b) => (a.team ?? 100) - (b.team ?? 100));

  for (const player of sortedBallChasers) {
    if (player.team === null) {
      throw new Error("Cannot create a drafted match while players are still unassigned.");
    }

    createdTeams.push({ id: player.id, team: player.team });
  }

  return await startMatch(context, createdTeams);
}

async function checkReport(
  context: GuildContext,
  reportedTeam: Team,
  playerInMatchId: string
): Promise<ReturnType<typeof resolveMatchReport>> {
  const teams = await context.repositories.activeMatch.getAllPlayersInActiveMatch(playerInMatchId);
  const reportResolution = resolveMatchReport(teams, playerInMatchId, reportedTeam);

  switch (reportResolution.kind) {
    case "ignore":
      return reportResolution;
    case "record":
      await reportMatch(context, reportedTeam, reportResolution.reporter, teams);
      return reportResolution;
    case "confirm":
      await confirmMatch(context, reportedTeam, teams, playerInMatchId);
      return reportResolution;
  }
}

async function reportMatch(
  context: GuildContext,
  team: Team,
  reporter: PlayerInActiveMatch,
  teams: ActiveMatchTeams
): Promise<void> {
  await waitForAllPromises([...teams.blueTeam, ...teams.orangeTeam], async (player) => {
    await context.repositories.activeMatch.updatePlayerInActiveMatch(player.id, {
      reportedTeam: player.id === reporter.id ? team : null,
    });
  });
}

async function confirmMatch(
  context: GuildContext,
  winner: Team,
  teams: ActiveMatchTeams,
  playerInMatchId: string
): Promise<void> {
  const { blueProbabilityDecimal, orangeProbabilityDecimal } = calculateProbabilityDecimal(teams);
  const mmr = calculateMMR(winner === Team.Blue ? blueProbabilityDecimal : orangeProbabilityDecimal);
  const event = await context.repositories.event.getCurrentEvent();
  const updateStats: Array<{ id: string; losses?: number; mmr: number; wins?: number }> = [];

  await waitForAllPromises([...teams.blueTeam, ...teams.orangeTeam], async (player) => {
    const isPlayerOnWinningTeam = player.team === winner;
    const playerStats = await context.repositories.leaderboard.getPlayerStats(player.id);
    if (playerStats) {
      updateStats.push(
        isPlayerOnWinningTeam
          ? {
              id: player.id,
              mmr: playerStats.mmr + mmr * event.mmrMult,
              wins: playerStats.wins + 1,
            }
          : {
              id: player.id,
              losses: playerStats.losses + 1,
              mmr: playerStats.mmr - mmr,
            }
      );
    } else {
      updateStats.push(
        isPlayerOnWinningTeam
          ? {
              id: player.id,
              mmr: 100 + mmr * event.mmrMult,
              wins: 1,
            }
          : {
              id: player.id,
              losses: 1,
              mmr: 100 - mmr,
            }
      );
    }
  });

  await Promise.all([
    context.repositories.leaderboard.updatePlayersStats(updateStats),
    context.repositories.activeMatch.removeAllPlayersInActiveMatch(playerInMatchId),
  ]);
}

async function leaderboardToStrings(context: GuildContext): Promise<Array<string>> {
  const playersPerEmbed = 10;
  const allPlayers = await context.repositories.leaderboard.getPlayersStats();

  if (allPlayers.length === 0) {
    return ["Nothing to see here yet. Get queueing!"];
  }

  const result: Array<string> = [];
  for (let i = 0; i < allPlayers.length; i += playersPerEmbed) {
    const playersSegment = allPlayers.slice(i, i + playersPerEmbed);
    const segment = playersSegment.reduce((previous, player, index) => {
      return (
        previous +
        [
          `Rank: ${i + index + 1}`,
          `\tName: ${player.name}`,
          `\tMMR: ${player.mmr}`,
          `\tWins: ${player.wins}`,
          `\tLosses: ${player.losses}`,
          `\tMatches Played: ${player.matchesPlayed}`,
          `\tWin Perc: ${Math.round(player.winPerc * 100)}%`,
          "",
          "",
        ].join("\n")
      );
    }, "");
    result.push(segment);
  }

  return result;
}

function classifyGuildRuntimeFailure(error: unknown): GuildRuntimeLoadFailure {
  if (error instanceof GuildRuntimeInitializationError) {
    return {
      code: error.code,
      message: error.message,
    };
  }

  return {
    code: "unknown",
    message: toErrorMessage(error),
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "an unknown error occurred";
}
