import { Client, Message } from "discord.js";
import OpenAI from "openai";
import { DateTime } from "luxon";
import { PrismaClient } from "../../prisma";
import { Team } from "../../types/common";
import { GuildRuntimeManager } from "../GuildRuntimeManager";
import { GuildRepositories } from "../GuildRepositories";
import { DiscordWorkScheduler } from "../DiscordWorkScheduler";
import { GuildConfigStore } from "../GuildConfigStore";
import { GuildContext, InteractiveSurfaceState } from "../types";
import { ButtonCustomID, createVoteMatchSizeCustomId } from "../../utils/MessageHelper/CustomButtons";
import { MenuCustomID } from "../../utils/MessageHelper/MessageBuilder";
import {
  createIntegrationTestPrismaClient,
  DEFAULT_TEST_EVENT_ID,
  ensureDefaultIntegrationEvent,
  resetIntegrationDatabase,
} from "../../../.jest/integrationPrisma";
import {
  createButtonInteraction,
  createDiscordMessage,
  createGuildRuntimeTestContext,
  createGuildConfig,
  createSelectMenuInteraction,
} from "./guildRuntimeTestHarness";

function allowQueueSurface(
  context: GuildContext,
  message: Message,
  actions: string[],
  values?: string[],
  state: InteractiveSurfaceState = "queue_open"
) {
  context.surfaceRegistry.upsert(message.id, "queue", {
    allowedActions: new Set<string>(actions),
    allowedValues: values ? new Set<string>(values) : undefined,
    state,
  });
}

function allowMatchSurface(context: GuildContext, message: Message): void {
  context.surfaceRegistry.upsert(message.id, "match", {
    allowedActions: new Set<string>([ButtonCustomID.BrokenQueue, ButtonCustomID.ReportBlue, ButtonCustomID.ReportOrange]),
    state: "match_active",
  });
}

async function upsertLeaderboardRow(prisma: PrismaClient, playerId: string, mmr: number): Promise<void> {
  await prisma.leaderboard.upsert({
    create: {
      eventId: DEFAULT_TEST_EVENT_ID,
      mmr,
      playerId,
    },
    update: {
      mmr,
    },
    where: {
      eventId_playerId: {
        eventId: DEFAULT_TEST_EVENT_ID,
        playerId,
      },
    },
  });
}

async function ensurePlayer(prisma: PrismaClient, playerId: string): Promise<void> {
  await prisma.ballChaser.upsert({
    create: {
      id: playerId,
      name: playerId,
    },
    update: {
      name: playerId,
    },
    where: {
      id: playerId,
    },
  });
}

async function seedActiveMatch(
  prisma: PrismaClient,
  players: Array<{ id: string; reportedTeam?: Team | null; team: Team }>,
  mmrByPlayer: Record<string, number> = {}
): Promise<void> {
  for (const player of players) {
    await ensurePlayer(prisma, player.id);
    if (Object.prototype.hasOwnProperty.call(mmrByPlayer, player.id)) {
      await upsertLeaderboardRow(prisma, player.id, mmrByPlayer[player.id]);
    }
    await prisma.activeMatch.create({
      data: {
        brokenQueue: false,
        id: "match-1",
        playerId: player.id,
        reportedTeam: player.reportedTeam ?? null,
        team: player.team,
      },
    });
  }
}

async function createManagerContext(prisma: PrismaClient, guildId = "guild-1"): Promise<{
  context: GuildContext;
  manager: GuildRuntimeManager;
  queueMessage: Message;
  scheduler: DiscordWorkScheduler;
}> {
  const scheduler = new DiscordWorkScheduler(1, 0);
  const manager = new GuildRuntimeManager(
    {} as Client,
    {} as OpenAI,
    {} as GuildConfigStore,
    scheduler
  );
  const repositories = new GuildRepositories(prisma);
  const queueMessage = createDiscordMessage({ id: `${guildId}-queue-message` });
  const context = createGuildRuntimeTestContext(repositories, {
    config: createGuildConfig(guildId),
    guildId,
    prisma,
    queueMessage,
    scheduler,
  });

  return {
    context,
    manager,
    queueMessage,
    scheduler,
  };
}

