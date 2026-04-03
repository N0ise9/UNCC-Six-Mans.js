import { LeaderboardToString } from "../LeaderboardService";
import { PlayerStats } from "../../repositories/LeaderboardRepository/types";
import LeaderboardRepository from "../../repositories/LeaderboardRepository";
import faker from "faker";
import { BallChaserQueueBuilder } from "../../../.jest/Builder";
import { PlayerInQueue } from "../../repositories/QueueRepository/types";

jest.mock("../../utils");
jest.mock("../../repositories/LeaderboardRepository");

function makePlayerStats(
  ballChaser: PlayerInQueue = BallChaserQueueBuilder.single(),
  overrides?: Partial<PlayerStats>
): PlayerStats {
  const wins = faker.datatype.number({ min: 0 });
  const losses = faker.datatype.number({ min: 0 });

  return {
    id: ballChaser.id,
    losses,
    matchesPlayed: wins + losses,
    mmr: faker.datatype.number({ min: 0 }),
    name: ballChaser.name,
    winPerc: wins / (wins + losses),
    wins,
    ...overrides,
  };
}

describe("Leaderboard Service tests", () => {
  it("sends empty message when there are no player stats", async () => {
    jest.mocked(LeaderboardRepository.getPlayersStats).mockResolvedValue([]);
    const result = await LeaderboardToString();

    expect(result).toHaveLength(1);
    expect(result[0]).toBe("Nothing to see here yet. Get queueing!");
  });

  it("separates player stats in groups of 10", async () => {
    const mockPlayers = Array.from({ length: 12 }, () => makePlayerStats());
    jest.mocked(LeaderboardRepository.getPlayersStats).mockResolvedValue(mockPlayers);
    const result = await LeaderboardToString();

    expect(result).toHaveLength(2);

    // finds all instances of the word "Rank"
    const regExPattern = new RegExp("Rank", "g");
    // first embed should have a full 10 players (10 occurences of the word "Rank")
    expect(result[0].match(regExPattern)).toHaveLength(10);
    // second embed should have the rest
    expect(result[1].match(regExPattern)).toHaveLength(2);
  });

  it("formats player stats correctly", async () => {
    const mockPlayer1: PlayerStats = {
      id: "player_id_1",
      losses: 22,
      matchesPlayed: 65,
      mmr: 123,
      name: "TwanTheSwan",
      winPerc: 0.66,
      wins: 43,
    };

    const mockPlayer2: PlayerStats = {
      id: "player_id_2",
      losses: 6,
      matchesPlayed: 16,
      mmr: 119,
      name: "h",
      winPerc: 0.63,
      wins: 10,
    };

    jest.mocked(LeaderboardRepository.getPlayersStats).mockResolvedValue([mockPlayer1, mockPlayer2]);
    const result = await LeaderboardToString();

    expect(result).toEqual([
      `Rank: 1
\tName: TwanTheSwan
\tMMR: 123
\tWins: 43
\tLosses: 22
\tMatches Played: 65
\tWin Perc: 66%

Rank: 2
\tName: h
\tMMR: 119
\tWins: 10
\tLosses: 6
\tMatches Played: 16
\tWin Perc: 63%

`,
    ]);
  });
});
