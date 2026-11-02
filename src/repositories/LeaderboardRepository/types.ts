import { BallChaser, Leaderboard } from "../../prisma";

export interface PlayerStats {
  id: string;
  mmr: number;
  name: string;
  wins: number;
  losses: number;
  matchesPlayed: number;
  winPerc: number;
}

export interface UpdatePlayerStatsInput {
  id: string;
  mmr: number;
  wins?: number;
  losses?: number;
}

export type LeaderboardWithBallChaser = Leaderboard & { player: BallChaser };
