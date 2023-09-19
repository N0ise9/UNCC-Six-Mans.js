import { Team } from "../../types/common";

export interface PlayerInActiveMatch {
  id: string;
  team: Team;
  reportedTeam: Team | null;
  matchId: string;
  mmr: number;
  brokenQueue: boolean;
}

export interface ActiveMatchTeams {
  blueTeam: ReadonlyArray<PlayerInActiveMatch>;
  orangeTeam: ReadonlyArray<PlayerInActiveMatch>;
}

export interface UpdatePlayerInActiveMatchInput {
  reportedTeam?: Team | null;
  brokenQueue?: boolean;
}

export type NewActiveMatchInput = {
  id: string;
  team: Team;
};
