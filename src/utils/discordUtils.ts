import { ChannelType, Client, TextChannel } from "discord.js";

export async function deleteAllMessagesInTextChannel(channel: TextChannel): Promise<void> {
  // Bulk delete in batches; skip messages older than 14 days to avoid API errors
  // Second arg 'true' filters out messages older than 14 days
  try {
    // Keep fetching until fewer than 1 message remains
    // Limit to avoid rate-limit loops
    for (let i = 0; i < 20; i++) {
      const messages = await channel.messages.fetch({ limit: 100 });
      if (messages.size === 0) break;
      await channel.bulkDelete(messages, true);
      if (messages.size < 100) break;
    }
  } catch (e) {
    // Swallow errors from very old messages or permission issues
    console.warn("Failed to bulk delete all messages:", (e as Error).message);
  }
}

export async function getDiscordChannelById(
  NormClient: Client,
  channelId: string | undefined
): Promise<TextChannel | null> {
  if (!channelId) {
    return null;
  }

  const channel = await NormClient.channels.fetch(channelId);
  if (!channel) {
    return null;
  }

  if (channel.type === ChannelType.GuildText) {
    return channel as TextChannel;
  }

  return null;
}
