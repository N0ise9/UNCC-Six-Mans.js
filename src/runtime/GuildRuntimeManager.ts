import {
  ButtonInteraction,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  Message,
  PermissionFlagsBits,
  StringSelectMenuInteraction,
  TextChannel,
  VoiceBasedChannel,
} from "discord.js";
import { DateTime } from "luxon";
import OpenAI from "openai";
import { createPrismaClient } from "../prisma";
import AsyncMutex from "../utils/AsyncMutex";
import { waitForAllPromises } from "../utils";
import { ActiveMatchCreated } from "../domain/match";
import { handleEasterEggSlashInteraction, handleNormMessage } from "../controllers/EasterEggs";
import { Team } from "../types/common";
import MessageBuilder, { MenuCustomID } from "../utils/MessageHelper/MessageBuilder";
import { ButtonCustomID } from "../utils/MessageHelper/CustomButtons";
import { ApiStatusRuntime } from "./ApiStatusRuntime";
import { GuildConfigStore, maskSecret } from "./GuildConfigStore";
import { DiscordWorkScheduler } from "./DiscordWorkScheduler";
import { GuildRepositories } from "./GuildRepositories";
import { InteractiveSurfaceRegistry } from "./InteractiveSurfaceRegistry";
import { reconcileTrackedMessages } from "./reconcileTrackedMessages";
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

type GuildRuntimeFailureCode = "bootstrap" | "channels" | "config" | "database" | "unknown";

type GuildRuntimeLoadFailure = {
  code: GuildRuntimeFailureCode;
  message: string;
};