async function joinPlayers(
  manager: GuildRuntimeManager,
  context: GuildContext,
  queueMessage: Message,
  playerIds: string[]
): Promise<void> {
  allowQueueSurface(context, queueMessage, [ButtonCustomID.JoinQueue, ButtonCustomID.LeaveQueue]);

  for (const playerId of playerIds) {
    await manager.handleButtonInteraction(context, createButtonInteraction(ButtonCustomID.JoinQueue, queueMessage, playerId));
    await context.scheduler.drain();
  }
}

describe("GuildRuntimeManager six mans integration", () => {
  let prisma: PrismaClient;
  let managedContexts: Array<Awaited<ReturnType<typeof createManagerContext>>>;

  beforeAll(async () => {
    prisma = createIntegrationTestPrismaClient();
    await prisma.$connect();
  });

  beforeEach(async () => {
    managedContexts = [];
    await resetIntegrationDatabase(prisma);
    await ensureDefaultIntegrationEvent(prisma);
  });

  afterEach(async () => {
    for (const managed of [...managedContexts].reverse()) {
      await managed.scheduler.drain();
      await managed.manager.dispose();
      await Promise.resolve();
      await Promise.resolve();
    }
    managedContexts = [];
  });

  afterAll(async () => {
    await resetIntegrationDatabase(prisma);
    await prisma.$disconnect();
  });

  async function createTrackedManagerContext(guildId: string) {
    const managed = await createManagerContext(prisma, guildId);
    managedContexts.push(managed);
    return managed;
  }

  it("fills a 6s queue and starts a random match", async () => {
    const { context, manager, queueMessage } = await createTrackedManagerContext("guild-random");
    const playerIds = ["player-1", "player-2", "player-3", "player-4", "player-5", "player-6"];

    await joinPlayers(manager, context, queueMessage, playerIds);

    for (const voter of playerIds.slice(0, 4)) {
      await manager.handleButtonInteraction(
        context,
        createButtonInteraction(ButtonCustomID.CreateRandomTeam, queueMessage, voter)
      );
      await context.scheduler.drain();
    }

    expect(await prisma.queue.count()).toBe(0);
    expect(await prisma.activeMatch.count()).toBe(6);
    expect(context.voteState.selectedMatchSize).toBeNull();
    expect(context.voteState.captainsRandomVotes.size).toBe(0);
  });

  it("fills a 6s queue and completes the captains draft flow", async () => {
    const { context, manager, queueMessage } = await createTrackedManagerContext("guild-captains");
    const playerIds = ["player-1", "player-2", "player-3", "player-4", "player-5", "player-6"];

    await joinPlayers(manager, context, queueMessage, playerIds);
    await Promise.all([
      upsertLeaderboardRow(prisma, "player-1", 110),
      upsertLeaderboardRow(prisma, "player-2", 140),
      upsertLeaderboardRow(prisma, "player-3", 100),
      upsertLeaderboardRow(prisma, "player-4", 150),
      upsertLeaderboardRow(prisma, "player-5", 120),
      upsertLeaderboardRow(prisma, "player-6", 130),
    ]);

    for (const voter of playerIds.slice(0, 4)) {
      await manager.handleButtonInteraction(context, createButtonInteraction(ButtonCustomID.ChooseTeam, queueMessage, voter));
      await context.scheduler.drain();
    }

    const queuedAfterCaptains = await prisma.queue.findMany({ orderBy: { playerId: "asc" } });
    expect(queuedAfterCaptains.find((player) => player.playerId === "player-4")?.isCap).toBe(true);
    expect(queuedAfterCaptains.find((player) => player.playerId === "player-2")?.isCap).toBe(true);

    allowQueueSurface(
      context,
      queueMessage,
      [MenuCustomID.BlueSelect],
      ["player-1", "player-3", "player-5", "player-6"],
      "captain_blue_pick"
    );
    await manager.handleSelectMenuInteraction(
      context,
      createSelectMenuInteraction(MenuCustomID.BlueSelect, ["player-6"], queueMessage, "player-2")
    );
    await context.scheduler.drain();

    allowQueueSurface(
      context,
      queueMessage,
      [MenuCustomID.OrangeSelect],
      ["player-1", "player-3", "player-5"],
      "captain_orange_pick"
    );
    await manager.handleSelectMenuInteraction(
      context,
      createSelectMenuInteraction(MenuCustomID.OrangeSelect, ["player-1", "player-3"], queueMessage, "player-4")
    );
    await context.scheduler.drain();

    expect(await prisma.queue.count()).toBe(0);
    expect(await prisma.activeMatch.count()).toBe(6);
  });

  it("selects 2v2 from four votes and starts a 2v2 random match from three random votes", async () => {
    const { context, manager, queueMessage } = await createTrackedManagerContext("guild-twos");
    const playerIds = ["player-1", "player-2", "player-3", "player-4"];
    const voteTwoVTwo = createVoteMatchSizeCustomId(2);

    await joinPlayers(manager, context, queueMessage, playerIds);
    allowQueueSurface(context, queueMessage, [ButtonCustomID.JoinQueue, ButtonCustomID.LeaveQueue, voteTwoVTwo]);

    for (const voter of playerIds) {
      await manager.handleButtonInteraction(context, createButtonInteraction(voteTwoVTwo, queueMessage, voter));
      await context.scheduler.drain();
    }

    expect(context.voteState.selectedMatchSize).toBe(2);

    for (const voter of playerIds.slice(0, 3)) {
      await manager.handleButtonInteraction(
        context,
        createButtonInteraction(ButtonCustomID.CreateRandomTeam, queueMessage, voter)
      );
      await context.scheduler.drain();
    }

    expect(await prisma.queue.count()).toBe(0);
    expect(await prisma.activeMatch.count()).toBe(4);
  });

  it("starts a 1v1 immediately after a unanimous 1v1 vote", async () => {
    const { context, manager, queueMessage } = await createTrackedManagerContext("guild-ones");
    const playerIds = ["player-1", "player-2"];
    const voteOneVOne = createVoteMatchSizeCustomId(1);
    context.config.enabledMatchSizes = [1, 2, 3];

    await joinPlayers(manager, context, queueMessage, playerIds);

    for (const voter of playerIds) {
      await manager.handleButtonInteraction(context, createButtonInteraction(voteOneVOne, queueMessage, voter));
      await context.scheduler.drain();
    }

    expect(await prisma.queue.count()).toBe(0);
    expect(await prisma.activeMatch.count()).toBe(2);
  });

  it("directly pops the highest enabled 4v4 tier without a lower-tier vote", async () => {
    const { context, manager, queueMessage } = await createTrackedManagerContext("guild-fours");
    const playerIds = Array.from({ length: 8 }, (_, index) => `player-${index + 1}`);
    context.config.enabledMatchSizes = [2, 4];

    await joinPlayers(manager, context, queueMessage, playerIds);

    for (const voter of playerIds.slice(0, 5)) {
      await manager.handleButtonInteraction(
        context,
        createButtonInteraction(ButtonCustomID.CreateRandomTeam, queueMessage, voter)
      );
      await context.scheduler.drain();
    }

    expect(context.voteState.selectedMatchSize).toBeNull();
    expect(await prisma.queue.count()).toBe(0);
    expect(await prisma.activeMatch.count()).toBe(8);
  });

  it("prevents active-match players from joining another queue", async () => {
    const { context, manager, queueMessage } = await createTrackedManagerContext("guild-rejoin");
    await seedActiveMatch(
      prisma,
      [
        { id: "blue-1", team: Team.Blue },
        { id: "blue-2", team: Team.Blue },
        { id: "blue-3", team: Team.Blue },
        { id: "orange-1", team: Team.Orange },
        { id: "orange-2", team: Team.Orange },
        { id: "orange-3", team: Team.Orange },
      ]
    );
    allowQueueSurface(context, queueMessage, [ButtonCustomID.JoinQueue, ButtonCustomID.LeaveQueue]);

    await manager.handleButtonInteraction(context, createButtonInteraction(ButtonCustomID.JoinQueue, queueMessage, "blue-1"));
    await context.scheduler.drain();

    expect(await prisma.queue.count()).toBe(0);
  });

  it("prevents popped-queue outsiders from influencing votes or draft picks", async () => {
    const { context, manager, queueMessage } = await createTrackedManagerContext("guild-outsider");
    const playerIds = ["player-1", "player-2", "player-3", "player-4", "player-5", "player-6"];

    await joinPlayers(manager, context, queueMessage, playerIds);
    await Promise.all([
      upsertLeaderboardRow(prisma, "player-1", 110),
      upsertLeaderboardRow(prisma, "player-2", 140),
      upsertLeaderboardRow(prisma, "player-3", 100),
      upsertLeaderboardRow(prisma, "player-4", 150),
      upsertLeaderboardRow(prisma, "player-5", 120),
      upsertLeaderboardRow(prisma, "player-6", 130),
    ]);

    await manager.handleButtonInteraction(
      context,
      createButtonInteraction(ButtonCustomID.CreateRandomTeam, queueMessage, "spectator")
    );
    await context.scheduler.drain();

    expect(await prisma.activeMatch.count()).toBe(0);
    expect(context.voteState.captainsRandomVotes.size).toBe(0);

    for (const voter of playerIds.slice(0, 4)) {
      await manager.handleButtonInteraction(context, createButtonInteraction(ButtonCustomID.ChooseTeam, queueMessage, voter));
      await context.scheduler.drain();
    }

    allowQueueSurface(
      context,
      queueMessage,
      [MenuCustomID.BlueSelect],
      ["player-1", "player-3", "player-5", "player-6"],
      "captain_blue_pick"
    );

    await manager.handleSelectMenuInteraction(
      context,
      createSelectMenuInteraction(MenuCustomID.BlueSelect, ["player-6"], queueMessage, "spectator")
    );
    await context.scheduler.drain();

    const queuedAfterOutsiderAttempt = await prisma.queue.findMany({ orderBy: { playerId: "asc" } });
    expect(queuedAfterOutsiderAttempt.find((player) => player.playerId === "player-6")?.team).toBeNull();
  });

  it("records the first report as pending without ending the match", async () => {
    const { context, manager } = await createTrackedManagerContext("guild-report-pending");
    const matchMessage = createDiscordMessage({
      embeds: [{ title: "Current Match" }],
      id: "match-message-1",
    });
    await seedActiveMatch(
      prisma,
      [
        { id: "blue-1", team: Team.Blue },
        { id: "blue-2", team: Team.Blue },
        { id: "blue-3", team: Team.Blue },
        { id: "orange-1", team: Team.Orange },
        { id: "orange-2", team: Team.Orange },
        { id: "orange-3", team: Team.Orange },
      ]
    );
    allowMatchSurface(context, matchMessage);

    await manager.handleButtonInteraction(context, createButtonInteraction(ButtonCustomID.ReportBlue, matchMessage, "blue-1"));
    await context.scheduler.drain();

    expect(await prisma.activeMatch.count()).toBe(6);
    expect((await prisma.activeMatch.findUnique({ where: { playerId: "blue-1" } }))?.reportedTeam).toBe(Team.Blue);
    expect((await prisma.activeMatch.findUnique({ where: { playerId: "orange-1" } }))?.reportedTeam).toBeNull();
  });

  it("does not confirm a match when two players on the same team agree", async () => {
    const { context, manager } = await createTrackedManagerContext("guild-report-same-team");
    const matchMessage = createDiscordMessage({
      embeds: [{ title: "Current Match" }],
      id: "match-message-1",
    });
    await seedActiveMatch(
      prisma,
      [
        { id: "blue-1", reportedTeam: Team.Blue, team: Team.Blue },
        { id: "blue-2", team: Team.Blue },
        { id: "blue-3", team: Team.Blue },
        { id: "orange-1", team: Team.Orange },
        { id: "orange-2", team: Team.Orange },
        { id: "orange-3", team: Team.Orange },
      ]
    );
    allowMatchSurface(context, matchMessage);

    await manager.handleButtonInteraction(context, createButtonInteraction(ButtonCustomID.ReportBlue, matchMessage, "blue-2"));
    await context.scheduler.drain();

    expect(await prisma.activeMatch.count()).toBe(6);
    expect(await prisma.leaderboard.count()).toBe(0);
  });

  it("confirms a match when opposite teams report the same winner", async () => {
    const { context, manager } = await createTrackedManagerContext("guild-report-confirm");
    const matchMessage = createDiscordMessage({
      embeds: [{ title: "Current Match" }],
      id: "match-message-1",
    });
    await seedActiveMatch(
      prisma,
      [
        { id: "blue-1", reportedTeam: Team.Blue, team: Team.Blue },
        { id: "blue-2", team: Team.Blue },
        { id: "blue-3", team: Team.Blue },
        { id: "orange-1", team: Team.Orange },
        { id: "orange-2", team: Team.Orange },
        { id: "orange-3", team: Team.Orange },
      ]
    );
    allowMatchSurface(context, matchMessage);

    await manager.handleButtonInteraction(context, createButtonInteraction(ButtonCustomID.ReportBlue, matchMessage, "orange-1"));
    await context.scheduler.drain();

    expect(await prisma.activeMatch.count()).toBe(0);
    const leaderboardRows = await prisma.leaderboard.findMany({ orderBy: { playerId: "asc" } });
    expect(leaderboardRows).toHaveLength(6);
    expect(leaderboardRows.filter((player) => player.playerId.startsWith("blue")).every((player) => player.mmr === 110)).toBe(true);
    expect(leaderboardRows.filter((player) => player.playerId.startsWith("orange")).every((player) => player.mmr === 90)).toBe(true);
  });

  it("applies the event mmr multiplier only to the winning team", async () => {
    const { context, manager } = await createTrackedManagerContext("guild-report-multiplier");
    const matchMessage = createDiscordMessage({
      embeds: [{ title: "Current Match" }],
      id: "match-message-1",
    });
    await prisma.event.update({
      data: {
        mmrMult: 1.5,
      },
      where: {
        id: DEFAULT_TEST_EVENT_ID,
      },
    });
    await seedActiveMatch(
      prisma,
      [
        { id: "blue-1", reportedTeam: Team.Blue, team: Team.Blue },
        { id: "blue-2", team: Team.Blue },
        { id: "orange-1", team: Team.Orange },
        { id: "orange-2", team: Team.Orange },
      ]
    );
    allowMatchSurface(context, matchMessage);

    await manager.handleButtonInteraction(context, createButtonInteraction(ButtonCustomID.ReportBlue, matchMessage, "orange-1"));
    await context.scheduler.drain();

    const leaderboardRows = await prisma.leaderboard.findMany({ orderBy: { playerId: "asc" } });
    expect(leaderboardRows.filter((player) => player.playerId.startsWith("blue")).every((player) => player.mmr === 115)).toBe(true);
    expect(leaderboardRows.filter((player) => player.playerId.startsWith("orange")).every((player) => player.mmr === 90)).toBe(true);
  });

  it("toggles broken queue votes and cancels the match on four votes without updating the leaderboard", async () => {
    const { context, manager } = await createTrackedManagerContext("guild-broken-queue");
    const matchMessage = createDiscordMessage({
      embeds: [{ title: "Current Match" }],
      id: "match-message-1",
    });
    const players = [
      { id: "blue-1", team: Team.Blue },
      { id: "blue-2", team: Team.Blue },
      { id: "blue-3", team: Team.Blue },
      { id: "orange-1", team: Team.Orange },
      { id: "orange-2", team: Team.Orange },
      { id: "orange-3", team: Team.Orange },
    ] as const;
    await seedActiveMatch(prisma, players.map((player) => ({ ...player })));
    allowMatchSurface(context, matchMessage);

    await manager.handleButtonInteraction(
      context,
      createButtonInteraction(ButtonCustomID.BrokenQueue, matchMessage, "blue-1")
    );
    await context.scheduler.drain();
    expect((await prisma.activeMatch.findUnique({ where: { playerId: "blue-1" } }))?.brokenQueue).toBe(true);

    await manager.handleButtonInteraction(
      context,
      createButtonInteraction(ButtonCustomID.BrokenQueue, matchMessage, "blue-1")
    );
    await context.scheduler.drain();
    expect((await prisma.activeMatch.findUnique({ where: { playerId: "blue-1" } }))?.brokenQueue).toBe(false);

    for (const voter of ["blue-1", "blue-2", "orange-1", "orange-2"]) {
      await manager.handleButtonInteraction(
        context,
        createButtonInteraction(ButtonCustomID.BrokenQueue, matchMessage, voter)
      );
      await context.scheduler.drain();
    }

    expect(await prisma.activeMatch.count()).toBe(0);
    expect(await prisma.leaderboard.count()).toBe(0);
    expect(matchMessage.delete).toHaveBeenCalledTimes(1);
  });
});
