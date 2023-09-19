import faker from "faker";
import { BallChaserQueueBuilder } from "../../../../.jest/Builder";
import { ActiveMatchCreated } from "../../../services/MatchService";
import MessageBuilder from "../MessageBuilder";
import { PlayerInActiveMatch } from "../../../repositories/ActiveMatchRepository/types";
import { Team } from "../../../types/common";

jest.mock("../../utils");

describe("Building Buttons", () => {
  const mockBallChasers = BallChaserQueueBuilder.many(6);
  const mockMatchId = "1234";

  it("return queue buttons", () => {
    const result = MessageBuilder.queueMessage(mockBallChasers);
    expect(result.components).toMatchSnapshot();
  });
  it("return full queue buttons", () => {
    const result = MessageBuilder.fullQueueMessage(mockBallChasers);
    expect(result.components).toMatchSnapshot();
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

    const result = await MessageBuilder.activeMatchMessage(activeMatch);
    expect(result.components).toMatchSnapshot();
  });
});
