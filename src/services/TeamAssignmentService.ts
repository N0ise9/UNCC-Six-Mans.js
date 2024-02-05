import { NewActiveMatchInput } from "../repositories/ActiveMatchRepository/types";
import QueueRepository from "../repositories/QueueRepository";
import { PlayerInQueue } from "../repositories/QueueRepository/types";
import { Team } from "../types/common";

export function createRandomTeams(ballchasers: ReadonlyArray<PlayerInQueue>): Array<NewActiveMatchInput> {
  const sortedBallChaser = ballchasers.slice().sort((o, b) => o.mmr - b.mmr);

  const activeMatch: NewActiveMatchInput[] = [];
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let orangeTeamMmr = 0;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let blueTeamMmr = 0;
  let orangeTeamCounter = 0;
  let blueTeamCounter = 0;

  //This maintains randomness among assigned teams.
  //This actually splits the ball chasers into two arrays that aren't
  //neccessarily even arrays.  So the If statements that say .length /2
  //is ensuring that there aren't 4 players on one team and two on the other.
  sortedBallChaser.forEach((p) => {
    if (Math.round(Math.random()) == 1) {
      if (orangeTeamCounter < sortedBallChaser.length / 2) {
        orangeTeamMmr += p.mmr;
        activeMatch.push({ id: p.id, team: Team.Orange });
        orangeTeamCounter++;
      } else {
        blueTeamMmr += p.mmr;
        activeMatch.push({ id: p.id, team: Team.Blue });
        blueTeamCounter++;
      }
    } else {
      if (blueTeamCounter < sortedBallChaser.length / 2) {
        blueTeamMmr += p.mmr;
        activeMatch.push({ id: p.id, team: Team.Blue });
        blueTeamCounter++;
      } else {
        orangeTeamMmr += p.mmr;
        activeMatch.push({ id: p.id, team: Team.Orange });
        orangeTeamCounter++;
      }
    }
  });

  return activeMatch;
}

export async function setCaptains(ballChasers: ReadonlyArray<PlayerInQueue>): Promise<ReadonlyArray<PlayerInQueue>> {
  const sortedBallChaser = ballChasers.slice().sort((o, b) => b.mmr - o.mmr);

  //We are going to set the Blue Captain (firt person to choose) as the second highest MMR.
  //The thought is that this will even out the teams a little more.
  await Promise.all([
    await QueueRepository.updateBallChaserInQueue({
      id: sortedBallChaser[0].id,
      isCap: true,
      team: Team.Orange,
    }),
    await QueueRepository.updateBallChaserInQueue({
      id: sortedBallChaser[1].id,
      isCap: true,
      team: Team.Blue,
    }),
  ]);

  const updatedBallChasers = await QueueRepository.getAllBallChasersInQueue();

  return updatedBallChasers;
}

export async function bluePlayerChosen(chosenPlayer: string): Promise<ReadonlyArray<PlayerInQueue>> {
  await QueueRepository.updateBallChaserInQueue({
    id: chosenPlayer,
    team: Team.Blue,
  });

  const ballPlayers = await QueueRepository.getAllBallChasersInQueue();
  return ballPlayers;
}

export async function orangePlayerChosen(chosenPlayers: string[]): Promise<void> {
  for (const p of chosenPlayers) {
    await QueueRepository.updateBallChaserInQueue({
      id: p,
      team: Team.Orange,
    });
  }
}
