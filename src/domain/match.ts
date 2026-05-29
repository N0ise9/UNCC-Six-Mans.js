import { PlayerInActiveMatch } from "../repositories/ActiveMatchRepository/types";

interface ActiveMatchTeamDetails {
  mmrStake: number;
  players: ReadonlyArray<PlayerInActiveMatch>;
  winProbability: number;
}

export interface ActiveMatchCreated {
  blue: ActiveMatchTeamDetails;
  orange: ActiveMatchTeamDetails;
}
