import {
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
  countTwosVotes,
  createRandomTeams,
  getQueueTargetSize,
  resolveMatchReport,
} from "./sixMansRules";
import {
  ActiveMatchTeams,
  NewActiveMatchInput,
  PlayerInActiveMatch,
} from "../repositories/ActiveMatchRepository/types";
import { AddBallChaserToQueueInput, PlayerInQueue } from "../repositories/QueueRepository/types";
import { ActiveSurfaceState, GuildChannels, GuildConfigUpsertInput, GuildContext, GuildInstanceConfig } from "./types";

type QueueRender = {
  players: ReadonlyArray<Readonly<PlayerInQueue>>;
  surface: ActiveSurfaceState;
  view: Awaited<ReturnType<typeof MessageBuilder.activeMatchMessage>> | ReturnType<typeof MessageBuilder.queueMessage>;
};

type PostCommitEffect = () => Promise<void> | void;

type RenderCoordinator = {
  dirty: boolean;
  editBudgetTimestamps: number[];
  inFlight: boolean;
  nextAllowedRenderAt: number;
  render: (() => Promise<void>) | null;
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
  private static readonly HOT_SURFACE_EDIT_BUDGET_MAX_EDITS = 4;
  private static readonly HOT_SURFACE_EDIT_BUDGET_WINDOW_MS = 5000;

  private readonly contexts = new Map<string, GuildContext>();
  private readonly contextLoads = new Map<string, Promise<GuildContext | null>>();
  private readonly queueTimers = new Map<string, NodeJS.Timeout>();
  private readonly renderCoordinators = new Map<string, RenderCoordinator>();

  constructor(
    private readonly client: Client,
    private readonly openai: OpenAI,
    private readonly configStore: GuildConfigStore,
    private readonly scheduler: DiscordWorkScheduler,
    private readonly apiStatusRuntime?: ApiStatusRuntime,
    private readonly prismaStudioManager: PrismaStudioManager = new PrismaStudioManager(),
    private readonly prismaStudioAccessGate: PrismaStudioAccessGate = new PrismaStudioAccessGate()
  ) {}

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
    this.contextLoads.clear();

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
      return await existingLoad;
    }

    const configResult = this.configStore.getGuildConfigResult(guildId);
    if (!configResult) {
      return null;
    }

    if (configResult.error) {
      console.error(
        `[${guildId}] Failed to decrypt stored guild configuration. ` +
          "Check CONFIG_ENCRYPTION_KEY and config file integrity.",
        configResult.error
      );
      return null;
    }

    const config = configResult.config;
    if (!config || !config.enabled) {
      return null;
    }

    const load = this.loadContext(config).then((result) => result.context);
    this.contextLoads.set(guildId, load);
    try {
      return await load;
    } finally {
      this.contextLoads.delete(guildId);
    }
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
      if (!context.config.chatChannelId) {
        if (interaction.commandName === "norm") {
          logInteractionAudit({
            action: "/norm",
            guildId: interaction.guildId,
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
          reason: "forwarded to Norm handler",
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
      console.error(`[${interaction.guildId}] Failed to launch Prisma Studio:`, error);
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
        const config = this.configStore.getGuildConfig(interaction.guildId);
        if (!config) {
          await responder.edit("This guild has not been configured yet.");
          return;
        }

        await responder.edit(
          [
            `Guild: ${config.guildId}`,
            `Enabled: ${config.enabled}`,
            `Queue channel: ${config.queueChannelId}`,
            `Leaderboard channel: ${config.leaderboardChannelId}`,
            `Leaderboard messages: ${config.leaderboardMessageIds?.join(", ") ?? "not created yet"}`,
            `Chat channel: ${config.chatChannelId ?? "not configured; rerun /setup set"}`,
            `API status channel: ${config.apiStatusChannelId ?? "none"}`,
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
        const queueChannel = interaction.options.getChannel("queue_channel", true);
        const leaderboardChannel = interaction.options.getChannel("leaderboard_channel", true);
        const chatChannel = interaction.options.getChannel("chat_channel", true);
        const apiStatusChannel = interaction.options.getChannel("api_status_channel");
        const databaseUrl = interaction.options.getString("database_url", true);
        const conversationId = interaction.options.getString("conversation_id") ?? undefined;

        if (queueChannel.type !== ChannelType.GuildText) {
          await responder.edit("Queue channel must be a text channel.");
          return;
        }
        if (leaderboardChannel.type !== ChannelType.GuildText) {
          await responder.edit("Leaderboard channel must be a text channel.");
          return;
        }
        if (chatChannel.type !== ChannelType.GuildText) {
          await responder.edit("Chat channel must be a text channel.");
          return;
        }
        if (apiStatusChannel && apiStatusChannel.type !== ChannelType.GuildText) {
          await responder.edit("API status channel must be a text channel.");
          return;
        }

        const input: GuildConfigUpsertInput = {
          apiStatusChannelId: apiStatusChannel?.id,
          chatChannelId: chatChannel.id,
          databaseUrl,
          guildId: interaction.guildId,
          leaderboardChannelId: leaderboardChannel.id,
          openAiConversationId: conversationId,
          queueChannelId: queueChannel.id,
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
          `[${configResult.guildId}] Failed to decrypt stored guild configuration during startup.`,
          configResult.error
        );
        continue;
      }

      if (!configResult.config?.enabled) {
        continue;
      }

      await this.loadContext(configResult.config);
    }
  }

  async reloadContext(guildId: string): Promise<GuildRuntimeLoadFailure | null> {
    await this.teardownContext(guildId);
    this.contextLoads.delete(guildId);

    const configResult = this.configStore.getGuildConfigResult(guildId);
    if (!configResult) {
      return null;
    }

    if (configResult.error) {
      console.error(`[${guildId}] Failed to decrypt stored guild configuration during reload.`, configResult.error);
      return {
        code: "config",
        message: "stored configuration could not be decrypted",
      };
    }

    const config = configResult.config;
    if (!config || !config.enabled) {
      return null;
    }

    const result = await this.loadContext(config);
    return result.failure;
  }

  private async bootstrapContext(context: GuildContext): Promise<void> {
    const ensuredEvent = await context.repositories.event.ensureCurrentEvent();
    if (ensuredEvent.created) {
      console.info(
        `[${context.guildId}] No active event was found in the guild database. ` +
          `Created default event "${ensuredEvent.event.name}".`
      );
    }

    await this.refreshLeaderboard(context);
    await this.refreshQueueSurface(context);
    if (context.channels.apiStatusChannel) {
      await this.apiStatusRuntime?.registerGuild(context.guildId, context.channels.apiStatusChannel);
    } else {
      this.apiStatusRuntime?.unregisterGuild(context.guildId);
    }
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
        captainsRandomVotes: new Map<string, string>(),
        twosEnabled: false,
        twosVotes: new Map<string, string>(),
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
      console.warn(`[${config.guildId}] Stored queue message ${config.queueMessageId} no longer exists; recreating.`);
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
        console.warn(`[${config.guildId}] Stored leaderboard message ${messageId} no longer exists; recreating.`);
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
      console.error(`[${config.guildId}] Failed to initialize guild runtime: ${failure.message}`, error);
      this.apiStatusRuntime?.unregisterGuild(config.guildId);
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

    const queueRenderCoordinator = this.renderCoordinators.get(this.getQueueRenderKey(guildId));
    if (queueRenderCoordinator?.scheduledTimer) {
      clearTimeout(queueRenderCoordinator.scheduledTimer);
    }
    this.renderCoordinators.delete(this.getQueueRenderKey(guildId));

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
          case ButtonCustomID.Twos: {
            const result = await this.handleTwosVote(context, interaction.user.id);
            if (result.status === "processed") {
              postCommitEffects.push(() => this.refreshQueueSurface(context));
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
    } finally {
      release();
    }

    try {
      await this.runPostCommitEffects(postCommitEffects);
    } finally {
      logInteractionAudit({
        action,
        guildId: context.guildId,
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
          `[${context.guildId}] Ignoring stale select interaction ${interaction.customId} on message ${message.id}.`
        );
      } else {
        switch (interaction.customId) {
          case MenuCustomID.BlueSelect: {
            const isCaptain = await context.repositories.queue.isTeamCaptain(interaction.user.id, Team.Blue);
            if (!isCaptain && !isDevEnvironment()) break;

            const playersLeft = await bluePlayerChosen(context, interaction.values[0]);
            if (context.voteState.twosEnabled) {
              const activeMatch = await createMatchFromChosenTeams(context);
              resetVoteState(context);
              postCommitEffects.push(() => this.publishActiveMatch(context, message, activeMatch));
            } else {
              postCommitEffects.push(() => this.refreshQueueSurface(context, playersLeft));
            }
            break;
          }
          case MenuCustomID.OrangeSelect: {
            const isCaptain = await context.repositories.queue.isTeamCaptain(interaction.user.id, Team.Orange);
            if (!isCaptain && !isDevEnvironment()) break;

            await orangePlayerChosen(context, interaction.values);
            const activeMatch = await createMatchFromChosenTeams(context);
            resetVoteState(context);
            postCommitEffects.push(() => this.publishActiveMatch(context, message, activeMatch));
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
      postCommitEffects.push(() => this.deleteMatchSurface(message));
      return {
        reason: "broken queue vote reached threshold and cancelled the match",
        status: "processed",
      };
    }

    const teams = await context.repositories.activeMatch.getAllBrokenQueueVotersInActiveMatch(interaction.user.id);
    const currentMatch = await getActiveMatch(context, interaction.user.id);
    const event = await context.repositories.event.getCurrentEvent();
    const revision = context.surfaceRegistry.upsert(message.id, "match", matchSurfaceState());
    const payload = await MessageBuilder.voteBrokenQueueMessage(currentMatch, teams, brokenQueueVotes, event.mmrMult);

    postCommitEffects.push(() => this.editMatchSurface(context, message, payload, revision));

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
    const target = getQueueTargetSize(context.voteState.twosEnabled);
    if (queue.length !== target) {
      return {
        reason: `queue is not ready for voting (${queue.length}/${target})`,
        status: "ignored",
      };
    }

    context.voteState.captainsRandomVotes.set(userId, customId);
    const { captains, random } = countCaptainsRandomVotes(context.voteState.captainsRandomVotes);
    const threshold = context.voteState.twosEnabled ? 3 : 4;

    if (captains === threshold) {
      await setCaptains(context, queue);
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
      return {
        reason: "random teams vote reached threshold",
        status: "processed",
      };
    }

    postCommitEffects.push(() => this.refreshQueueSurface(context));
    return {
      reason:
        customId === ButtonCustomID.ChooseTeam ? "recorded captains vote" : "recorded random teams vote",
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
      postCommitEffects.push(() => this.deleteMatchSurface(message));
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

    const revision = context.surfaceRegistry.upsert(message.id, "match", matchSurfaceState());
    const previousEmbed = message.embeds[0];
    const payload = MessageBuilder.reportedTeamButtons(interaction, EmbedBuilder.from(previousEmbed));
    postCommitEffects.push(() => this.editMatchSurface(context, message, payload, revision));

    return {
      reason: `recorded ${team === Team.Blue ? "blue" : "orange"} team match report`,
      status: "processed",
    };
  }

  private async handleTwosVote(context: GuildContext, userId: string): Promise<InteractionAuditResult> {
    const ballChasers = await context.repositories.queue.getAllBallChasersInQueue();
    if (ballChasers.length < 4) {
      return {
        reason: "2s voting is unavailable until at least 4 players are queued",
        status: "ignored",
      };
    }
    if (!ballChasers.some((player) => player.id === userId)) {
      return {
        reason: "user is not currently in the queue",
        status: "ignored",
      };
    }

    context.voteState.twosVotes.set(userId, ButtonCustomID.Twos);
    let reason = "recorded 2s vote";
    if (countTwosVotes(context.voteState.twosVotes) >= 4) {
      context.voteState.twosEnabled = true;
      context.voteState.captainsRandomVotes.clear();
      context.voteState.twosVotes.clear();
      reason = "2s vote reached threshold and enabled 2s queue";
    }
    return {
      reason,
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
        console.error(`[${context.guildId}] Failed to publish active match message:`, error);
      });

    this.refreshQueueSurface(context);
  }

  private async runPostCommitEffects(effects: PostCommitEffect[]): Promise<void> {
    for (const effect of effects) {
      await effect();
    }
  }

  private editMatchSurface(
    context: GuildContext,
    message: Message,
    payload: Parameters<Message["edit"]>[0],
    revision: number
  ): void {
    this.requestCollapsedRender(this.getMatchRenderKey(message.id), async () => {
      await this.scheduler.enqueue(async () => await message.edit(payload), {
        coalesce: "replace",
        dedupeKey: `message-edit:${message.id}`,
        label: "match-edit",
        priority: "normal",
        rateLimitKey: getMessageEditLane(message.id),
        shouldRun: () => context.surfaceRegistry.hasRevision(message.id, revision),
      });
    });
  }

  private async deleteMatchSurface(message: Message): Promise<void> {
    const coordinatorKey = this.getMatchRenderKey(message.id);
    const coordinator = this.renderCoordinators.get(coordinatorKey);
    if (coordinator?.scheduledTimer) {
      clearTimeout(coordinator.scheduledTimer);
    }
    this.renderCoordinators.delete(coordinatorKey);

    await this.scheduler.enqueue(async () => await message.delete(), {
      coalesce: "replace",
      dedupeKey: `message-delete:${message.id}`,
      label: "match-delete",
      priority: "normal",
      rateLimitKey: getMessageDeleteLane(message.id),
    });
  }

  private getMatchRenderKey(messageId: string): string {
    return `match:${messageId}`;
  }

  private getQueueRenderKey(guildId: string): string {
    return `queue:${guildId}`;
  }

  private requestCollapsedRender(key: string, render: () => Promise<void>): void {
    const coordinator = this.getOrCreateRenderCoordinator(key);
    coordinator.render = render;
    coordinator.dirty = true;
    this.maybeScheduleLatestRender(key);
  }

  private getOrCreateRenderCoordinator(key: string): RenderCoordinator {
    const existing = this.renderCoordinators.get(key);
    if (existing) {
      return existing;
    }

    const created: RenderCoordinator = {
      dirty: false,
      editBudgetTimestamps: [],
      inFlight: false,
      nextAllowedRenderAt: 0,
      render: null,
      scheduledTimer: null,
    };
    this.renderCoordinators.set(key, created);
    return created;
  }

  private scheduleRender(key: string, delayMs: number): void {
    const coordinator = this.renderCoordinators.get(key);
    if (!coordinator) {
      return;
    }

    if (coordinator.scheduledTimer) {
      clearTimeout(coordinator.scheduledTimer);
    }

    coordinator.scheduledTimer = setTimeout(() => {
      const currentCoordinator = this.renderCoordinators.get(key);
      if (!currentCoordinator) {
        return;
      }

      currentCoordinator.scheduledTimer = null;
      this.maybeScheduleLatestRender(key);
    }, delayMs);
    coordinator.scheduledTimer.unref?.();
  }

  private maybeScheduleLatestRender(key: string): void {
    const coordinator = this.renderCoordinators.get(key);
    if (!coordinator || !coordinator.dirty || !coordinator.render) {
      this.cleanupRenderCoordinator(key);
      return;
    }

    if (coordinator.inFlight) {
      return;
    }

    const now = Date.now();
    const readyAt = this.getEditBudgetReadyAt(coordinator, now);
    coordinator.nextAllowedRenderAt = readyAt;
    if (readyAt > now) {
      this.scheduleRender(key, readyAt - now);
      return;
    }

    this.startLatestRender(key);
  }

  private startLatestRender(key: string): void {
    const coordinator = this.renderCoordinators.get(key);
    if (!coordinator || coordinator.inFlight || !coordinator.render || !coordinator.dirty) {
      return;
    }

    const now = Date.now();
    const readyAt = this.getEditBudgetReadyAt(coordinator, now);
    coordinator.nextAllowedRenderAt = readyAt;
    if (readyAt > now) {
      this.scheduleRender(key, readyAt - now);
      return;
    }

    coordinator.inFlight = true;
    coordinator.nextAllowedRenderAt = now;
    coordinator.editBudgetTimestamps = this.pruneEditBudgetTimestamps(
      [...coordinator.editBudgetTimestamps, now],
      now
    );
    if (coordinator.scheduledTimer) {
      clearTimeout(coordinator.scheduledTimer);
      coordinator.scheduledTimer = null;
    }
    const render = coordinator.render;
    coordinator.dirty = false;

    void render()
      .catch((error) => {
        console.error(`[${key}] Failed to flush Discord surface render:`, error);
      })
      .finally(() => {
        const currentCoordinator = this.renderCoordinators.get(key);
        if (!currentCoordinator) {
          return;
        }

        currentCoordinator.inFlight = false;
        if (currentCoordinator.dirty) {
          this.maybeScheduleLatestRender(key);
          return;
        }

        this.cleanupRenderCoordinator(key);
      });
  }

  private cleanupRenderCoordinator(key: string): void {
    const coordinator = this.renderCoordinators.get(key);
    if (!coordinator) {
      return;
    }

    coordinator.editBudgetTimestamps = this.pruneEditBudgetTimestamps(coordinator.editBudgetTimestamps, Date.now());
    if (coordinator.inFlight || coordinator.dirty || coordinator.scheduledTimer) {
      return;
    }

    if (coordinator.editBudgetTimestamps.length > 0) {
      return;
    }

    this.renderCoordinators.delete(key);
  }

  private getEditBudgetReadyAt(coordinator: RenderCoordinator, now: number): number {
    coordinator.editBudgetTimestamps = this.pruneEditBudgetTimestamps(coordinator.editBudgetTimestamps, now);
    if (coordinator.editBudgetTimestamps.length < GuildRuntimeManager.HOT_SURFACE_EDIT_BUDGET_MAX_EDITS) {
      return now;
    }

    return coordinator.editBudgetTimestamps[0]! + GuildRuntimeManager.HOT_SURFACE_EDIT_BUDGET_WINDOW_MS;
  }

  private pruneEditBudgetTimestamps(timestamps: number[], now: number): number[] {
    const cutoff = now - GuildRuntimeManager.HOT_SURFACE_EDIT_BUDGET_WINDOW_MS;
    return timestamps.filter((timestamp) => timestamp > cutoff);
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
    const revision = existingQueueMessage
      ? context.surfaceRegistry.upsert(existingQueueMessage.id, "queue", render.surface)
      : null;

    this.requestCollapsedRender(this.getQueueRenderKey(context.guildId), async () => {
      if (!context.queueMessage) {
        const queueMessage = await this.scheduler.enqueue(
          async () => await context.channels.queueChannel.send(render.view),
          {
            label: "queue-message-create",
            priority: "normal",
            rateLimitKey: getChannelSendLane(context.channels.queueChannel.id),
          }
        );

        if (!queueMessage) {
          throw new Error(`Failed to create queue message for guild ${context.guildId}.`);
        }

        context.queueMessage = queueMessage;
        context.config = context.configStore.updateGuildRuntimeFields(context.guildId, {
          queueMessageId: queueMessage.id,
        });
        context.surfaceRegistry.upsert(queueMessage.id, "queue", render.surface);
        return;
      }

      const currentQueueMessage = context.queueMessage;
      const currentMessageId = currentQueueMessage.id;
      const currentRevision =
        existingQueueMessage && existingQueueMessage.id === currentMessageId && revision !== null
          ? revision
          : context.surfaceRegistry.upsert(currentMessageId, "queue", render.surface);

      await this.scheduler.enqueue(async () => await currentQueueMessage.edit(render.view), {
        coalesce: "replace",
        dedupeKey: `message-edit:${currentMessageId}`,
        label: "queue-message-edit",
        priority: "normal",
        rateLimitKey: getMessageEditLane(currentMessageId),
        shouldRun: () => context.surfaceRegistry.hasRevision(currentMessageId, currentRevision),
      });
    });
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
      console.error(`[${context.guildId}] Queue timer refresh failed:`, error);
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

function formatInteractionAuditTimestamp(now = DateTime.now()): string {
  return now.toFormat("MM-dd-yyyy hh:mm:ss");
}

export function describeButtonInteractionAction(customId: string): string {
  switch (customId) {
    case ButtonCustomID.JoinQueue:
      return "Join Queue";
    case ButtonCustomID.LeaveQueue:
      return "Leave Queue";
    case ButtonCustomID.Twos:
      return "Vote 2s";
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
  reason: string;
  status: InteractionAuditStatus;
  username: string;
}): void {
  const guildPrefix = entry.guildId ? `[${entry.guildId}] ` : "";
  const statusLabel = entry.status === "ignored" ? "IGNORED" : "PROCESSED";
  console.info(
    `${guildPrefix}(${formatInteractionAuditTimestamp()}) | ${entry.username} | ` +
      `${entry.action} | ${statusLabel} | ${entry.reason}`
  );
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
  context.voteState.twosVotes.clear();
  context.voteState.twosEnabled = false;
}

function getVoterList(players: ReadonlyArray<Readonly<PlayerInQueue>>, votes: Map<string, string>): PlayerInQueue[] {
  return players.filter((player): player is PlayerInQueue => votes.has(player.id));
}

async function buildQueueRender(
  context: GuildContext,
  cachedPlayers?: ReadonlyArray<Readonly<PlayerInQueue>>
): Promise<QueueRender> {
  const players = cachedPlayers ?? (await context.repositories.queue.getAllBallChasersInQueue());
  const unassignedPlayers = players.filter((player) => player.team === null);
  const captainCount = players.filter((player) => player.isCap).length;

  if (captainCount > 0 && unassignedPlayers.length > 0) {
    const isBluePick = context.voteState.twosEnabled ? unassignedPlayers.length === 2 : unassignedPlayers.length >= 4;
    return {
      players,
      surface: {
        allowedActions: new Set<string>([isBluePick ? MenuCustomID.BlueSelect : MenuCustomID.OrangeSelect]),
        allowedValues: new Set<string>(unassignedPlayers.map((player) => player.id)),
        state: isBluePick ? "captain_blue_pick" : "captain_orange_pick",
      },
      view: MessageBuilder.captainChooseMessage(isBluePick, players, context.voteState.twosEnabled),
    };
  }

  const targetSize = getQueueTargetSize(context.voteState.twosEnabled);
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
          : MessageBuilder.fullQueueMessage(players),
    };
  }

  const allowedActions = new Set<string>([ButtonCustomID.JoinQueue, ButtonCustomID.LeaveQueue]);
  if (players.length >= 4) {
    allowedActions.add(ButtonCustomID.Twos);
  }

  const twosVotes = countTwosVotes(context.voteState.twosVotes);
  const voterList = getVoterList(players, context.voteState.twosVotes);
  return {
    players,
    surface: {
      allowedActions,
      state: "queue_open",
    },
    view:
      twosVotes > 0 && players.length >= 4 && !context.voteState.twosEnabled
        ? MessageBuilder.vote2v2sMessage(players, twosVotes, voterList, context.voteState.twosVotes)
        : MessageBuilder.queueMessage(players),
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
  const target = getQueueTargetSize(context.voteState.twosEnabled);
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
    context.voteState.captainsRandomVotes.clear();
    context.voteState.twosVotes.clear();
    if (queue.length + 1 < 4) {
      context.voteState.twosEnabled = false;
    }
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

async function bluePlayerChosen(context: GuildContext, chosenPlayer: string): Promise<ReadonlyArray<PlayerInQueue>> {
  await context.repositories.queue.updateBallChaserInQueue({
    id: chosenPlayer,
    team: Team.Blue,
  });

  return await context.repositories.queue.getAllBallChasersInQueue();
}

async function orangePlayerChosen(context: GuildContext, chosenPlayers: string[]): Promise<void> {
  for (const playerId of chosenPlayers) {
    await context.repositories.queue.updateBallChaserInQueue({
      id: playerId,
      team: Team.Orange,
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
    if (player.team !== null) {
      createdTeams.push({ id: player.id, team: player.team });
    } else if (context.voteState.twosEnabled) {
      createdTeams.push({ id: player.id, team: Team.Orange });
    } else {
      createdTeams.push({ id: player.id, team: Team.Blue });
    }
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
