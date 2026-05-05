import { BallChaserQueueBuilder } from "../../../../.jest/Builder";
import { ActiveMatchCreated } from "../../../domain/match";
import MessageBuilder from "../MessageBuilder";
import { PlayerInActiveMatch } from "../../../repositories/ActiveMatchRepository/types";
import { Team } from "../../../types/common";

jest.mock("../../utils");

describe("Building Buttons", () => {
  const mockBallChasers = BallChaserQueueBuilder.many(6);
  const mockMatchId = "1234";

  const getActionRowJson = (result: { components?: ReadonlyArray<unknown> }): unknown => {
    const actionRow = result.components?.[0] as { toJSON?: () => unknown } | undefined;
    if (actionRow && typeof actionRow.toJSON === "function") {
      return actionRow.toJSON();
    }
    return actionRow;
  };
  const getEmbedDescription = (result: { embeds?: ReadonlyArray<unknown> }): string => {
    const embed = result.embeds?.[0] as { toJSON?: () => { description?: unknown } } | undefined;
    const description = embed?.toJSON?.().description;
    return typeof description === "string" ? description : "";
  };

  it("return queue buttons", () => {
    const result = MessageBuilder.queueMessage(mockBallChasers, 6);
    expect(getActionRowJson(result)).toEqual({
      components: [
        expect.objectContaining({ custom_id: "joinQueue", label: "Join", style: 3, type: 2 }),
        expect.objectContaining({ custom_id: "leaveQueue", label: "Leave", style: 4, type: 2 }),
      ],
      type: 1,
    });
  });
  it("return full queue buttons", () => {
    const result = MessageBuilder.fullQueueMessage(mockBallChasers, 3);
    expect(getActionRowJson(result)).toEqual({
      components: [
        expect.objectContaining({ custom_id: "chooseTeam", label: "Captains (0)", style: 1, type: 2 }),
        expect.objectContaining({ custom_id: "randomizeTeams", label: "Random (0)", style: 1, type: 2 }),
        expect.objectContaining({ custom_id: "leaveQueue", label: "Leave", style: 4, type: 2 }),
      ],
      type: 1,
    });
  });
  it("return active match buttons", async () => {
    const orangePlayer: PlayerInActiveMatch = {
      id: mockBallChasers[0].id,
      team: Team.Orange,
      reportedTeam: null,
      matchId: mockMatchId,
      mmr: 100,
      brokenQueue: false,
    };

    const bluePlayer: PlayerInActiveMatch = {
      id: mockBallChasers[1].id,
      team: Team.Blue,
      reportedTeam: null,
      matchId: mockMatchId,
      mmr: 100,
      brokenQueue: false,
    };

    const activeMatch: ActiveMatchCreated = {
      blue: {
        mmrStake: 100,
        players: [bluePlayer],
        winProbability: 50,
      },
      orange: {
        mmrStake: 100,
        players: [orangePlayer],
        winProbability: 50,
      },
    };

    const result = await MessageBuilder.activeMatchMessage(activeMatch, 1);
    expect(getActionRowJson(result)).toEqual({
      components: [
        expect.objectContaining({ custom_id: "brokenQueue", label: "Broken Queue", style: 4, type: 2 }),
        expect.objectContaining({ custom_id: "reportBlue", style: 2, type: 2 }),
        expect.objectContaining({ custom_id: "reportOrange", style: 2, type: 2 }),
      ],
      type: 1,
    });
  });

  it("splits leaderboard embeds into Discord-safe payload batches", () => {
    const leaderboardSections = Array.from({ length: 12 }, (_, index) => `Player block ${index + 1}`);

    const payloads = MessageBuilder.leaderboardMessage(leaderboardSections);

    expect(payloads).toHaveLength(2);
    expect(payloads[0].embeds).toHaveLength(10);
    expect(payloads[1].embeds).toHaveLength(2);
  });

  it.each([
    { label: "1v1", marker: "1\uFE0F\u20E3", matchSize: 1 },
    { label: "2v2", marker: "2\uFE0F\u20E3", matchSize: 2 },
    { label: "10v10", marker: "\uD83D\uDD1F", matchSize: 10 },
    { label: "11v11", marker: "1\uFE0F\u20E31\uFE0F\u20E3", matchSize: 11 },
  ])("marks $label lower-tier voters with the match-size emoji", ({ matchSize, marker }) => {
    const voter = BallChaserQueueBuilder.single({ id: "voter" });
    const nonVoter = BallChaserQueueBuilder.single({ id: "non-voter" });
    const result = MessageBuilder.voteMatchSizeMessage(
      [voter, nonVoter],
      matchSize,
      1,
      [voter],
      new Map<string, number>([[voter.id, matchSize]])
    );

    expect(getEmbedDescription(result)).toContain(`${marker} <@${voter.id}>`);
  });

  it("leaves lower-tier non-voters unmarked", () => {
    const voter = BallChaserQueueBuilder.single({ id: "voter" });
    const nonVoter = BallChaserQueueBuilder.single({ id: "non-voter" });
    const result = MessageBuilder.voteMatchSizeMessage(
      [voter, nonVoter],
      2,
      1,
      [voter],
      new Map<string, number>([[voter.id, 2]])
    );
    const description = getEmbedDescription(result);

    expect(description).toContain(`2\uFE0F\u20E3 <@${voter.id}>`);
    expect(description).toContain(`<@${nonVoter.id}>`);
    expect(description).not.toContain(`2\uFE0F\u20E3 <@${nonVoter.id}>`);
    expect(description).not.toContain(`\u2705 <@${voter.id}>`);
  });
});
