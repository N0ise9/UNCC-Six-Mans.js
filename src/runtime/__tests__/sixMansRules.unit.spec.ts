import { Team } from "../../types/common";
import { ActiveMatchBuilder, BallChaserQueueBuilder } from "../../../.jest/Builder";
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
} from "../sixMansRules";
import { ButtonCustomID } from "../../utils/MessageHelper/CustomButtons";

describe("sixMansRules", () => {
  it("returns the correct queue target size for 6s and 2s", () => {
    expect(getQueueTargetSize(false)).toBe(6);
    expect(getQueueTargetSize(true)).toBe(4);
  });

  it("counts captains, random, and twos votes correctly", () => {
    const captainsRandomVotes = new Map<string, string>([
      ["player-1", ButtonCustomID.ChooseTeam],
      ["player-2", ButtonCustomID.CreateRandomTeam],
      ["player-3", ButtonCustomID.ChooseTeam],
    ]);
    const twosVotes = new Map<string, string>([
      ["player-1", ButtonCustomID.Twos],
      ["player-2", ButtonCustomID.Twos],
      ["player-3", ButtonCustomID.JoinQueue],
    ]);

    expect(countCaptainsRandomVotes(captainsRandomVotes)).toEqual({
      captains: 2,
      random: 1,
    });
    expect(countTwosVotes(twosVotes)).toBe(2);
  });

  it("chooses the top two players as captains with orange picking first", () => {
    const players = [
      BallChaserQueueBuilder.single({ id: "player-a", mmr: 120 }),
      BallChaserQueueBuilder.single({ id: "player-b", mmr: 155 }),
      BallChaserQueueBuilder.single({ id: "player-c", mmr: 180 }),
      BallChaserQueueBuilder.single({ id: "player-d", mmr: 140 }),
    ];

    expect(chooseCaptains(players)).toEqual({
      blueCaptainId: "player-b",
      orangeCaptainId: "player-c",
    });
  });

  it("creates balanced random teams deterministically with an injected rng", () => {
    const players = [
      BallChaserQueueBuilder.single({ id: "player-a", mmr: 100 }),
      BallChaserQueueBuilder.single({ id: "player-b", mmr: 110 }),
      BallChaserQueueBuilder.single({ id: "player-c", mmr: 120 }),
      BallChaserQueueBuilder.single({ id: "player-d", mmr: 130 }),
      BallChaserQueueBuilder.single({ id: "player-e", mmr: 140 }),
      BallChaserQueueBuilder.single({ id: "player-f", mmr: 150 }),
    ];
    const sequence = [0.9, 0.1, 0.8, 0.2, 0.7, 0.3];
    let index = 0;

    const teams = createRandomTeams(players, () => sequence[index++]);

    expect(teams).toEqual([
      { id: "player-a", team: Team.Orange },
      { id: "player-b", team: Team.Blue },
      { id: "player-c", team: Team.Orange },
      { id: "player-d", team: Team.Blue },
      { id: "player-e", team: Team.Orange },
      { id: "player-f", team: Team.Blue },
    ]);
  });

  it("calculates equal win probability and a 10 mmr stake for equal teams", () => {
    const teams = {
      blueTeam: [
        ActiveMatchBuilder.single({ id: "blue-1", team: Team.Blue, mmr: 100 }),
        ActiveMatchBuilder.single({ id: "blue-2", team: Team.Blue, mmr: 150 }),
      ],
      orangeTeam: [
        ActiveMatchBuilder.single({ id: "orange-1", team: Team.Orange, mmr: 120 }),
        ActiveMatchBuilder.single({ id: "orange-2", team: Team.Orange, mmr: 130 }),
      ],
    };

    const { blueProbabilityDecimal, orangeProbabilityDecimal } = calculateProbabilityDecimal(teams);

    expect(blueProbabilityDecimal).toBeCloseTo(0.5, 5);
    expect(orangeProbabilityDecimal).toBeCloseTo(0.5, 5);
    expect(calculateProbability(blueProbabilityDecimal)).toBe(50);
    expect(calculateMMR(blueProbabilityDecimal)).toBe(10);
  });

  it("clamps mmr changes between 5 and 15", () => {
    expect(calculateMMR(0.01)).toBe(15);
    expect(calculateMMR(0.99)).toBe(5);
  });

  it("records the first valid report", () => {
    const teams = {
      blueTeam: [ActiveMatchBuilder.single({ id: "blue-1", team: Team.Blue, reportedTeam: null })],
      orangeTeam: [ActiveMatchBuilder.single({ id: "orange-1", team: Team.Orange, reportedTeam: null })],
    };

    expect(resolveMatchReport(teams, "blue-1", Team.Blue)).toMatchObject({
      kind: "record",
      reportedTeam: Team.Blue,
      reporter: expect.objectContaining({ id: "blue-1" }),
    });
  });

  it("ignores duplicate same-team confirmation attempts", () => {
    const teams = {
      blueTeam: [ActiveMatchBuilder.single({ id: "blue-1", team: Team.Blue, reportedTeam: Team.Blue })],
      orangeTeam: [ActiveMatchBuilder.single({ id: "orange-1", team: Team.Orange, reportedTeam: null })],
    };

    expect(resolveMatchReport(teams, "blue-1", Team.Blue)).toMatchObject({
      kind: "ignore",
      reportedTeam: Team.Blue,
      reporter: expect.objectContaining({ id: "blue-1" }),
    });
  });

  it("confirms a match when opposite teams report the same winner", () => {
    const teams = {
      blueTeam: [ActiveMatchBuilder.single({ id: "blue-1", team: Team.Blue, reportedTeam: Team.Blue })],
      orangeTeam: [ActiveMatchBuilder.single({ id: "orange-1", team: Team.Orange, reportedTeam: null })],
    };

    expect(resolveMatchReport(teams, "orange-1", Team.Blue)).toMatchObject({
      kind: "confirm",
      reportedTeam: Team.Blue,
      reporter: expect.objectContaining({ id: "orange-1" }),
    });
  });

  it("records a conflicting report instead of confirming the match", () => {
    const teams = {
      blueTeam: [ActiveMatchBuilder.single({ id: "blue-1", team: Team.Blue, reportedTeam: Team.Blue })],
      orangeTeam: [ActiveMatchBuilder.single({ id: "orange-1", team: Team.Orange, reportedTeam: null })],
    };

    expect(resolveMatchReport(teams, "orange-1", Team.Orange)).toMatchObject({
      kind: "record",
      reportedTeam: Team.Orange,
      reporter: expect.objectContaining({ id: "orange-1" }),
    });
  });

  it("ignores reports from users who are not in the active match", () => {
    const teams = {
      blueTeam: [ActiveMatchBuilder.single({ id: "blue-1", team: Team.Blue, reportedTeam: null })],
      orangeTeam: [ActiveMatchBuilder.single({ id: "orange-1", team: Team.Orange, reportedTeam: null })],
    };

    expect(resolveMatchReport(teams, "spectator", Team.Blue)).toEqual({
      kind: "ignore",
      reportedTeam: Team.Blue,
      reporter: null,
    });
  });
});
