import { BallChaserQueueBuilder } from "../../../../.jest/Builder";
import { ActiveMatchCreated } from "../../../services/MatchService";
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

  it("return queue buttons", () => {
    const result = MessageBuilder.queueMessage(mockBallChasers);
    expect(getActionRowJson(result)).toEqual({
      components: [
        expect.objectContaining({ custom_id: "joinQueue", label: "Join", style: 3, type: 2 }),
        expect.objectContaining({ custom_id: "leaveQueue", label: "Leave", style: 4, type: 2 }),
      ],
      type: 1,
    });
  });
  it("return full queue buttons", () => {
    const result = MessageBuilder.fullQueueMessage(mockBallChasers);
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
});
