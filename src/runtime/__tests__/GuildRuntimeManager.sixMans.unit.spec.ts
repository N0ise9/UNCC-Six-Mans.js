import { Client, Message } from "discord.js";
import { DateTime } from "luxon";
import OpenAI from "openai";
import { ActiveMatchCreated } from "../../domain/match";
import { Team } from "../../types/common";
import { ActiveMatchTeams, PlayerInActiveMatch } from "../../repositories/ActiveMatchRepository/types";
import { PlayerInQueue } from "../../repositories/QueueRepository/types";
import { ButtonCustomID, createVoteMatchSizeCustomId } from "../../utils/MessageHelper/CustomButtons";
import { MenuCustomID } from "../../utils/MessageHelper/MessageBuilder";
import { GuildRuntimeManager } from "../GuildRuntimeManager";
import { DiscordWorkScheduler } from "../DiscordWorkScheduler";
import { GuildConfigStore } from "../GuildConfigStore";
import { GuildContext } from "../types";
import {
  createButtonInteraction,
  createDiscordMessage,
  createGuildRuntimeTestContext,
  createSelectMenuInteraction,
} from "./guildRuntimeTestHarness";

type RepositoryOverrides = {
  activeMatch?: Partial<GuildContext["repositories"]["activeMatch"]>;
  event?: Partial<GuildContext["repositories"]["event"]>;
  leaderboard?: Partial<GuildContext["repositories"]["leaderboard"]>;
  queue?: Partial<GuildContext["repositories"]["queue"]>;
};

function queuePlayer(
  id: string,
  overrides: Partial<PlayerInQueue> = {},
  queueTime = DateTime.fromISO("2026-04-04T12:30:00.000Z")
): PlayerInQueue {
  return {
    id,
    isCap: false,
    mmr: 100,
    name: id,
    queueTime,
    team: null,
    ...overrides,
  };
}

function activeMatchPlayer(id: string, team: Team, overrides: Partial<PlayerInActiveMatch> = {}): PlayerInActiveMatch {
  return {
    brokenQueue: false,
    id,
    matchId: "match-1",
    mmr: 100,
    reportedTeam: null,
    team,
    ...overrides,
  };
}

function createMockRepositories(overrides: RepositoryOverrides = {}): GuildContext["repositories"] {
  return {
    activeMatch: {
      addActiveMatch: jest.fn(async () => undefined),
      getAllBrokenQueueVotesInActiveMatch: jest.fn(async () => 0),
      getAllBrokenQueueVotersInActiveMatch: jest.fn(async () => ({ blueTeam: [], orangeTeam: [] })),
      getAllPlayersInActiveMatch: jest.fn(async () => ({ blueTeam: [], orangeTeam: [] })),
      getPlayerInActiveMatch: jest.fn(async () => null),
      isPlayerInActiveMatch: jest.fn(async () => false),
      removeAllPlayersInActiveMatch: jest.fn(async () => undefined),
      updatePlayerInActiveMatch: jest.fn(async () => undefined),
      ...(overrides.activeMatch ?? {}),
    },
    event: {
      ensureCurrentEvent: jest.fn(async () => ({
        created: false,
        event: {
          endDate: null,
          id: 1,
          mmrMult: 1,
          name: "Spring 2026",
          startDate: new Date("2026-01-01T00:00:00.000Z"),
        },
      })),
      getCurrentEvent: jest.fn(async () => ({
        endDate: null,
        id: 1,
        mmrMult: 1,
        name: "Spring 2026",
        startDate: new Date("2026-01-01T00:00:00.000Z"),
      })),
      ...(overrides.event ?? {}),
    },
    leaderboard: {
      getPlayerStats: jest.fn(async () => null),
      getPlayersStats: jest.fn(async () => []),
      updatePlayersStats: jest.fn(async () => undefined),
      ...(overrides.leaderboard ?? {}),
    },
    queue: {
      addBallChaserToQueue: jest.fn(async () => undefined),
      getAllBallChasersInQueue: jest.fn(async () => []),
      getBallChaserInQueue: jest.fn(async () => null),
      isPlayerInQueue: jest.fn(async () => false),
      isTeamCaptain: jest.fn(async () => false),
      removeAllBallChasersFromQueue: jest.fn(async () => undefined),
      removeBallChaserFromQueue: jest.fn(async () => undefined),
      updateBallChaserInQueue: jest.fn(async () => undefined),
      ...(overrides.queue ?? {}),
    },
  } as unknown as GuildContext["repositories"];
}

function allowQueueSurface(context: GuildContext, message: Message, actions: string[], values?: string[]): void {
  context.surfaceRegistry.upsert(message.id, "queue", {
    allowedActions: new Set<string>(actions),
    allowedValues: values ? new Set<string>(values) : undefined,
    state: "queue_open",
  });
}

function createManager(): GuildRuntimeManager {
  return new GuildRuntimeManager({} as Client, {} as OpenAI, {} as GuildConfigStore, new DiscordWorkScheduler(1, 0));
}

async function flushSurfaceWindow(context: GuildContext, ms = 0): Promise<void> {
  await jest.advanceTimersByTimeAsync(ms);
  await Promise.resolve();
  await context.scheduler.drain();
}

function asEmbedSummary(payload: unknown): string {
  const messagePayload = payload as { embeds?: Array<{ toJSON?: () => Record<string, unknown> }> };
  const embed = messagePayload.embeds?.[0];
  const json = embed?.toJSON?.() ?? {};
  return [json["title"], json["description"]].filter((value): value is string => typeof value === "string").join(" ");
}

