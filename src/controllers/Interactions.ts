/* eslint-disable max-len */
import { ButtonInteraction, Client, EmbedBuilder, Message, TextChannel } from "discord.js";
import { joinQueue, leaveQueue } from "../services/QueueService";
import MessageBuilder from "../utils/MessageHelper/MessageBuilder";
import { getDiscordChannelById } from "../utils/discordUtils";
import { createRandomMatch, getActiveMatch } from "../services/MatchService";
import { PlayerInQueue } from "../repositories/QueueRepository/types";
import { checkReport } from "../services/MatchReportService";
import { updateLeaderboardChannel } from "./LeaderboardChannelController";
import { getEnvVariable } from "../utils";
import QueueRepository from "../repositories/QueueRepository";
import { setCaptains } from "../services/TeamAssignmentService";
import { Team } from "../types/common";
import ActiveMatchRepository from "../repositories/ActiveMatchRepository";
import { ButtonCustomID } from "../utils/MessageHelper/CustomButtons";
import AsyncMutex from "../utils/AsyncMutex";
import { messageEditScheduler } from "../utils/MessageEditScheduler";

const queueMutex = new AsyncMutex();

export async function postCurrentQueue(queueChannel: TextChannel): Promise<Message> {
  const ballchasers = await QueueRepository.getAllBallChasersInQueue();
  return await queueChannel.send(MessageBuilder.queueMessage(ballchasers));
}

function getQueueTargetSize(): number {
  return QueueRepository.getTwosEnabled() ? 4 : 6;
}

export async function handleInteraction(
  buttonInteraction: ButtonInteraction,
  NormClient: Client<boolean>
): Promise<void> {
  const { message } = buttonInteraction;
  if (!(message instanceof Message)) return;

  const time = Date.now();
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const day = now.getDate();
  const hour = now.getHours();
  const min = now.getMinutes();
  const sec = now.getSeconds();
  const mil = now.getMilliseconds();

  switch (buttonInteraction.customId) {
    case ButtonCustomID.JoinQueue: {
      const release = await queueMutex.acquire();
      try {
        const queue = await QueueRepository.getAllBallChasersInQueue();
        const target = getQueueTargetSize();
        const alreadyInQueue = await QueueRepository.isPlayerInQueue(buttonInteraction.user.id);
        if (!alreadyInQueue && queue.length >= target) return;

        const ballchasers = await joinQueue(buttonInteraction.user.id, buttonInteraction.user.username);
        if (!ballchasers) return;

        if (ballchasers.length >= target) {
          messageEditScheduler.schedule(message, MessageBuilder.fullQueueMessage(ballchasers));
          await Promise.all([QueueRepository.resetCaptainsRandomVoters(), QueueRepository.resetTwosVoters()]);
        } else {
          messageEditScheduler.schedule(message, MessageBuilder.queueMessage(ballchasers));
        }
      } finally {
        release();
      }

      const diff = Date.now() - time;
      console.info(
        `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Join: ${buttonInteraction.user.username} - ${diff}ms`
      );
      break;
    }

    case ButtonCustomID.LeaveQueue: {
      const release = await queueMutex.acquire();
      try {
        const playerInQueue = await QueueRepository.getBallChaserInQueue(buttonInteraction.user.id);
        if (!playerInQueue) return;

        const remainingMembers = await leaveQueue(buttonInteraction.user.id);
        QueueRepository.resetTwosEnabled();
        messageEditScheduler.schedule(message, MessageBuilder.queueMessage(remainingMembers));
      } finally {
        release();
      }

      const diff = Date.now() - time;
      console.info(
        `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Leave: ${buttonInteraction.user.username} - ${diff}ms`
      );
      break;
    }

    case ButtonCustomID.CreateRandomTeam: {
      const release = await queueMutex.acquire();
      try {
        const playerInQueue = await QueueRepository.getBallChaserInQueue(buttonInteraction.user.id);
        if (!playerInQueue) return;
        await captainsRandomVote(buttonInteraction, message);
      } finally {
        release();
      }

      const diff = Date.now() - time;
      console.info(
        `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Random: ${buttonInteraction.user.username} - ${diff}ms`
      );
      break;
    }

    case ButtonCustomID.ChooseTeam: {
      const release = await queueMutex.acquire();
      try {
        const playerInQueue = await QueueRepository.getBallChaserInQueue(buttonInteraction.user.id);
        if (!playerInQueue) return;
        await captainsRandomVote(buttonInteraction, message);
      } finally {
        release();
      }

      const diff = Date.now() - time;
      console.info(
        `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Captains: ${buttonInteraction.user.username} - ${diff}ms`
      );
      break;
    }

    case ButtonCustomID.ReportBlue: {
      await report(buttonInteraction, Team.Blue, message, NormClient);
      const diff = Date.now() - time;
      console.info(
        `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Report Blue: ${buttonInteraction.user.username} - ${diff}ms`
      );
      break;
    }

    case ButtonCustomID.ReportOrange: {
      await report(buttonInteraction, Team.Orange, message, NormClient);
      const diff = Date.now() - time;
      console.info(
        `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Report Orange: ${buttonInteraction.user.username} - ${diff}ms`
      );
      break;
    }

    case ButtonCustomID.BrokenQueue: {
      await brokenQueue(buttonInteraction, message);
      const diff = Date.now() - time;
      console.info(
        `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Broken Queue: ${buttonInteraction.user.username} - ${diff}ms`
      );
      break;
    }

    case ButtonCustomID.Twos: {
      const release = await queueMutex.acquire();
      try {
        const playerInQueue = await QueueRepository.getBallChaserInQueue(buttonInteraction.user.id);
        if (!playerInQueue) return;
        await twosVoting(buttonInteraction, message);
      } finally {
        release();
      }

      const diff = Date.now() - time;
      console.info(
        `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | 2v2 Vote: ${buttonInteraction.user.username} - ${diff}ms`
      );
    }
  }
}

