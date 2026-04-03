import LeaderboardRepository from "../repositories/LeaderboardRepository";

export async function LeaderboardToString(): Promise<Array<string>> {
  const playersPerEmbed = 10;

  const allPlayers = await LeaderboardRepository.getPlayersStats();

  if (allPlayers.length === 0) {
    return ["Nothing to see here yet. Get queueing!"];
  }

  const result: Array<string> = [];

  for (let i = 0; i < allPlayers.length; i += playersPerEmbed) {
    const playersSegment = allPlayers.slice(i, i + playersPerEmbed);

    const newEmbedSegment = playersSegment.reduce((prev, player, index) => {
      const playerStats = `Rank: ${i + index + 1}
\tName: ${player.name}
\tMMR: ${player.mmr}
\tWins: ${player.wins}
\tLosses: ${player.losses}
\tMatches Played: ${player.matchesPlayed}
\tWin Perc: ${Math.round(player.winPerc * 100)}%\n\n`;

      return prev + playerStats;
    }, "");

    result.push(newEmbedSegment);
  }

  return result;
}