function createInMemoryRepositories(
  initialQueue: ReadonlyArray<Readonly<PlayerInQueue>> = [],
  initialMatchPlayers: ReadonlyArray<PlayerInActiveMatch> = []
): GuildContext["repositories"] {
  let queueState = initialQueue.map((player) => ({ ...player }));
  let activeMatchState = initialMatchPlayers.map((player) => ({ ...player }));
  let leaderboardState = new Map<string, { id: string; losses: number; mmr: number; wins: number }>();

  const getActiveTeams = (): ActiveMatchTeams => ({
    blueTeam: activeMatchState.filter((player) => player.team === Team.Blue).map((player) => ({ ...player })),
    orangeTeam: activeMatchState.filter((player) => player.team === Team.Orange).map((player) => ({ ...player })),
  });

  const repositories = createMockRepositories({
    activeMatch: {
      addActiveMatch: jest.fn(async (players) => {
        activeMatchState = players.map((player) => ({
          brokenQueue: false,
          id: player.id,
          matchId: "match-1",
          mmr: queueState.find((queued) => queued.id === player.id)?.mmr ?? 100,
          reportedTeam: null,
          team: player.team,
        }));
      }),
      getAllBrokenQueueVotesInActiveMatch: jest.fn(
        async () => activeMatchState.filter((player) => player.brokenQueue).length
      ),
      getAllBrokenQueueVotersInActiveMatch: jest.fn(async () => ({
        blueTeam: activeMatchState.filter((player) => player.team === Team.Blue && player.brokenQueue),
        orangeTeam: activeMatchState.filter((player) => player.team === Team.Orange && player.brokenQueue),
      })),
      getAllPlayersInActiveMatch: jest.fn(async () => getActiveTeams()),
      getPlayerInActiveMatch: jest.fn(
        async (id: string) => activeMatchState.find((player) => player.id === id) ?? null
      ),
      isPlayerInActiveMatch: jest.fn(async (id: string) => activeMatchState.some((player) => player.id === id)),
      removeAllPlayersInActiveMatch: jest.fn(async () => {
        activeMatchState = [];
      }),
      updatePlayerInActiveMatch: jest.fn(async (id: string, updates: Partial<PlayerInActiveMatch>) => {
        activeMatchState = activeMatchState.map((player) =>
          player.id === id
            ? {
                ...player,
                ...updates,
              }
            : player
        );
      }),
    },
    leaderboard: {
      getPlayerStats: jest.fn(async (id: string) => {
        const player = leaderboardState.get(id);
        if (!player) {
          return null;
        }

        return {
          id: player.id,
          losses: player.losses,
          matchesPlayed: player.wins + player.losses,
          mmr: player.mmr,
          name: id,
          winPerc: player.wins + player.losses === 0 ? 0 : player.wins / (player.wins + player.losses),
          wins: player.wins,
        };
      }),
      updatePlayersStats: jest.fn(async (updates) => {
        updates.forEach((update) => {
          const previous = leaderboardState.get(update.id);
          leaderboardState.set(update.id, {
            id: update.id,
            losses: update.losses ?? previous?.losses ?? 0,
            mmr: update.mmr,
            wins: update.wins ?? previous?.wins ?? 0,
          });
        });
      }),
    },
    queue: {
      addBallChaserToQueue: jest.fn(async (player) => {
        const existing = queueState.find((queued) => queued.id === player.id);
        if (existing) {
          existing.queueTime = player.queueTime;
          existing.name = player.name;
          return;
        }

        queueState.push({
          id: player.id,
          isCap: false,
          mmr: 100,
          name: player.name,
          queueTime: player.queueTime,
          team: null,
        });
      }),
      getAllBallChasersInQueue: jest.fn(async () =>
        queueState
          .map((player) => ({ ...player }))
          .sort((left, right) => left.queueTime.toMillis() - right.queueTime.toMillis())
      ),
      getBallChaserInQueue: jest.fn(async (id: string) => {
        const player = queueState.find((queued) => queued.id === id);
        return player ? { ...player } : null;
      }),
      isPlayerInQueue: jest.fn(async (id: string) => queueState.some((player) => player.id === id)),
      isTeamCaptain: jest.fn(async (id: string, team: Team) =>
        queueState.some((player) => player.id === id && player.isCap && player.team === team)
      ),
      removeAllBallChasersFromQueue: jest.fn(async () => {
        queueState = [];
      }),
      removeBallChaserFromQueue: jest.fn(async (id: string) => {
        queueState = queueState.filter((player) => player.id !== id);
      }),
      updateBallChaserInQueue: jest.fn(async ({ id, ...updates }) => {
        queueState = queueState.map((player) =>
          player.id === id
            ? {
                ...player,
                ...updates,
                queueTime: updates.queueTime ?? player.queueTime,
              }
            : player
        );
      }),
    },
  });

  return repositories;
}

