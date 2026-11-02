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

export interface CaptainDraftStep {
  picks: number;
  team: Team;
}

export const MIN_MATCH_SIZE = 1;
export const MAX_MATCH_SIZE = 12;
export const DEFAULT_ENABLED_MATCH_SIZES = [2, 3] as const;

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

export function normalizeEnabledMatchSizes(sizes: ReadonlyArray<number> | undefined | null): number[] {
  const candidateSizes = sizes ?? DEFAULT_ENABLED_MATCH_SIZES;

  return [...new Set(candidateSizes)]
    .filter((size) => Number.isInteger(size) && size >= MIN_MATCH_SIZE && size <= MAX_MATCH_SIZE)
    .sort((left, right) => left - right);
}

export function formatMatchSizeLabel(matchSize: number): string {
  return `${matchSize}v${matchSize}`;
}

export function getHighestEnabledMatchSize(enabledMatchSizes: ReadonlyArray<number>): number {
  const normalized = normalizeEnabledMatchSizes(enabledMatchSizes);
  return normalized[normalized.length - 1] ?? DEFAULT_ENABLED_MATCH_SIZES[DEFAULT_ENABLED_MATCH_SIZES.length - 1];
}

export function getQueueTargetSize(
  selectedMatchSize: number | null,
  enabledMatchSizes: ReadonlyArray<number>
): number {
  return (selectedMatchSize ?? getHighestEnabledMatchSize(enabledMatchSizes)) * 2;
}

export function getLowerTierVoteMatchSize(
  queueSize: number,
  enabledMatchSizes: ReadonlyArray<number>,
  selectedMatchSize: number | null
): number | null {
  if (selectedMatchSize !== null || queueSize % 2 !== 0) {
    return null;
  }

  const normalized = normalizeEnabledMatchSizes(enabledMatchSizes);
  const candidateMatchSize = queueSize / 2;
  if (!normalized.includes(candidateMatchSize)) {
    return null;
  }

  return candidateMatchSize < getHighestEnabledMatchSize(normalized) ? candidateMatchSize : null;
}

export function countMatchSizeVotes(votes: ReadonlyMap<string, number>, matchSize: number): number {
  let count = 0;

  for (const value of votes.values()) {
    if (value === matchSize) {
      count += 1;
    }
  }

  return count;
}

export function getCaptainsRandomVoteThreshold(queueSize: number): number {
  return Math.floor(queueSize / 2) + 1;
}

export function getCaptainDraftSteps(matchSize: number): CaptainDraftStep[] {
  if (matchSize <= 1) {
    return [];
  }

  const steps: CaptainDraftStep[] = [];
  const playersNeeded = new Map<Team, number>([
    [Team.Blue, matchSize - 1],
    [Team.Orange, matchSize - 1],
  ]);
  let remainingUnassigned = matchSize * 2 - 2;
  let nextTeam = Team.Blue;
  let firstPick = true;

  while (remainingUnassigned > 1) {
    const picks = firstPick
      ? 1
      : Math.min(2, playersNeeded.get(nextTeam) ?? 0, remainingUnassigned - 1);
    if (picks <= 0) {
      break;
    }

    steps.push({
      picks,
      team: nextTeam,
    });
    playersNeeded.set(nextTeam, (playersNeeded.get(nextTeam) ?? 0) - picks);
    remainingUnassigned -= picks;
    nextTeam = nextTeam === Team.Blue ? Team.Orange : Team.Blue;
    firstPick = false;
  }

  return steps;
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
