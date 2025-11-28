import { Client, Message, TextChannel, VoiceBasedChannel } from "discord.js";
import { updateLeaderboardChannel } from "./controllers/LeaderboardChannelController";
import { handleInteraction, postCurrentQueue } from "./controllers/Interactions";
import { getDiscordChannelById } from "./utils/discordUtils";
import { getEnvVariable } from "./utils";
import { handleDevInteraction } from "./controllers/DevInteractions";
import { handleAdminInteraction, registerAdminSlashCommands } from "./controllers/AdminController";
import { handleMenuInteraction } from "./controllers/MenuInteractions";
import { startQueueTimer } from "./controllers/QueueController";
import { normCommand } from "./controllers/EasterEggs";
import OpenAI from "openai";

const NormClient = new Client({
  intents: ["Guilds", "GuildMessages", "GuildVoiceStates", "MessageContent"],
});

const guildId = getEnvVariable("guild_id");
const leaderboardChannelId = getEnvVariable("leaderboard_channel_id");
const queueChannelId = getEnvVariable("queue_channel_id");
const chatChannelId = getEnvVariable("chat_channel_id");
const voiceChannelID = getEnvVariable("voice_channel_id");
const discordToken = getEnvVariable("token");
const openai = new OpenAI({ apiKey: getEnvVariable("openai") });

let queueEmbed: Message | null;
let chatChannelMonitor: boolean = false;
let chatChannel: TextChannel;
let voiceChannel: VoiceBasedChannel;

// function called on startup
NormClient.on("clientReady", async (client) => {
  console.info("NormJS is running.");

  if (!client.user) throw new Error("No client id");
  const registerAdminCommandsPromise = registerAdminSlashCommands(client.user.id, guildId, discordToken);

  const updateLeaderboardPromise = getDiscordChannelById(NormClient, leaderboardChannelId).then(
    (leaderboardChannel) => {
      if (leaderboardChannel) {
        updateLeaderboardChannel(leaderboardChannel);
      }
    }
  );

  const postCurrentQueuePromise = getDiscordChannelById(NormClient, queueChannelId)
    .then((queueChannel) => {
      if (queueChannel) {
        return postCurrentQueue(queueChannel);
      }
    })
    .then((queueEmbedMsg) => {
      queueEmbed = queueEmbedMsg ?? null;
    });

  const registerChatPromise = getDiscordChannelById(NormClient, chatChannelId).then((getChatChannel) => {
    if (!getChatChannel) {
      console.warn("Unable to access chat channel.");
    } else {
      chatChannel = getChatChannel;
      return (chatChannelMonitor = true);
    }
  });

  const registerVoiceChatPromise = await NormClient.channels.fetch(voiceChannelID).then((getVoiceChannel) => {
    if (!getVoiceChannel) {
      console.warn("Unable to access voice channel.");
    } else if (getVoiceChannel.isVoiceBased()) {
      voiceChannel = getVoiceChannel;
    } else {
      console.warn("Channel is not a voice channel.");
    }
  });

  await Promise.all([
    registerAdminCommandsPromise,
    updateLeaderboardPromise,
    postCurrentQueuePromise,
    registerChatPromise,
    registerVoiceChatPromise,
  ]);

  if (queueEmbed) {
    startQueueTimer(queueEmbed);
  } else {
    console.warn("Unable to start queue timers since queue embed is null.");
  }

  if (!chatChannelMonitor) {
    console.warn("Unable to start chat monitoring timer on a channel that doesn't exist.");
  }
});

NormClient.on("interactionCreate", async (interaction) => {
  if (interaction.isButton()) {
    await interaction.deferUpdate();

    await handleInteraction(interaction, NormClient);
    await handleDevInteraction(interaction);
  } else if (interaction.isStringSelectMenu()) {
    await interaction.deferUpdate();

    await handleMenuInteraction(interaction);
  } else if (interaction.isCommand()) {
    if (!queueEmbed) throw new Error("No queue embed set.");

    await interaction.deferReply({ ephemeral: true });
    await handleAdminInteraction(interaction, queueEmbed);
  }
});

NormClient.on("messageCreate", async (message) => {
  if (message.channelId === chatChannelId) {
    normCommand(chatChannel, voiceChannel, message, openai, NormClient);
  }
});

NormClient.login(discordToken);
