import { TextChannel } from "discord.js";
import { LeaderboardToString } from "../services/LeaderboardService";
import { deleteAllMessagesInTextChannel } from "../utils/discordUtils";
import MessageBuilder from "../utils/MessageHelper/MessageBuilder";

export async function updateLeaderboardChannel(leaderboardChannel: TextChannel): Promise<void> {
  const leaderboardContent = await LeaderboardToString();
  await deleteAllMessagesInTextChannel(leaderboardChannel);
  for (const payload of MessageBuilder.leaderboardMessage(leaderboardContent)) {
    await leaderboardChannel.send(payload);
  }
}
