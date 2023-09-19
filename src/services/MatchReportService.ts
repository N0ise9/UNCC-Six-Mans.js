import ActiveMatchRepository from "../repositories/ActiveMatchRepository";
import { ActiveMatchTeams, PlayerInActiveMatch } from "../repositories/ActiveMatchRepository/types";
import EventRepository from "../repositories/EventRepository/EventRepository";
import LeaderboardRepository from "../repositories/LeaderboardRepository";
import { UpdatePlayerStatsInput } from "../repositories/LeaderboardRepository/types";
import { Team } from "../types/common";
import { waitForAllPromises } from "../utils";

interface TeamProbabilityDecimalResult {
  blueProbabilityDecimal: number;
  orangeProbabilityDecimal: number;
}

export function calculateProbabilityDecimal(teams: ActiveMatchTeams): TeamProbabilityDecimalResult {
  const blueTeamMMR = teams.blueTeam.reduce((totalMMR, ballChaser) => totalMMR + ballChaser.mmr, 0);
  const orangeTeamMMR = teams.orangeTeam.reduce((totalMMR, ballChaser) => totalMMR + ballChaser.mmr, 0);

  const calcTeamProbabilityDecimal = (winnerMMR: number, loserMMR: number): number => {
    const difference = (loserMMR - winnerMMR) / 400;
    const power = Math.pow(10, difference) + 1;
    const probabilityDecimal = 1 / power;
    return probabilityDecimal;
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
  const probability = calculatedProbabilityDecimal * 100;
  return Math.round(probability);
}

export async function checkReport(reportedTeam: Team, playerInMatchId: string): Promise<boolean> {
  const teams = await ActiveMatchRepository.getAllPlayersInActiveMatch(playerInMatchId);

  const reporter = [...teams.blueTeam, ...teams.orangeTeam].find((p) => {
    return p.id === playerInMatchId;
  });

  const previousReporter = [...teams.blueTeam, ...teams.orangeTeam].find((p) => {
    return p.reportedTeam !== null;
  });

  if (!reporter) {
    return false;
  } else if (previousReporter?.team === reporter.team && previousReporter?.reportedTeam === reportedTeam) {
    return false;
  } else if (previousReporter?.reportedTeam !== reportedTeam || previousReporter?.id === reporter.id) {
    await reportMatch(reportedTeam, reporter, teams);
    return false;
  } else {
    await confirmMatch(reportedTeam, teams, playerInMatchId);
    return true;
  }
}

export async function reportMatch(team: Team, reporter: PlayerInActiveMatch, teams: ActiveMatchTeams) {
  await waitForAllPromises([...teams.blueTeam, ...teams.orangeTeam], async (player) => {
    await ActiveMatchRepository.updatePlayerInActiveMatch(player.id, {
      reportedTeam: player.id === reporter.id ? team : null,
    });
  });
}

export async function confirmMatch(winner: Team, teams: ActiveMatchTeams, playerInMatchId: string) {
  const { blueProbabilityDecimal, orangeProbabilityDecimal } = calculateProbabilityDecimal(teams);
  const mmr = calculateMMR(winner === Team.Blue ? blueProbabilityDecimal : orangeProbabilityDecimal);

  const updateStats: Array<UpdatePlayerStatsInput> = [];
  await waitForAllPromises([...teams.blueTeam, ...teams.orangeTeam], async (player) => {
    const isPlayerOnWinningTeam = player.team === winner;
    const event = await EventRepository.getCurrentEvent();
    const playerStats = await LeaderboardRepository.getPlayerStats(player.id);
    if (playerStats) {
      const stats: UpdatePlayerStatsInput = isPlayerOnWinningTeam
        ? {
            id: player.id,
            mmr: playerStats.mmr + mmr * event.mmrMult,
            wins: playerStats.wins + 1,
          }
        : {
            id: player.id,
            losses: playerStats.losses + 1,
            mmr: playerStats.mmr - mmr,
          };
      updateStats.push(stats);
    } else {
      const stats: UpdatePlayerStatsInput = isPlayerOnWinningTeam
        ? {
            id: player.id,
            mmr: 100 + mmr * event.mmrMult,
            wins: 1,
          }
        : {
            id: player.id,
            losses: 1,
            mmr: 100 - mmr,
          };
      updateStats.push(stats);
    }
  });

  await Promise.all([
    await LeaderboardRepository.updatePlayersStats(updateStats),
    await ActiveMatchRepository.removeAllPlayersInActiveMatch(playerInMatchId),
  ]);
}