type GuildRuntimeLoadResult = {
  context: GuildContext | null;
  failure: GuildRuntimeLoadFailure | null;
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
  private readonly contexts = new Map<string, GuildContext>();
  private readonly contextLoads = new Map<string, Promise<GuildContext | null>>();
  private readonly queueTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly client: Client,
    private readonly openai: OpenAI,
    private readonly configStore: GuildConfigStore,
    private readonly scheduler: DiscordWorkScheduler,
    private readonly apiStatusRuntime?: ApiStatusRuntime
  ) {}

  async dispose(): Promise<void> {
    for (const timer of this.queueTimers.values()) {
      clearInterval(timer);
    }
    this.queueTimers.clear();
    this.contextLoads.clear();

    for (const context of this.contexts.values()) {
      this.apiStatusRuntime?.unregisterGuild(context.guildId);
      await context.prisma.$disconnect().catch(() => undefined);
    }
    this.contexts.clear();
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

  async handleMessage(message: Message): Promise<void> {
    if (!message.guildId || message.author.bot) return;

    const context = await this.ensureContext(message.guildId);
    if (!context || message.channelId !== context.config.chatChannelId) {
      return;
    }

    await handleNormMessage(context, message);
  }

  async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.reply({
        content: "This command only works inside a server.",
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === "setup") {
      await interaction.deferReply({ ephemeral: true });
      await this.handleSetupCommand(interaction);
      return;
    }

    const context = await this.ensureContext(interaction.guildId);
    if (!context) {
      const configResult = this.configStore.getGuildConfigResult(interaction.guildId);
      if (configResult?.error) {
        await interaction.reply({
          content:
            "This guild is configured, but I couldn't read its stored configuration. " +
            "Check CONFIG_ENCRYPTION_KEY and rerun /setup set.",
          ephemeral: true,
        });
        return;
      }

      if (configResult?.config?.enabled) {
        await interaction.reply({
          content:
            "This guild is configured, but the runtime failed to load. Check the configured channels " +
            "and database URL, then rerun /setup set.",
          ephemeral: true,
        });
        return;
      }

      await interaction.reply({
        content: "This guild has not been configured yet. Run /setup set first.",
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === "kick" || interaction.commandName === "clear") {
      await interaction.deferReply({ ephemeral: true });
      await this.handleAdminCommand(context, interaction);
      return;
    }

    if (interaction.commandName === "norm" || interaction.commandName === "sora") {
      await interaction.deferReply();
      await handleEasterEggSlashInteraction(context, interaction);
    }
  }

  async handleSetupCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guildId) {
      await interaction.editReply("This command only works inside a server.");
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.editReply("You need Manage Server permissions to run setup.");
      return;
    }

    switch (interaction.options.getSubcommand()) {
      case "show": {
        const config = this.configStore.getGuildConfig(interaction.guildId);
        if (!config) {
          await interaction.editReply("This guild has not been configured yet.");
          return;
        }

        await interaction.editReply(
          [
            `Guild: ${config.guildId}`,
            `Enabled: ${config.enabled}`,
            `Queue channel: ${config.queueChannelId}`,
            `Leaderboard channel: ${config.leaderboardChannelId}`,
            `Leaderboard messages: ${config.leaderboardMessageIds?.join(", ") ?? "not created yet"}`,
            `Chat channel: ${config.chatChannelId}`,
            `Voice channel: ${config.voiceChannelId}`,
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
        await interaction.editReply(config ? "Guild configuration disabled." : "No guild configuration was found.");
        return;
      }
      case "set": {
        const queueChannel = interaction.options.getChannel("queue_channel", true);
        const leaderboardChannel = interaction.options.getChannel("leaderboard_channel", true);
        const chatChannel = interaction.options.getChannel("chat_channel", true);
        const voiceChannel = interaction.options.getChannel("voice_channel", true);
        const apiStatusChannel = interaction.options.getChannel("api_status_channel");
        const databaseUrl = interaction.options.getString("database_url", true);
        const conversationId = interaction.options.getString("conversation_id") ?? undefined;

        if (queueChannel.type !== ChannelType.GuildText) {
          await interaction.editReply("Queue channel must be a text channel.");
          return;
        }
        if (leaderboardChannel.type !== ChannelType.GuildText) {
          await interaction.editReply("Leaderboard channel must be a text channel.");
          return;
        }
        if (chatChannel.type !== ChannelType.GuildText) {
          await interaction.editReply("Chat channel must be a text channel.");
          return;
        }
        if (voiceChannel.type !== ChannelType.GuildVoice && voiceChannel.type !== ChannelType.GuildStageVoice) {
          await interaction.editReply("Voice channel must be voice-based.");
          return;
        }
        if (apiStatusChannel && apiStatusChannel.type !== ChannelType.GuildText) {
          await interaction.editReply("API status channel must be a text channel.");
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
          voiceChannelId: voiceChannel.id,
        };

        this.configStore.setGuildConfig(input);
        const reloadFailure = await this.reloadContext(interaction.guildId);
        if (reloadFailure) {
          await interaction.editReply(
            `Guild configuration saved, but the runtime failed to load: ${reloadFailure.message}`
          );
          return;
        }

        await interaction.editReply("Guild configuration saved and runtime refreshed.");
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
      console.error(
        `[${guildId}] Failed to decrypt stored guild configuration during reload.`,
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

    const result = await this.loadContext(config);
    return result.failure;
  }

  private async bootstrapContext(context: GuildContext): Promise<void> {
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
    const chatChannel = await fetchTextChannel(this.client, config.chatChannelId);
    const voiceChannel = await fetchVoiceChannel(this.client, config.voiceChannelId);
    const apiStatusChannel = config.apiStatusChannelId
      ? await fetchTextChannel(this.client, config.apiStatusChannelId).catch(() => null)
      : null;

    return {
      apiStatusChannel,
      chatChannel,
      leaderboardChannel,
      queueChannel,
      voiceChannel,
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
    if (!isBotAdmin(interaction)) {
      await interaction.editReply(
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
            await interaction.editReply("No player was provided.");
            return;
          }

          await kickPlayerFromQueue(context, playerToRemove.id);
          await this.refreshQueueSurface(context);
          await interaction.editReply(`${playerToRemove.username} has been removed from the queue.`);
          return;
        }
        case "clear": {
          await context.repositories.queue.removeAllBallChasersFromQueue();
          resetVoteState(context);
          await this.refreshQueueSurface(context);
          await interaction.editReply("Queue has been cleared.");
          return;
        }
      }
    } finally {
      release();
    }
  }

  async handleButtonInteraction(context: GuildContext, interaction: ButtonInteraction): Promise<void> {
    const message = interaction.message;
    if (!(message instanceof Message)) return;

    const release = await context.queueMutex.acquire();
    try {
      if (!context.surfaceRegistry.isInteractionAllowed(message.id, interaction.customId)) {
        console.info(
          `[${context.guildId}] Ignoring stale button interaction ${interaction.customId} on message ${message.id}.`
        );
        return;
      }

      switch (interaction.customId) {
        case ButtonCustomID.JoinQueue: {
          const players = await joinQueue(context, interaction.user.id, interaction.user.username);
          if (!players) return;
          await this.refreshQueueSurface(context, players);
          return;
        }
        case ButtonCustomID.LeaveQueue: {
          const players = await leaveQueue(context, interaction.user.id);
          if (!players) return;
          await this.refreshQueueSurface(context, players);
          return;
        }
        case ButtonCustomID.Twos: {
          await this.handleTwosVote(context, interaction.user.id);
          return;
        }
        case ButtonCustomID.ChooseTeam:
        case ButtonCustomID.CreateRandomTeam: {
          await this.handleCaptainsOrRandomVote(context, interaction.customId, message, interaction.user.id);
          return;
        }
        case ButtonCustomID.ReportBlue: {
          await this.handleMatchReport(context, interaction, Team.Blue);
          return;
        }
        case ButtonCustomID.ReportOrange: {
          await this.handleMatchReport(context, interaction, Team.Orange);
          return;
        }
        case ButtonCustomID.BrokenQueue: {
          await this.handleBrokenQueueVote(context, interaction);
          return;
        }
      }
    } finally {
      release();
    }
  }

  async handleSelectMenuInteraction(context: GuildContext, interaction: StringSelectMenuInteraction): Promise<void> {
    const message = interaction.message;
    if (!(message instanceof Message)) return;

    const release = await context.queueMutex.acquire();
    try {
      if (!context.surfaceRegistry.isInteractionAllowed(message.id, interaction.customId, interaction.values)) {
        console.info(
          `[${context.guildId}] Ignoring stale select interaction ${interaction.customId} on message ${message.id}.`
        );
        return;
      }

      switch (interaction.customId) {
        case MenuCustomID.BlueSelect: {
          const isCaptain = await context.repositories.queue.isTeamCaptain(interaction.user.id, Team.Blue);
          if (!isCaptain && !isDevEnvironment()) return;

          const playersLeft = await bluePlayerChosen(context, interaction.values[0]);
          if (context.voteState.twosEnabled) {
            const activeMatch = await createMatchFromChosenTeams(context);
            await this.publishActiveMatch(context, message, activeMatch);
          } else {
            await this.refreshQueueSurface(context, playersLeft);
          }
          return;
        }
        case MenuCustomID.OrangeSelect: {
          const isCaptain = await context.repositories.queue.isTeamCaptain(interaction.user.id, Team.Orange);
          if (!isCaptain && !isDevEnvironment()) return;

          await orangePlayerChosen(context, interaction.values);
          const activeMatch = await createMatchFromChosenTeams(context);
          await this.publishActiveMatch(context, message, activeMatch);
          return;
        }
      }
    } finally {
      release();
    }
  }

  private async handleBrokenQueueVote(context: GuildContext, interaction: ButtonInteraction): Promise<void> {
    const message = interaction.message;
    if (!(message instanceof Message)) return;

    const playerInMatch = await context.repositories.activeMatch.isPlayerInActiveMatch(interaction.user.id);
    if (!playerInMatch) return;

    const playerVoting = await context.repositories.activeMatch.getPlayerInActiveMatch(interaction.user.id);
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
      await this.scheduler.enqueue(async () => await message.delete(), {
        label: "match-delete",
        priority: "normal",
      });
      return;
    }

    const teams = await context.repositories.activeMatch.getAllBrokenQueueVotersInActiveMatch(interaction.user.id);
    const currentMatch = await getActiveMatch(context, interaction.user.id);
    const event = await context.repositories.event.getCurrentEvent();
    const revision = context.surfaceRegistry.upsert(message.id, "match", matchSurfaceState());

    await this.scheduler.enqueue(
      async () =>
        await message.edit(
          await MessageBuilder.voteBrokenQueueMessage(currentMatch, teams, brokenQueueVotes, event.mmrMult)
        ),
      {
        coalesce: "replace",
        dedupeKey: `message-edit:${message.id}`,
        label: "match-edit",
        priority: "normal",
        shouldRun: () => context.surfaceRegistry.hasRevision(message.id, revision),
      }
    );
  }

  private async handleCaptainsOrRandomVote(
    context: GuildContext,
    customId: ButtonCustomID.ChooseTeam | ButtonCustomID.CreateRandomTeam,
    sourceMessage: Message,
    userId: string
  ): Promise<void> {
    const playerInQueue = await context.repositories.queue.isPlayerInQueue(userId);
    if (!playerInQueue) return;

    const queue = await context.repositories.queue.getAllBallChasersInQueue();
    const target = getQueueTargetSize(context);
    if (queue.length !== target) return;

    context.voteState.captainsRandomVotes.set(userId, customId);
    const { captains, random } = countCaptainsRandomVotes(context.voteState.captainsRandomVotes);
    const threshold = context.voteState.twosEnabled ? 3 : 4;

    if (captains === threshold) {
      await setCaptains(context, queue);
      await this.refreshQueueSurface(context);
      return;
    }

    if (random === threshold) {
      const activeMatch = await createRandomMatch(context);
      await this.publishActiveMatch(context, sourceMessage, activeMatch);
      return;
    }

    await this.refreshQueueSurface(context);
  }

  private async handleMatchReport(context: GuildContext, interaction: ButtonInteraction, team: Team): Promise<void> {
    const message = interaction.message;
    if (!(message instanceof Message)) return;

    const playerInMatch = await context.repositories.activeMatch.isPlayerInActiveMatch(interaction.user.id);
    if (!playerInMatch) return;

    const confirmed = await checkReport(context, team, interaction.user.id);
    if (confirmed) {
      context.surfaceRegistry.close(message.id, "match");
      await this.scheduler.enqueue(async () => await message.delete(), {
        label: "match-delete",
        priority: "normal",
      });
      await this.refreshLeaderboard(context);
      return;
    }

    const revision = context.surfaceRegistry.upsert(message.id, "match", matchSurfaceState());
    const previousEmbed = message.embeds[0];
    await this.scheduler.enqueue(
      async () => await message.edit(MessageBuilder.reportedTeamButtons(interaction, EmbedBuilder.from(previousEmbed))),
      {
        coalesce: "replace",
        dedupeKey: `message-edit:${message.id}`,
        label: "match-edit",
        priority: "normal",
        shouldRun: () => context.surfaceRegistry.hasRevision(message.id, revision),
      }
    );
  }

  private async handleTwosVote(context: GuildContext, userId: string): Promise<void> {
    const ballChasers = await context.repositories.queue.getAllBallChasersInQueue();
    if (ballChasers.length < 4) return;

    context.voteState.twosVotes.set(userId, ButtonCustomID.Twos);
    if (countTwosVotes(context.voteState.twosVotes) >= 4) {
      context.voteState.twosEnabled = true;
      context.voteState.captainsRandomVotes.clear();
      context.voteState.twosVotes.clear();
    }
    await this.refreshQueueSurface(context);
  }

  private async publishActiveMatch(
    context: GuildContext,
    sourceMessage: Message,
    activeMatch: ActiveMatchCreated
  ): Promise<void> {
    const event = await context.repositories.event.getCurrentEvent();
    const activeMatchMessage = await this.scheduler.enqueue(
      async () => await sourceMessage.reply(await MessageBuilder.activeMatchMessage(activeMatch, event.mmrMult)),
      {
        label: "match-send",
        priority: "normal",
      }
    );

    if (activeMatchMessage) {
      context.surfaceRegistry.upsert(activeMatchMessage.id, "match", matchSurfaceState());
    }

    resetVoteState(context);
    await this.refreshQueueSurface(context);
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

    if (!context.queueMessage) {
      const queueMessage = await this.scheduler.enqueue(
        async () => await context.channels.queueChannel.send(render.view),
        {
          label: "queue-message-create",
          priority: "normal",
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

    const revision = context.surfaceRegistry.upsert(context.queueMessage.id, "queue", render.surface);
    await this.scheduler.enqueue(async () => await context.queueMessage!.edit(render.view), {
      coalesce: "replace",
      dedupeKey: `message-edit:${context.queueMessage.id}`,
      label: "queue-message-edit",
      priority: "normal",
      shouldRun: () => context.surfaceRegistry.hasRevision(context.queueMessage!.id, revision),
    });
  }

  private startQueueTimer(context: GuildContext): void {
    const timer = setInterval(() => {
      void this.runQueueTimer(context);
    }, 60 * 1000);

    this.queueTimers.set(context.guildId, timer);
  }

  private async runQueueTimer(context: GuildContext): Promise<void> {
    const release = await context.queueMutex.acquire();
    try {
      const updatedList = await checkQueueTimes(context);
      if (!updatedList) return;
      resetVoteState(context);
      await this.refreshQueueSurface(context, updatedList);
    } catch (error) {
      console.error(`[${context.guildId}] Queue timer refresh failed:`, error);
    } finally {
      release();
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

async function fetchVoiceChannel(client: Client, channelId: string): Promise<VoiceBasedChannel> {
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isVoiceBased()) {
    throw new Error(`Channel ${channelId} is not voice-based.`);
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

function getQueueTargetSize(context: GuildContext): number {
  return context.voteState.twosEnabled ? 4 : 6;
}

function resetVoteState(context: GuildContext): void {
  context.voteState.captainsRandomVotes.clear();
  context.voteState.twosVotes.clear();
  context.voteState.twosEnabled = false;
}

function countCaptainsRandomVotes(votes: Map<string, string>): { captains: number; random: number } {
  let captains = 0;
  let random = 0;

  for (const value of votes.values()) {
    if (value === ButtonCustomID.ChooseTeam) captains += 1;
    if (value === ButtonCustomID.CreateRandomTeam) random += 1;
  }

  return {
    captains,
    random,
  };
}

function countTwosVotes(votes: Map<string, string>): number {
  let twos = 0;
  for (const value of votes.values()) {
    if (value === ButtonCustomID.Twos) twos += 1;
  }
  return twos;
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

  const targetSize = getQueueTargetSize(context);
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
): Promise<ReadonlyArray<PlayerInQueue> | null> {
  const activeMatchMember = await context.repositories.activeMatch.isPlayerInActiveMatch(userId);
  if (activeMatchMember) return null;

  const queue = await context.repositories.queue.getAllBallChasersInQueue();
  const target = getQueueTargetSize(context);
  const queueMember = await context.repositories.queue.getBallChaserInQueue(userId);

  if (!queueMember && queue.length >= target) {
    return null;
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

  return await context.repositories.queue.getAllBallChasersInQueue();
}

async function leaveQueue(context: GuildContext, userId: string): Promise<ReadonlyArray<PlayerInQueue> | null> {
  const playerInQueue = await context.repositories.queue.getBallChaserInQueue(userId);
  if (!playerInQueue) return null;

  await context.repositories.queue.removeBallChaserFromQueue(userId);
  resetVoteState(context);
  return await context.repositories.queue.getAllBallChasersInQueue();
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
  return updatedList ?? playersInQueue;
}

function createRandomTeams(ballchasers: ReadonlyArray<PlayerInQueue>): Array<NewActiveMatchInput> {
  const sortedBallChaser = ballchasers.slice().sort((o, b) => o.mmr - b.mmr);
  const activeMatch: NewActiveMatchInput[] = [];
  let orangeTeamCounter = 0;
  let blueTeamCounter = 0;

  sortedBallChaser.forEach((player) => {
    if (Math.round(Math.random()) === 1) {
      if (orangeTeamCounter < sortedBallChaser.length / 2) {
        activeMatch.push({ id: player.id, team: Team.Orange });
        orangeTeamCounter += 1;
      } else {
        activeMatch.push({ id: player.id, team: Team.Blue });
        blueTeamCounter += 1;
      }
    } else if (blueTeamCounter < sortedBallChaser.length / 2) {
      activeMatch.push({ id: player.id, team: Team.Blue });
      blueTeamCounter += 1;
    } else {
      activeMatch.push({ id: player.id, team: Team.Orange });
      orangeTeamCounter += 1;
    }
  });

  return activeMatch;
}

async function setCaptains(
  context: GuildContext,
  ballChasers: ReadonlyArray<PlayerInQueue>
): Promise<ReadonlyArray<PlayerInQueue>> {
  const sortedBallChaser = ballChasers.slice().sort((o, b) => b.mmr - o.mmr);

  await Promise.all([
    context.repositories.queue.updateBallChaserInQueue({
      id: sortedBallChaser[0].id,
      isCap: true,
      team: Team.Orange,
    }),
    context.repositories.queue.updateBallChaserInQueue({
      id: sortedBallChaser[1].id,
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

function calculateProbabilityDecimal(teams: ActiveMatchTeams): {
  blueProbabilityDecimal: number;
  orangeProbabilityDecimal: number;
} {
  const blueTeamMMR = teams.blueTeam.reduce((totalMMR, player) => totalMMR + player.mmr, 0);
  const orangeTeamMMR = teams.orangeTeam.reduce((totalMMR, player) => totalMMR + player.mmr, 0);

  const calcTeamProbabilityDecimal = (winnerMMR: number, loserMMR: number): number => {
    const difference = (loserMMR - winnerMMR) / 400;
    return 1 / (Math.pow(10, difference) + 1);
  };

  return {
    blueProbabilityDecimal: calcTeamProbabilityDecimal(blueTeamMMR, orangeTeamMMR),
    orangeProbabilityDecimal: calcTeamProbabilityDecimal(orangeTeamMMR, blueTeamMMR),
  };
}

function calculateMMR(calculatedProbabilityDecimal: number): number {
  let mmr = (1 - calculatedProbabilityDecimal) * 20;
  mmr = Math.min(15, mmr);
  mmr = Math.max(5, mmr);
  return Math.round(mmr);
}

function calculateProbability(calculatedProbabilityDecimal: number): number {
  return Math.round(calculatedProbabilityDecimal * 100);
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

async function checkReport(context: GuildContext, reportedTeam: Team, playerInMatchId: string): Promise<boolean> {
  const teams = await context.repositories.activeMatch.getAllPlayersInActiveMatch(playerInMatchId);
  const reporter = [...teams.blueTeam, ...teams.orangeTeam].find((player) => player.id === playerInMatchId);
  const previousReporter = [...teams.blueTeam, ...teams.orangeTeam].find((player) => player.reportedTeam !== null);

  if (!reporter) {
    return false;
  }

  if (previousReporter?.team === reporter.team && previousReporter.reportedTeam === reportedTeam) {
    return false;
  }

  if (previousReporter?.reportedTeam !== reportedTeam || previousReporter?.id === reporter.id) {
    await reportMatch(context, reportedTeam, reporter, teams);
    return false;
  }

  await confirmMatch(context, reportedTeam, teams, playerInMatchId);
  return true;
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