describe("GuildRuntimeManager six mans interactions", () => {
  let infoSpy: jest.SpyInstance;

  beforeEach(() => {
    infoSpy = jest.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    jest.useRealTimers();
    infoSpy.mockRestore();
  });

  it("joins the queue when it is open", async () => {
    jest.useFakeTimers({ now: new Date("2026-04-04T12:00:00.000Z").getTime() });
    const manager = createManager();
    const queueMessage = createDiscordMessage({ id: "queue-message-1" });
    const updatedPlayers = [queuePlayer("player-1", {}, DateTime.fromISO("2026-04-04T13:00:00.000Z"))];
    const repositories = createMockRepositories({
      activeMatch: {
        isPlayerInActiveMatch: jest.fn(async () => false),
      },
      queue: {
        addBallChaserToQueue: jest.fn(async () => undefined),
        getAllBallChasersInQueue: jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(updatedPlayers),
        getBallChaserInQueue: jest.fn(async () => null),
      },
    });
    const context = createGuildRuntimeTestContext(repositories, { queueMessage });
    allowQueueSurface(context, queueMessage, [ButtonCustomID.JoinQueue, ButtonCustomID.LeaveQueue]);

    await manager.handleButtonInteraction(
      context,
      createButtonInteraction(ButtonCustomID.JoinQueue, queueMessage, "player-1", "Destroyer")
    );
    await flushSurfaceWindow(context);

    expect(context.repositories.queue.addBallChaserToQueue).toHaveBeenCalledTimes(1);
    expect(context.repositories.queue.updateBallChaserInQueue).not.toHaveBeenCalled();
    expect(queueMessage.edit).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("Destroyer | Join Queue | PROCESSED | joined the queue")
    );
    expect(
      infoSpy.mock.calls.filter(
        ([message]) => typeof message === "string" && message.includes("Destroyer | Join Queue |")
      )
    ).toHaveLength(1);
  });

  it("refreshes an existing queued player instead of duplicating them", async () => {
    const manager = createManager();
    const queueMessage = createDiscordMessage({ id: "queue-message-1" });
    const existingPlayer = queuePlayer("player-1");
    const updatedPlayer = queuePlayer("player-1", {}, DateTime.fromISO("2026-04-04T13:00:00.000Z"));
    const repositories = createMockRepositories({
      activeMatch: {
        isPlayerInActiveMatch: jest.fn(async () => false),
      },
      queue: {
        addBallChaserToQueue: jest.fn(async () => undefined),
        getAllBallChasersInQueue: jest
          .fn()
          .mockResolvedValueOnce([existingPlayer])
          .mockResolvedValueOnce([updatedPlayer]),
        getBallChaserInQueue: jest.fn(async () => existingPlayer),
        updateBallChaserInQueue: jest.fn(async () => undefined),
      },
    });
    const context = createGuildRuntimeTestContext(repositories, { queueMessage });
    context.voteState.captainsRandomVotes.set("player-2", ButtonCustomID.ChooseTeam);
    allowQueueSurface(context, queueMessage, [ButtonCustomID.JoinQueue, ButtonCustomID.LeaveQueue]);

    await manager.handleButtonInteraction(
      context,
      createButtonInteraction(ButtonCustomID.JoinQueue, queueMessage, "player-1")
    );
    await context.scheduler.drain();

    expect(context.repositories.queue.addBallChaserToQueue).not.toHaveBeenCalled();
    expect(context.repositories.queue.updateBallChaserInQueue).toHaveBeenCalledTimes(1);
    expect(context.voteState.captainsRandomVotes.size).toBe(1);
  });

  it("processes rapid alternating queue presses without ignoring valid backend actions", async () => {
    const manager = createManager();
    const queueMessage = createDiscordMessage({ id: "queue-message-1" });
    const repositories = createInMemoryRepositories();
    const context = createGuildRuntimeTestContext(repositories, { queueMessage });
    allowQueueSurface(context, queueMessage, [ButtonCustomID.JoinQueue, ButtonCustomID.LeaveQueue]);

    const join = createButtonInteraction(ButtonCustomID.JoinQueue, queueMessage, "player-1", "Destroyer");
    const leave = createButtonInteraction(ButtonCustomID.LeaveQueue, queueMessage, "player-1", "Destroyer");

    await manager.handleButtonInteraction(context, join);
    await manager.handleButtonInteraction(context, leave);
    await context.scheduler.drain();

    const finalQueue = await context.repositories.queue.getAllBallChasersInQueue();
    expect(finalQueue).toHaveLength(0);
    expect(join.followUp).not.toHaveBeenCalled();
    expect(leave.followUp).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("Destroyer | Join Queue | PROCESSED | joined the queue")
    );
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("Destroyer | Leave Queue | PROCESSED | left the queue")
    );
  });

  it("rejects a new join when the queue is already full", async () => {
    const manager = createManager();
    const queueMessage = createDiscordMessage({ id: "queue-message-1" });
    const repositories = createMockRepositories({
      activeMatch: {
        isPlayerInActiveMatch: jest.fn(async () => false),
      },
      queue: {
        addBallChaserToQueue: jest.fn(async () => undefined),
        getAllBallChasersInQueue: jest.fn(async () =>
          Array.from({ length: 6 }, (_, index) => queuePlayer(`player-${index + 1}`))
        ),
        getBallChaserInQueue: jest.fn(async () => null),
      },
    });
    const context = createGuildRuntimeTestContext(repositories, { queueMessage });
    allowQueueSurface(context, queueMessage, [ButtonCustomID.JoinQueue, ButtonCustomID.LeaveQueue]);

    await manager.handleButtonInteraction(
      context,
      createButtonInteraction(ButtonCustomID.JoinQueue, queueMessage, "spectator", "SneakyUser")
    );
    await context.scheduler.drain();

    expect(context.repositories.queue.addBallChaserToQueue).not.toHaveBeenCalled();
    expect(queueMessage.edit).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("SneakyUser | Join Queue | IGNORED | queue is already full")
    );
  });

  it("rejects queue joins from players already in an active match", async () => {
    const manager = createManager();
    const queueMessage = createDiscordMessage({ id: "queue-message-1" });
    const repositories = createMockRepositories({
      activeMatch: {
        isPlayerInActiveMatch: jest.fn(async () => true),
      },
    });
    const context = createGuildRuntimeTestContext(repositories, { queueMessage });
    allowQueueSurface(context, queueMessage, [ButtonCustomID.JoinQueue, ButtonCustomID.LeaveQueue]);

    await manager.handleButtonInteraction(
      context,
      createButtonInteraction(ButtonCustomID.JoinQueue, queueMessage, "player-1")
    );
    await context.scheduler.drain();

    expect(context.repositories.queue.addBallChaserToQueue).not.toHaveBeenCalled();
    expect(queueMessage.edit).not.toHaveBeenCalled();
  });

  it("treats leaving while not queued as a safe no-op", async () => {
    const manager = createManager();
    const queueMessage = createDiscordMessage({ id: "queue-message-1" });
    const repositories = createMockRepositories({
      queue: {
        getBallChaserInQueue: jest.fn(async () => null),
      },
    });
    const context = createGuildRuntimeTestContext(repositories, { queueMessage });
    allowQueueSurface(context, queueMessage, [ButtonCustomID.JoinQueue, ButtonCustomID.LeaveQueue]);

    await manager.handleButtonInteraction(
      context,
      createButtonInteraction(ButtonCustomID.LeaveQueue, queueMessage, "player-1")
    );
    await context.scheduler.drain();

    expect(context.repositories.queue.removeBallChaserFromQueue).not.toHaveBeenCalled();
    expect(queueMessage.edit).not.toHaveBeenCalled();
  });

  it("resets vote state when a queued player leaves", async () => {
    const manager = createManager();
    const queueMessage = createDiscordMessage({ id: "queue-message-1" });
    const remainingPlayers = [queuePlayer("player-2")];
    const repositories = createMockRepositories({
      queue: {
        getAllBallChasersInQueue: jest.fn(async () => remainingPlayers),
        getBallChaserInQueue: jest.fn(async () => queuePlayer("player-1")),
        removeBallChaserFromQueue: jest.fn(async () => undefined),
      },
    });
    const context = createGuildRuntimeTestContext(repositories, { queueMessage });
    context.voteState.captainsRandomVotes.set("player-1", ButtonCustomID.ChooseTeam);
    context.voteState.selectedMatchSize = 2;
    context.voteState.sizeVotes.set("player-2", 2);
    allowQueueSurface(context, queueMessage, [ButtonCustomID.JoinQueue, ButtonCustomID.LeaveQueue]);

    await manager.handleButtonInteraction(
      context,
      createButtonInteraction(ButtonCustomID.LeaveQueue, queueMessage, "player-1")
    );
    await context.scheduler.drain();

    expect(context.voteState.captainsRandomVotes.size).toBe(0);
    expect(context.voteState.sizeVotes.size).toBe(0);
    expect(context.voteState.selectedMatchSize).toBeNull();
  });

  it("expires queued players on the timer only when the queue is not popped", async () => {
    jest.useFakeTimers({ now: new Date("2026-04-04T12:00:00.000Z").getTime() });
    const manager = createManager();
    const queueMessage = createDiscordMessage({ id: "queue-message-1" });
    const expired = queuePlayer("expired-player", {}, DateTime.fromISO("2026-04-04T11:59:00.000Z"));
    const survivor = queuePlayer("survivor", {}, DateTime.fromISO("2026-04-04T12:45:00.000Z"));
    const repositories = createMockRepositories({
      queue: {
        getAllBallChasersInQueue: jest
          .fn()
          .mockResolvedValueOnce([expired, survivor])
          .mockResolvedValueOnce([survivor]),
        removeBallChaserFromQueue: jest.fn(async () => undefined),
      },
    });
    const context = createGuildRuntimeTestContext(repositories, { queueMessage });

    await (manager as unknown as { runQueueTimer: (guildContext: GuildContext) => Promise<void> }).runQueueTimer(
      context
    );
    await flushSurfaceWindow(context);

    expect(context.repositories.queue.removeBallChaserFromQueue).toHaveBeenCalledWith("expired-player");
    expect(queueMessage.edit).toHaveBeenCalledTimes(1);
  });

  it("does not expire players on the timer after the queue has popped", async () => {
    jest.useFakeTimers({ now: new Date("2026-04-04T12:00:00.000Z").getTime() });
    const manager = createManager();
    const queueMessage = createDiscordMessage({ id: "queue-message-1" });
    const poppedCaptain = queuePlayer(
      "captain",
      { isCap: true, team: Team.Blue },
      DateTime.fromISO("2026-04-04T11:59:00.000Z")
    );
    const repositories = createMockRepositories({
      queue: {
        getAllBallChasersInQueue: jest.fn(async () => [poppedCaptain]),
        removeBallChaserFromQueue: jest.fn(async () => undefined),
      },
    });
    const context = createGuildRuntimeTestContext(repositories, { queueMessage });

    await (manager as unknown as { runQueueTimer: (guildContext: GuildContext) => Promise<void> }).runQueueTimer(
      context
    );
    await flushSurfaceWindow(context);

    expect(context.repositories.queue.removeBallChaserFromQueue).not.toHaveBeenCalled();
    expect(queueMessage.edit).toHaveBeenCalledTimes(1);
  });

  it("only allows queued players to cast lower-tier votes", async () => {
    const manager = createManager();
    const queueMessage = createDiscordMessage({ id: "queue-message-1" });
    const queuedPlayers = ["player-1", "player-2", "player-3", "player-4"].map((id) => queuePlayer(id));
    const repositories = createMockRepositories({
      queue: {
        getAllBallChasersInQueue: jest.fn(async () => queuedPlayers),
      },
    });
    const context = createGuildRuntimeTestContext(repositories, { queueMessage });
    const voteTwoVTwo = createVoteMatchSizeCustomId(2);
    allowQueueSurface(context, queueMessage, [ButtonCustomID.JoinQueue, ButtonCustomID.LeaveQueue, voteTwoVTwo]);

    await manager.handleButtonInteraction(context, createButtonInteraction(voteTwoVTwo, queueMessage, "spectator"));
    await context.scheduler.drain();

    expect(context.voteState.sizeVotes.size).toBe(0);
    expect(queueMessage.edit).not.toHaveBeenCalled();
  });

  it("does not double-count repeated lower-tier votes from the same player", async () => {
    const manager = createManager();
    const queueMessage = createDiscordMessage({ id: "queue-message-1" });
    const queuedPlayers = ["player-1", "player-2", "player-3", "player-4"].map((id) => queuePlayer(id));
    const repositories = createMockRepositories({
      queue: {
        getAllBallChasersInQueue: jest.fn(async () => queuedPlayers),
      },
    });
    const context = createGuildRuntimeTestContext(repositories, { queueMessage });
    const voteTwoVTwo = createVoteMatchSizeCustomId(2);
    allowQueueSurface(context, queueMessage, [ButtonCustomID.JoinQueue, ButtonCustomID.LeaveQueue, voteTwoVTwo]);

    await manager.handleButtonInteraction(context, createButtonInteraction(voteTwoVTwo, queueMessage, "player-1"));
    await manager.handleButtonInteraction(context, createButtonInteraction(voteTwoVTwo, queueMessage, "player-1"));
    await context.scheduler.drain();

    expect(context.voteState.sizeVotes.size).toBe(1);
  });

  it("collapses queue edits until 1250ms after the last visible queue update", async () => {
    jest.useFakeTimers({ now: new Date("2026-04-04T12:00:00.000Z").getTime() });
    const manager = createManager();
    const queueMessage = createDiscordMessage({ id: "queue-message-1" });
    const repositories = createInMemoryRepositories();
    const context = createGuildRuntimeTestContext(repositories, { queueMessage });
    allowQueueSurface(context, queueMessage, [ButtonCustomID.JoinQueue, ButtonCustomID.LeaveQueue]);

    await manager.handleButtonInteraction(
      context,
      createButtonInteraction(ButtonCustomID.JoinQueue, queueMessage, "player-1")
    );
    await flushSurfaceWindow(context);
    expect(queueMessage.edit).toHaveBeenCalledTimes(1);

    await manager.handleButtonInteraction(
      context,
      createButtonInteraction(ButtonCustomID.LeaveQueue, queueMessage, "player-1")
    );
    await manager.handleButtonInteraction(
      context,
      createButtonInteraction(ButtonCustomID.JoinQueue, queueMessage, "player-1")
    );
    await manager.handleButtonInteraction(
      context,
      createButtonInteraction(ButtonCustomID.LeaveQueue, queueMessage, "player-1")
    );

    const queuedPlayersBeforeNextWindow = await context.repositories.queue.getAllBallChasersInQueue();
    expect(queuedPlayersBeforeNextWindow).toHaveLength(0);
    expect(queueMessage.edit).toHaveBeenCalledTimes(1);

    await flushSurfaceWindow(context, 1249);
    expect(queueMessage.edit).toHaveBeenCalledTimes(1);

    await flushSurfaceWindow(context, 1);
    expect(queueMessage.edit).toHaveBeenCalledTimes(2);
  });

  it("selects 2v2 after four unique queued votes and clears the vote maps", async () => {
    const manager = createManager();
    const queueMessage = createDiscordMessage({ id: "queue-message-1" });
    const queuedPlayers = ["player-1", "player-2", "player-3", "player-4"].map((id) => queuePlayer(id));
    const repositories = createMockRepositories({
      queue: {
        getAllBallChasersInQueue: jest.fn(async () => queuedPlayers),
      },
    });
    const context = createGuildRuntimeTestContext(repositories, { queueMessage });
    const voteTwoVTwo = createVoteMatchSizeCustomId(2);
    allowQueueSurface(context, queueMessage, [ButtonCustomID.JoinQueue, ButtonCustomID.LeaveQueue, voteTwoVTwo]);

    for (const player of queuedPlayers) {
      await manager.handleButtonInteraction(context, createButtonInteraction(voteTwoVTwo, queueMessage, player.id));
    }
    await context.scheduler.drain();

    expect(context.voteState.selectedMatchSize).toBe(2);
    expect(context.voteState.sizeVotes.size).toBe(0);
    expect(context.voteState.captainsRandomVotes.size).toBe(0);
  });

  it("starts a 1v1 immediately once both queued players vote for 1v1", async () => {
    const manager = createManager();
    const queueMessage = createDiscordMessage({ id: "queue-message-1" });
    const repositories = createInMemoryRepositories(["player-1", "player-2"].map((id) => queuePlayer(id)));
    const context = createGuildRuntimeTestContext(repositories, { queueMessage });
    context.config.enabledMatchSizes = [1, 2, 3];
    const voteOneVOne = createVoteMatchSizeCustomId(1);
    allowQueueSurface(context, queueMessage, [ButtonCustomID.JoinQueue, ButtonCustomID.LeaveQueue, voteOneVOne]);
    const refreshQueueSurfaceSpy = jest.spyOn(
      manager as unknown as {
        refreshQueueSurface: (
          guildContext: GuildContext,
          players?: ReadonlyArray<Readonly<PlayerInQueue>>
        ) => Promise<void>;
      },
      "refreshQueueSurface"
    );

    try {
      await manager.handleButtonInteraction(context, createButtonInteraction(voteOneVOne, queueMessage, "player-1"));
      refreshQueueSurfaceSpy.mockClear();

      await manager.handleButtonInteraction(context, createButtonInteraction(voteOneVOne, queueMessage, "player-2"));
      expect(refreshQueueSurfaceSpy).toHaveBeenCalledTimes(1);
      await context.scheduler.drain();
    } finally {
      refreshQueueSurfaceSpy.mockRestore();
    }

    const finalQueue = await context.repositories.queue.getAllBallChasersInQueue();
    const activeMatch = await context.repositories.activeMatch.getAllPlayersInActiveMatch("player-1");

    expect(finalQueue).toHaveLength(0);
    expect(activeMatch.blueTeam).toHaveLength(1);
    expect(activeMatch.orangeTeam).toHaveLength(1);
    expect(context.voteState.selectedMatchSize).toBeNull();
    expect(queueMessage.reply).toHaveBeenCalledTimes(1);
  });

  it("records larger lower-tier votes at their exact queue size when a higher tier is enabled", async () => {
    const manager = createManager();
    const queueMessage = createDiscordMessage({ id: "queue-message-1" });
    const repositories = createMockRepositories({
      queue: {
        getAllBallChasersInQueue: jest.fn(async () =>
          Array.from({ length: 8 }, (_, index) => queuePlayer(`player-${index + 1}`))
        ),
      },
    });
    const context = createGuildRuntimeTestContext(repositories, { queueMessage });
    context.config.enabledMatchSizes = [2, 4, 5];
    const voteFourVFour = createVoteMatchSizeCustomId(4);
    allowQueueSurface(context, queueMessage, [ButtonCustomID.JoinQueue, ButtonCustomID.LeaveQueue, voteFourVFour]);

    await manager.handleButtonInteraction(context, createButtonInteraction(voteFourVFour, queueMessage, "player-1"));
    await context.scheduler.drain();

    expect(context.voteState.sizeVotes.get("player-1")).toBe(4);
    expect(queueMessage.edit).toHaveBeenCalledTimes(1);
  });

  it("ignores a lower-tier vote when the queue size is no longer an exact match", async () => {
    const manager = createManager();
    const queueMessage = createDiscordMessage({ id: "queue-message-1" });
    const repositories = createMockRepositories({
      queue: {
        getAllBallChasersInQueue: jest.fn(async () =>
          Array.from({ length: 5 }, (_, index) => queuePlayer(`player-${index + 1}`))
        ),
      },
    });
    const context = createGuildRuntimeTestContext(repositories, { queueMessage });
    const voteTwoVTwo = createVoteMatchSizeCustomId(2);
    allowQueueSurface(context, queueMessage, [ButtonCustomID.JoinQueue, ButtonCustomID.LeaveQueue, voteTwoVTwo]);

    await manager.handleButtonInteraction(context, createButtonInteraction(voteTwoVTwo, queueMessage, "player-1"));
    await context.scheduler.drain();

    expect(context.voteState.sizeVotes.size).toBe(0);
    expect(queueMessage.edit).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("Vote 2v2 | IGNORED | 2v2 voting is unavailable at the current queue size")
    );
  });

  it("overwrites a queued player's captains/random vote when they change their mind", async () => {
    jest.useFakeTimers({ now: new Date("2026-04-04T12:00:00.000Z").getTime() });
    const manager = createManager();
    const queueMessage = createDiscordMessage({ id: "queue-message-1" });
    const queuedPlayers = Array.from({ length: 6 }, (_, index) => queuePlayer(`player-${index + 1}`));
    const repositories = createMockRepositories({
      queue: {
        getAllBallChasersInQueue: jest.fn(async () => queuedPlayers),
        isPlayerInQueue: jest.fn(async () => true),
      },
    });
    const context = createGuildRuntimeTestContext(repositories, { queueMessage });
    allowQueueSurface(context, queueMessage, [
      ButtonCustomID.LeaveQueue,
      ButtonCustomID.ChooseTeam,
      ButtonCustomID.CreateRandomTeam,
    ]);

    await manager.handleButtonInteraction(
      context,
      createButtonInteraction(ButtonCustomID.ChooseTeam, queueMessage, "player-1")
    );
    await manager.handleButtonInteraction(
      context,
      createButtonInteraction(ButtonCustomID.CreateRandomTeam, queueMessage, "player-1")
    );
    await context.scheduler.drain();

    expect(context.voteState.captainsRandomVotes.get("player-1")).toBe(ButtonCustomID.CreateRandomTeam);
  });

  it("uses a threshold of three random votes after 2v2 is selected", async () => {
    const manager = createManager();
    const queueMessage = createDiscordMessage({ id: "queue-message-1" });
    const repositories = createInMemoryRepositories(
      ["player-1", "player-2", "player-3", "player-4"].map((id) => queuePlayer(id))
    );
    const context = createGuildRuntimeTestContext(repositories, { queueMessage });
    context.voteState.selectedMatchSize = 2;
    allowQueueSurface(context, queueMessage, [
      ButtonCustomID.LeaveQueue,
      ButtonCustomID.ChooseTeam,
      ButtonCustomID.CreateRandomTeam,
    ]);
    const publishSpy = jest.spyOn(
      manager as unknown as {
        publishActiveMatch: (
          guildContext: GuildContext,
          sourceMessage: Message,
          match: ActiveMatchCreated
        ) => Promise<void>;
      },
      "publishActiveMatch"
    );
    const refreshQueueSurfaceSpy = jest.spyOn(
      manager as unknown as {
        refreshQueueSurface: (
          guildContext: GuildContext,
          players?: ReadonlyArray<Readonly<PlayerInQueue>>
        ) => Promise<void>;
      },
      "refreshQueueSurface"
    );

    try {
      await manager.handleButtonInteraction(
        context,
        createButtonInteraction(ButtonCustomID.CreateRandomTeam, queueMessage, "player-1")
      );
      await manager.handleButtonInteraction(
        context,
        createButtonInteraction(ButtonCustomID.CreateRandomTeam, queueMessage, "player-2")
      );
      expect(publishSpy).not.toHaveBeenCalled();
      refreshQueueSurfaceSpy.mockClear();

      await manager.handleButtonInteraction(
        context,
        createButtonInteraction(ButtonCustomID.CreateRandomTeam, queueMessage, "player-3")
      );

      expect(publishSpy).toHaveBeenCalledTimes(1);
      expect(refreshQueueSurfaceSpy).toHaveBeenCalledTimes(1);
    } finally {
      refreshQueueSurfaceSpy.mockRestore();
      publishSpy.mockRestore();
    }
  });

  it("requires the orange captain to draft two players during the 4v4 snake step", async () => {
    const manager = createManager();
    const queueMessage = createDiscordMessage({ id: "queue-message-1" });
    const players = [
      queuePlayer("captain-blue", { isCap: true, team: Team.Blue }),
      queuePlayer("captain-orange", { isCap: true, team: Team.Orange }),
      queuePlayer("blue-picked", { team: Team.Blue }),
      queuePlayer("available-1"),
      queuePlayer("available-2"),
      queuePlayer("available-3"),
      queuePlayer("available-4"),
      queuePlayer("available-5"),
    ];
    const repositories = createInMemoryRepositories(players);
    const context = createGuildRuntimeTestContext(repositories, { queueMessage });
    context.config.enabledMatchSizes = [4];
    context.voteState.captainDraftStepIndex = 1;
    context.surfaceRegistry.upsert(queueMessage.id, "queue", {
      allowedActions: new Set<string>([MenuCustomID.OrangeSelect]),
      allowedValues: new Set<string>(["available-1", "available-2", "available-3", "available-4", "available-5"]),
      state: "captain_orange_pick",
    });

    await manager.handleSelectMenuInteraction(
      context,
      createSelectMenuInteraction(
        MenuCustomID.OrangeSelect,
        ["available-1", "available-2"],
        queueMessage,
        "captain-orange"
      )
    );
    await context.scheduler.drain();

    const finalQueue = await context.repositories.queue.getAllBallChasersInQueue();
    expect(finalQueue.find((player) => player.id === "available-1")?.team).toBe(Team.Orange);
    expect(finalQueue.find((player) => player.id === "available-2")?.team).toBe(Team.Orange);
    expect(context.voteState.captainDraftStepIndex).toBe(2);
  });

  it("only allows the blue captain to make the blue draft pick", async () => {
    const manager = createManager();
    const queueMessage = createDiscordMessage({ id: "queue-message-1" });
    const players = [
      queuePlayer("captain-blue", { isCap: true, team: Team.Blue }),
      queuePlayer("captain-orange", { isCap: true, team: Team.Orange }),
      queuePlayer("available-player"),
    ];
    const repositories = createMockRepositories({
      queue: {
        getAllBallChasersInQueue: jest.fn(async () => players),
        isTeamCaptain: jest.fn(async (id: string, team: Team) => id === "captain-blue" && team === Team.Blue),
        updateBallChaserInQueue: jest.fn(async () => undefined),
      },
    });
    const context = createGuildRuntimeTestContext(repositories, { queueMessage });
    context.surfaceRegistry.upsert(queueMessage.id, "queue", {
      allowedActions: new Set<string>([MenuCustomID.BlueSelect]),
      allowedValues: new Set<string>(["available-player"]),
      state: "captain_blue_pick",
    });

    await manager.handleSelectMenuInteraction(
      context,
      createSelectMenuInteraction(MenuCustomID.BlueSelect, ["available-player"], queueMessage, "spectator")
    );
    await context.scheduler.drain();
    expect(context.repositories.queue.updateBallChaserInQueue).not.toHaveBeenCalled();

    await manager.handleSelectMenuInteraction(
      context,
      createSelectMenuInteraction(MenuCustomID.BlueSelect, ["available-player"], queueMessage, "captain-blue")
    );
    await context.scheduler.drain();

    expect(context.repositories.queue.updateBallChaserInQueue).toHaveBeenCalledWith({
      id: "available-player",
      team: Team.Blue,
    });
  });

  it("ignores stale queue interactions without side effects", async () => {
    const manager = createManager();
    const queueMessage = createDiscordMessage({ id: "queue-message-1" });
    const repositories = createMockRepositories();
    const context = createGuildRuntimeTestContext(repositories, { queueMessage });

    await manager.handleButtonInteraction(
      context,
      createButtonInteraction(ButtonCustomID.JoinQueue, queueMessage, "player-1", "Destroyer")
    );
    await context.scheduler.drain();

    expect(context.repositories.queue.addBallChaserToQueue).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining("Destroyer | Join Queue | IGNORED | stale interaction on message queue-message-1")
    );
  });

  it("does not let users outside the active match report or break the match", async () => {
    const manager = createManager();
    const matchMessage = createDiscordMessage({
      embeds: [{ title: "Current Match" }],
      id: "match-message-1",
    });
    const repositories = createMockRepositories({
      activeMatch: {
        getAllBrokenQueueVotesInActiveMatch: jest.fn(async () => 0),
        getAllPlayersInActiveMatch: jest.fn(async () => ({
          blueTeam: [activeMatchPlayer("blue-1", Team.Blue)],
          orangeTeam: [activeMatchPlayer("orange-1", Team.Orange)],
        })),
        getPlayerInActiveMatch: jest.fn(async () => null),
        isPlayerInActiveMatch: jest.fn(async () => false),
      },
    });
    const context = createGuildRuntimeTestContext(repositories, {
      queueMessage: createDiscordMessage({ id: "queue-message-1" }),
    });
    context.surfaceRegistry.upsert(matchMessage.id, "match", {
      allowedActions: new Set<string>([
        ButtonCustomID.BrokenQueue,
        ButtonCustomID.ReportBlue,
        ButtonCustomID.ReportOrange,
      ]),
      state: "match_active",
    });

    await manager.handleButtonInteraction(
      context,
      createButtonInteraction(ButtonCustomID.ReportBlue, matchMessage, "spectator")
    );
    await manager.handleButtonInteraction(
      context,
      createButtonInteraction(ButtonCustomID.BrokenQueue, matchMessage, "spectator")
    );
    await context.scheduler.drain();

    expect(context.repositories.activeMatch.updatePlayerInActiveMatch).not.toHaveBeenCalled();
    expect(matchMessage.edit).not.toHaveBeenCalled();
    expect(matchMessage.delete).not.toHaveBeenCalled();
  });

  it("serializes rapid join and leave requests from the same user into one deterministic final state", async () => {
    const manager = createManager();
    const queueMessage = createDiscordMessage({ id: "queue-message-1" });
    const repositories = createInMemoryRepositories();
    const context = createGuildRuntimeTestContext(repositories, { queueMessage });
    allowQueueSurface(context, queueMessage, [ButtonCustomID.JoinQueue, ButtonCustomID.LeaveQueue]);

    await Promise.all([
      manager.handleButtonInteraction(
        context,
        createButtonInteraction(ButtonCustomID.JoinQueue, queueMessage, "player-1")
      ),
      manager.handleButtonInteraction(
        context,
        createButtonInteraction(ButtonCustomID.LeaveQueue, queueMessage, "player-1")
      ),
      manager.handleButtonInteraction(
        context,
        createButtonInteraction(ButtonCustomID.JoinQueue, queueMessage, "player-1")
      ),
    ]);
    await context.scheduler.drain();

    const finalQueue = await context.repositories.queue.getAllBallChasersInQueue();
    expect(finalQueue.map((player) => player.id)).toEqual(["player-1"]);
  });

  it("serializes simultaneous joins without creating duplicate queue rows", async () => {
    const manager = createManager();
    const queueMessage = createDiscordMessage({ id: "queue-message-1" });
    const repositories = createInMemoryRepositories();
    const context = createGuildRuntimeTestContext(repositories, { queueMessage });
    allowQueueSurface(context, queueMessage, [ButtonCustomID.JoinQueue, ButtonCustomID.LeaveQueue]);

    await Promise.all([
      manager.handleButtonInteraction(
        context,
        createButtonInteraction(ButtonCustomID.JoinQueue, queueMessage, "player-1")
      ),
      manager.handleButtonInteraction(
        context,
        createButtonInteraction(ButtonCustomID.JoinQueue, queueMessage, "player-2")
      ),
      manager.handleButtonInteraction(
        context,
        createButtonInteraction(ButtonCustomID.JoinQueue, queueMessage, "player-1")
      ),
    ]);
    await context.scheduler.drain();

    const finalQueue = await context.repositories.queue.getAllBallChasersInQueue();
    expect(finalQueue.map((player) => player.id).sort()).toEqual(["player-1", "player-2"]);
  });

  it("serializes simultaneous reports into one consistent confirmed match result", async () => {
    const manager = createManager();
    const matchMessage = createDiscordMessage({
      embeds: [{ title: "Current Match" }],
      id: "match-message-1",
    });
    const repositories = createInMemoryRepositories(
      [],
      [
        activeMatchPlayer("blue-1", Team.Blue),
        activeMatchPlayer("blue-2", Team.Blue),
        activeMatchPlayer("orange-1", Team.Orange),
        activeMatchPlayer("orange-2", Team.Orange),
      ]
    );
    const context = createGuildRuntimeTestContext(repositories, {
      queueMessage: createDiscordMessage({ id: "queue-message-1" }),
    });
    context.surfaceRegistry.upsert(matchMessage.id, "match", {
      allowedActions: new Set<string>([
        ButtonCustomID.BrokenQueue,
        ButtonCustomID.ReportBlue,
        ButtonCustomID.ReportOrange,
      ]),
      state: "match_active",
    });

    await Promise.all([
      manager.handleButtonInteraction(
        context,
        createButtonInteraction(ButtonCustomID.ReportBlue, matchMessage, "blue-1")
      ),
      manager.handleButtonInteraction(
        context,
        createButtonInteraction(ButtonCustomID.ReportBlue, matchMessage, "orange-1")
      ),
    ]);
    await context.scheduler.drain();

    const activeTeams = await context.repositories.activeMatch.getAllPlayersInActiveMatch("blue-1");
    expect(activeTeams.blueTeam).toHaveLength(0);
    expect(activeTeams.orangeTeam).toHaveLength(0);
    expect(context.repositories.leaderboard.updatePlayersStats).toHaveBeenCalledTimes(1);
  });

  it("does not hold the queue mutex while a queue render is still in flight", async () => {
    jest.useFakeTimers({ now: new Date("2026-04-04T12:00:00.000Z").getTime() });
    const manager = createManager();
    const queueMessage = createDiscordMessage({ id: "queue-message-1" });
    let releaseFirstEdit: (() => void) | undefined;
    let editCalls = 0;
    (queueMessage.edit as jest.Mock).mockImplementation(async () => {
      editCalls += 1;
      if (editCalls === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstEdit = resolve;
        });
      }

      return queueMessage;
    });

    const repositories = createInMemoryRepositories();
    const context = createGuildRuntimeTestContext(repositories, { queueMessage });
    allowQueueSurface(context, queueMessage, [ButtonCustomID.JoinQueue, ButtonCustomID.LeaveQueue]);

    await manager.handleButtonInteraction(
      context,
      createButtonInteraction(ButtonCustomID.JoinQueue, queueMessage, "player-1")
    );
    await flushSurfaceWindow(context);
    expect(queueMessage.edit).toHaveBeenCalledTimes(1);

    await manager.handleButtonInteraction(
      context,
      createButtonInteraction(ButtonCustomID.JoinQueue, queueMessage, "player-2")
    );

    const queuedPlayersBeforeRenderRelease = await context.repositories.queue.getAllBallChasersInQueue();
    expect(queuedPlayersBeforeRenderRelease.map((player) => player.id).sort()).toEqual(["player-1", "player-2"]);
    expect(queueMessage.edit).toHaveBeenCalledTimes(1);

    releaseFirstEdit?.();
    await Promise.resolve();
    await flushSurfaceWindow(context, 1250);
    expect(queueMessage.edit).toHaveBeenCalledTimes(2);
  });

  it("renders the latest queue state once per 1250ms window instead of editing once per join click", async () => {
    jest.useFakeTimers({ now: new Date("2026-04-04T12:00:00.000Z").getTime() });
    const manager = createManager();
    const queueMessage = createDiscordMessage({ id: "queue-message-1" });
    const repositories = createInMemoryRepositories();
    const context = createGuildRuntimeTestContext(repositories, { queueMessage });
    allowQueueSurface(context, queueMessage, [ButtonCustomID.JoinQueue, ButtonCustomID.LeaveQueue]);

    await manager.handleButtonInteraction(
      context,
      createButtonInteraction(ButtonCustomID.JoinQueue, queueMessage, "player-1")
    );
    await flushSurfaceWindow(context);
    expect(queueMessage.edit).toHaveBeenCalledTimes(1);

    await Promise.all([
      manager.handleButtonInteraction(
        context,
        createButtonInteraction(ButtonCustomID.JoinQueue, queueMessage, "player-2")
      ),
      manager.handleButtonInteraction(
        context,
        createButtonInteraction(ButtonCustomID.JoinQueue, queueMessage, "player-3")
      ),
    ]);

    const queuedPlayersBeforeRenderRelease = await context.repositories.queue.getAllBallChasersInQueue();
    expect(queuedPlayersBeforeRenderRelease.map((player) => player.id).sort()).toEqual([
      "player-1",
      "player-2",
      "player-3",
    ]);
    expect(queueMessage.edit).toHaveBeenCalledTimes(1);

    await flushSurfaceWindow(context, 1249);
    expect(queueMessage.edit).toHaveBeenCalledTimes(1);

    await flushSurfaceWindow(context, 1);
    expect(queueMessage.edit).toHaveBeenCalledTimes(2);
  });

  it("silently skips queue edits when a refreshed queue timer would not change the visible payload", async () => {
    jest.useFakeTimers({ now: new Date("2026-04-04T12:00:00.000Z").getTime() });
    const manager = createManager();
    const queueMessage = createDiscordMessage({ id: "queue-message-1" });
    const repositories = createInMemoryRepositories();
    const context = createGuildRuntimeTestContext(repositories, { queueMessage });
    allowQueueSurface(context, queueMessage, [ButtonCustomID.JoinQueue, ButtonCustomID.LeaveQueue]);

    await manager.handleButtonInteraction(
      context,
      createButtonInteraction(ButtonCustomID.JoinQueue, queueMessage, "player-1")
    );
    await flushSurfaceWindow(context);
    expect(queueMessage.edit).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1250);
    await manager.handleButtonInteraction(
      context,
      createButtonInteraction(ButtonCustomID.JoinQueue, queueMessage, "player-1")
    );
    await flushSurfaceWindow(context);

    expect(queueMessage.edit).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("Join Queue | PROCESSED | refreshed queue timer"));
    expect(infoSpy).not.toHaveBeenCalledWith(expect.stringContaining("Skipped hot-surface render"));
  });

  it("supersedes a queued retry with the latest queue state after a lane-local rate limit", async () => {
    jest.useFakeTimers({ now: new Date("2026-04-04T12:00:00.000Z").getTime() });
    const manager = createManager();
    const queueMessage = createDiscordMessage({ id: "queue-message-1" });
    let editCalls = 0;
    (queueMessage.edit as jest.Mock).mockImplementation(async (payload) => {
      editCalls += 1;
      if (editCalls === 1) {
        throw { retryAfter: 0.05 };
      }

      return queueMessage;
    });

    const repositories = createInMemoryRepositories();
    const context = createGuildRuntimeTestContext(repositories, { queueMessage });
    allowQueueSurface(context, queueMessage, [ButtonCustomID.JoinQueue, ButtonCustomID.LeaveQueue]);

    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await manager.handleButtonInteraction(
        context,
        createButtonInteraction(ButtonCustomID.JoinQueue, queueMessage, "player-1")
      );
      await jest.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(queueMessage.edit).toHaveBeenCalledTimes(1);

      await manager.handleButtonInteraction(
        context,
        createButtonInteraction(ButtonCustomID.LeaveQueue, queueMessage, "player-1")
      );
      expect(await context.repositories.queue.getAllBallChasersInQueue()).toHaveLength(0);

      await jest.advanceTimersByTimeAsync(49);
      await Promise.resolve();
      expect(queueMessage.edit).toHaveBeenCalledTimes(1);

      await flushSurfaceWindow(context, 1);
      expect(queueMessage.edit).toHaveBeenCalledTimes(2);
      expect(asEmbedSummary((queueMessage.edit as jest.Mock).mock.calls.at(-1)?.[0])).toContain("Queue is Empty");

      await flushSurfaceWindow(context, 1250);
      expect(queueMessage.edit).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("collapses active match edits until 1250ms after the last visible match update", async () => {
    jest.useFakeTimers({ now: new Date("2026-04-04T12:00:00.000Z").getTime() });
    const manager = createManager();
    const matchMessage = createDiscordMessage({
      embeds: [{ title: "Current Match" }],
      id: "match-message-1",
    });
    const repositories = createInMemoryRepositories(
      [],
      [
        activeMatchPlayer("blue-1", Team.Blue),
        activeMatchPlayer("blue-2", Team.Blue),
        activeMatchPlayer("orange-1", Team.Orange),
        activeMatchPlayer("orange-2", Team.Orange),
      ]
    );
    const context = createGuildRuntimeTestContext(repositories, {
      queueMessage: createDiscordMessage({ id: "queue-message-1" }),
    });
    context.surfaceRegistry.upsert(matchMessage.id, "match", {
      allowedActions: new Set<string>([
        ButtonCustomID.BrokenQueue,
        ButtonCustomID.ReportBlue,
        ButtonCustomID.ReportOrange,
      ]),
      state: "match_active",
    });

    await manager.handleButtonInteraction(
      context,
      createButtonInteraction(ButtonCustomID.BrokenQueue, matchMessage, "blue-1")
    );
    await flushSurfaceWindow(context);
    expect(matchMessage.edit).toHaveBeenCalledTimes(1);

    await manager.handleButtonInteraction(
      context,
      createButtonInteraction(ButtonCustomID.BrokenQueue, matchMessage, "orange-1")
    );
    expect(matchMessage.edit).toHaveBeenCalledTimes(1);

    await flushSurfaceWindow(context, 1249);
    expect(matchMessage.edit).toHaveBeenCalledTimes(1);

    await flushSurfaceWindow(context, 1);
    expect(matchMessage.edit).toHaveBeenCalledTimes(2);
  });
});