async function twosVoting(buttonInteraction: ButtonInteraction, message: Message) {
  const ballChasers = await QueueRepository.getAllBallChasersInQueue();
  const vote = await QueueRepository.count2v2Votes(buttonInteraction);

  if (ballChasers.length < 4) return;

  if (vote.twos >= 4) {
    QueueRepository.setTwosEnabled(true);

    messageEditScheduler.schedule(message, MessageBuilder.fullQueueMessage(ballChasers));
    await Promise.all([QueueRepository.resetCaptainsRandomVoters(), QueueRepository.resetTwosVoters()]);
  } else {
    const players = await QueueRepository.getTwosVoters();
    const twosVotes = vote.twos;
    const voterList: PlayerInQueue[] = [];

    for (const key of players.keys()) {
      const player = await QueueRepository.getBallChaserInQueue(key);
      if (player) voterList.push(player);
    }

    messageEditScheduler.schedule(message, MessageBuilder.vote2v2sMessage(ballChasers, twosVotes, voterList, players));
  }
}

async function captainsRandomVote(buttonInteraction: ButtonInteraction, message: Message) {
  const playerInQueue = await QueueRepository.isPlayerInQueue(buttonInteraction.user.id);
  if (!playerInQueue) return;

  const queue = await QueueRepository.getAllBallChasersInQueue();
  const target = getQueueTargetSize();
  if (queue.length !== target) return;

  const vote = await QueueRepository.countCaptainsRandomVote(buttonInteraction);

  const threshold = QueueRepository.getTwosEnabled() ? 3 : 4;

  if (vote.captains === threshold) {
    const players = await setCaptains(queue);
    messageEditScheduler.schedule(
      message,
      MessageBuilder.captainChooseMessage(true, players, QueueRepository.getTwosEnabled())
    );
    return;
  }

  if (vote.random === threshold) {
    const currentMatch = await createRandomMatch();
    const emptyQueue: PlayerInQueue[] = [];

    await message.reply(await MessageBuilder.activeMatchMessage(currentMatch));
    messageEditScheduler.schedule(message, MessageBuilder.queueMessage(emptyQueue));

    QueueRepository.resetCaptainsRandomVoters();
    QueueRepository.resetTwosVoters();
    QueueRepository.resetTwosEnabled();
    return;
  }

  if (vote.captains > threshold || vote.random > threshold) return;

  const players = await QueueRepository.getCaptainsRandomVoters();
  const captainsVotes = vote.captains;
  const randomVotes = vote.random;
  const voterList: PlayerInQueue[] = [];

  for (const key of players.keys()) {
    const player = await QueueRepository.getBallChaserInQueue(key);
    if (player) voterList.push(player);
  }

  messageEditScheduler.schedule(
    message,
    MessageBuilder.voteCaptainsOrRandomMessage(queue, captainsVotes, randomVotes, voterList, players)
  );
}

async function report(buttonInteraction: ButtonInteraction, team: Team, message: Message, NormClient: Client) {
  const playerInMatch = await ActiveMatchRepository.isPlayerInActiveMatch(buttonInteraction.user.id);
  if (!playerInMatch) return;

  const confirmReport = await checkReport(team, buttonInteraction.user.id);

  if (confirmReport) {
    await message.delete();
    const leaderboardChannelId = getEnvVariable("leaderboard_channel_id");
    await getDiscordChannelById(NormClient, leaderboardChannelId).then((leaderboardChannel) => {
      if (leaderboardChannel) updateLeaderboardChannel(leaderboardChannel);
    });
  } else {
    const previousEmbed = message.embeds[0];
    messageEditScheduler.schedule(
      message,
      MessageBuilder.reportedTeamButtons(buttonInteraction, EmbedBuilder.from(previousEmbed))
    );
  }
}

async function brokenQueue(buttonInteraction: ButtonInteraction, message: Message) {
  const playerinMatch = await ActiveMatchRepository.isPlayerInActiveMatch(buttonInteraction.user.id);
  if (!playerinMatch) return;

  const playerVoting = await ActiveMatchRepository.getPlayerInActiveMatch(buttonInteraction.user.id);
  const vote = playerVoting?.brokenQueue === false;

  await ActiveMatchRepository.updatePlayerInActiveMatch(buttonInteraction.user.id, { brokenQueue: vote });

  const brokenQueueVotes = await ActiveMatchRepository.getAllBrokenQueueVotesInActiveMatch(buttonInteraction.user.id);
  if (brokenQueueVotes >= 4) {
    await message.delete();
    await ActiveMatchRepository.removeAllPlayersInActiveMatch(buttonInteraction.user.id);
  } else {
    const teams = await ActiveMatchRepository.getAllBrokenQueueVotersInActiveMatch(buttonInteraction.user.id);
    const currentMatch = await getActiveMatch(buttonInteraction.user.id);
    messageEditScheduler.schedule(
      message,
      await MessageBuilder.voteBrokenQueueMessage(currentMatch, teams, brokenQueueVotes)
    );
  }
}
