import {
  ActiveMatchTeams,
  NewActiveMatchInput,
  PlayerInActiveMatch,
} from "../repositories/ActiveMatchRepository/types";
import { PlayerInQueue } from "../repositories/QueueRepository/types";
import { Team } from "../types/common";
import { ButtonCustomID } from "../utils/MessageHelper/CustomButtons";

export interface ProbabilityDecimalResult {
  blueProbabilityDecimal: number;
  orangeProbabilityDecimal: number;
}

export interface CaptainsRandomVoteSummary {
  captains: number;
  random: number;
}

export type MatchReportResolution =
  | {
      kind: "confirm";
      reporter: PlayerInActiveMatch;
      reportedTeam: Team;
    }
  | {
      kind: "ignore";
      reporter: PlayerInActiveMatch | null;
      reportedTeam: Team;
    }
  | {
      kind: "record";
      reporter: PlayerInActiveMatch;
      reportedTeam: Team;
    };

export function getQueueTargetSize(twosEnabled: boolean): number {
  return twosEnabled ? 4 : 6;
}

export function countCaptainsRandomVotes(votes: ReadonlyMap<string, string>): CaptainsRandomVoteSummary {
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

export function countTwosVotes(votes: ReadonlyMap<string, string>): number {
  let twos = 0;

  for (const value of votes.values()) {
    if (value === ButtonCustomID.Twos) {
      twos += 1;
    }
  }

  return twos;
}

export function chooseCaptains(ballChasers: ReadonlyArray<Readonly<PlayerInQueue>>): {
  blueCaptainId: string;
  orangeCaptainId: string;
} {
  const sortedBallChaser = ballChasers.slice().sort((left, right) => right.mmr - left.mmr);

  return {
    blueCaptainId: sortedBallChaser[1].id,
    orangeCaptainId: sortedBallChaser[0].id,
  };
}

export function createRandomTeams(
  ballChasers: ReadonlyArray<Readonly<PlayerInQueue>>,
  random: () => number = Math.random
): Array<NewActiveMatchInput> {
  const sortedBallChaser = ballChasers.slice().sort((left, right) => left.mmr - right.mmr);
  const activeMatch: NewActiveMatchInput[] = [];
  let orangeTeamCounter = 0;
  let blueTeamCounter = 0;

  sortedBallChaser.forEach((player) => {
    if (random() >= 0.5) {
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

export function calculateProbabilityDecimal(teams: ActiveMatchTeams): ProbabilityDecimalResult {
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

export function calculateMMR(calculatedProbabilityDecimal: number): number {
  let mmr = (1 - calculatedProbabilityDecimal) * 20;
  mmr = Math.min(15, mmr);
  mmr = Math.max(5, mmr);
  return Math.round(mmr);
}

export function calculateProbability(calculatedProbabilityDecimal: number): number {
  return Math.round(calculatedProbabilityDecimal * 100);
}

export function resolveMatchReport(
  teams: ActiveMatchTeams,
  playerInMatchId: string,
  reportedTeam: Team
): MatchReportResolution {
  const players = [...teams.blueTeam, ...teams.orangeTeam];
  const reporter = players.find((player) => player.id === playerInMatchId) ?? null;
  const previousReporter = players.find((player) => player.reportedTeam !== null);

  if (!reporter) {
    return {
      kind: "ignore",
      reportedTeam,
      reporter: null,
    };
  }

  if (previousReporter?.team === reporter.team && previousReporter.reportedTeam === reportedTeam) {
    return {
      kind: "ignore",
      reportedTeam,
      reporter,
    };
  }

  if (previousReporter?.reportedTeam !== reportedTeam || previousReporter?.id === reporter.id) {
    return {
      kind: "record",
      reportedTeam,
      reporter,
    };
  }

  return {
    kind: "confirm",
    reportedTeam,
    reporter,
  };
}
