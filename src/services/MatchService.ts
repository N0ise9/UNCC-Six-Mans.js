import { createRandomTeams } from "../services/TeamAssignmentService";
import ActiveMatchRepository from "../repositories/ActiveMatchRepository";
import QueueRepository from "../repositories/QueueRepository";
import { NewActiveMatchInput, PlayerInActiveMatch } from "../repositories/ActiveMatchRepository/types";
import { Team } from "../types/common";
import { calculateMMR, calculateProbability, calculateProbabilityDecimal } from "./MatchReportService";

interface ActiveMatchTeamDetails {
  mmrStake: number;
  players: ReadonlyArray<PlayerInActiveMatch>;
  winProbability: number;
}

export interface ActiveMatchCreated {
  orange: ActiveMatchTeamDetails;
  blue: ActiveMatchTeamDetails;
}

async function startMatch(createdTeams: Array<NewActiveMatchInput>): Promise<ActiveMatchCreated> {
  await Promise.all([
    //Create Match
    await ActiveMatchRepository.addActiveMatch(createdTeams),
    //Match is created, reset the queue.
    await QueueRepository.removeAllBallChasersFromQueue(),
  ]);

  const teams = await ActiveMatchRepository.getAllPlayersInActiveMatch(createdTeams[0].id);
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

export async function createRandomMatch(): Promise<ActiveMatchCreated> {
  const ballChasers = await QueueRepository.getAllBallChasersInQueue();
  //Assign teams based on MMR and
  const createdTeams = createRandomTeams(ballChasers);

  return await startMatch(createdTeams);
}

export async function getActiveMatch(playerInMatchId: string): Promise<ActiveMatchCreated> {
  const teams = await ActiveMatchRepository.getAllPlayersInActiveMatch(playerInMatchId);
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

export async function createMatchFromChosenTeams(): Promise<ActiveMatchCreated> {
  const createdTeams: NewActiveMatchInput[] = [];

  //Sort the ballchasers so those without a team go at the end of the array for ActiveMatch embed visual fix
  const ballchasers = await QueueRepository.getAllBallChasersInQueue();
  const sortedBallChasers = ballchasers.slice().sort((a, b) => (a.team ?? 100) - (b.team ?? 100));

  //Update the last available player to blue and push all players into Active Match
  for (const p of sortedBallChasers) {
    if (p.team !== null) {
      createdTeams.push({ id: p.id, team: p.team });
    } else {
      createdTeams.push({ id: p.id, team: Team.Blue });
    }
  }

  return await startMatch(createdTeams);
}
