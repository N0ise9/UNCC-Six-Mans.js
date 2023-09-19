/* eslint-disable no-console */
import { ButtonInteraction, Client, Message, TextChannel } from "discord.js";
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

export async function postCurrentQueue(queueChannel: TextChannel): Promise<Message> {
  const ballchasers = await QueueRepository.getAllBallChasersInQueue();
  return await queueChannel.send(MessageBuilder.queueMessage(ballchasers));
}

export async function handleInteraction(
  buttonInteraction: ButtonInteraction,
  NormClient: Client<boolean>
): Promise<void> {
  const message = buttonInteraction.message;
  if (!(message instanceof Message)) return;
  const time = new Date().getTime();
  const year = new Date().getFullYear();
  const month = new Date().getMonth();
  const day = new Date().getDate();
  const hour = new Date().getHours();
  const min = new Date().getMinutes();
  const sec = new Date().getSeconds();
  const mil = new Date().getMilliseconds();

  switch (buttonInteraction.customId) {
    case ButtonCustomID.JoinQueue: {
      const queue = await QueueRepository.getAllBallChasersInQueue();
      if (!QueueRepository.isPlayerInQueue(buttonInteraction.user.id) && queue.length === 6) return;
      const ballchasers = await joinQueue(buttonInteraction.user.id, buttonInteraction.user.username);

      if (ballchasers) {
        if (ballchasers.length === 6) {
          const list = queue.map((ballChaser) => {
            return `<@${ballChaser.id}> `;
          });

          const msg = await message.channel.send({ content: list.toString() });
          msg;
          Promise.all([
            msg.delete(),
            message.edit(MessageBuilder.fullQueueMessage(ballchasers)),
            QueueRepository.resetCaptainsRandomVoters(),
          ]);
          const diff = new Date().getTime() - time;
          console.log(
            `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Join: ${
              buttonInteraction.user.username
            } - ${diff}ms`
          );
        } else if (queue.length === 0) {
          const msg = await message.channel.send({ content: "@here" });
          msg;
          Promise.all([msg.delete(), message.edit(MessageBuilder.queueMessage(ballchasers))]);
          const diff = new Date().getTime() - time;
          console.log(
            `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Join: ${
              buttonInteraction.user.username
            } - ${diff}ms`
          );
        } else {
          message.edit(MessageBuilder.queueMessage(ballchasers));
          const diff = new Date().getTime() - time;
          console.log(
            `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Join: ${
              buttonInteraction.user.username
            } - ${diff}ms`
          );
        }
      }

      break;
    }

    case ButtonCustomID.LeaveQueue: {
      await leaveQueue(buttonInteraction.user.id).then(async (remainingMembers) => {
        return message.edit(MessageBuilder.queueMessage(remainingMembers));
      });
      const diff = new Date().getTime() - time;
      console.log(
        `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Leave: ${
          buttonInteraction.user.username
        } - ${diff}ms`
      );
      break;
    }

    case ButtonCustomID.CreateRandomTeam: {
      await captainsRandomVote(buttonInteraction, message);
      const diff = new Date().getTime() - time;
      console.log(
        `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Random: ${
          buttonInteraction.user.username
        } - ${diff}ms`
      );
      break;
    }

    case ButtonCustomID.ChooseTeam: {
      await captainsRandomVote(buttonInteraction, message);
      const diff = new Date().getTime() - time;
      console.log(
        `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Captains: ${
          buttonInteraction.user.username
        } - ${diff}ms`
      );
      break;
    }

    case ButtonCustomID.ReportBlue: {
      await report(buttonInteraction, Team.Blue, message, NormClient);
      const diff = new Date().getTime() - time;
      console.log(
        `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Report Blue: ${
          buttonInteraction.user.username
        } - ${diff}ms`
      );
      break;
    }

    case ButtonCustomID.ReportOrange: {
      await report(buttonInteraction, Team.Orange, message, NormClient);
      const diff = new Date().getTime() - time;
      console.log(
        `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Report Orange: ${
          buttonInteraction.user.username
        } - ${diff}ms`
      );
      break;
    }

    case ButtonCustomID.BrokenQueue: {
      await brokenQueue(buttonInteraction, message);
      const diff = new Date().getTime() - time;
      console.log(
        `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Broken Queue: ${
          buttonInteraction.user.username
        } - ${diff}ms`
      );
      break;
    }
  }
}

async function captainsRandomVote(buttonInteraction: ButtonInteraction, message: Message) {
  const playerInQueue = await QueueRepository.isPlayerInQueue(buttonInteraction.user.id);
  if (!playerInQueue) return;
  const ballChasers = await QueueRepository.getAllBallChasersInQueue();

  const vote = await QueueRepository.countCaptainsRandomVote(buttonInteraction);

  if (vote.captains == 4) {
    const players = await setCaptains(ballChasers);
    await message.edit(MessageBuilder.captainChooseMessage(true, players));
  } else if (vote.random == 4) {
    const currentMatch = await createRandomMatch();
    const emptyQueue: PlayerInQueue[] = [];

    await Promise.all([
      //Create new reply to start a match
      await message.channel.send(await MessageBuilder.activeMatchMessage(currentMatch)),

      //Update the embed with an empty queue message
      await message.edit(MessageBuilder.queueMessage(emptyQueue)),
    ]);

    QueueRepository.resetCaptainsRandomVoters();
  } else if (vote.captains > 4 || vote.random > 4) return;
  else {
    const players = await QueueRepository.getCaptainsRandomVoters();
    const captainsVotes = vote.captains;
    const randomVotes = vote.random;
    const voterList: PlayerInQueue[] = [];

    for (const key of players.keys()) {
      const player = await QueueRepository.getBallChaserInQueue(key);
      if (player) {
        voterList.push(player);
      }
      // break;
    }
    Promise.all([
      await message.edit(
        MessageBuilder.voteCaptainsOrRandomMessage(ballChasers, captainsVotes, randomVotes, voterList, players)
      ),
    ]);
  }
}

async function report(buttonInteraction: ButtonInteraction, team: Team, message: Message, NormClient: Client) {
  const playerInMatch = await ActiveMatchRepository.isPlayerInActiveMatch(buttonInteraction.user.id);
  if (!playerInMatch) return;

  const confirmReport = await checkReport(team, buttonInteraction.user.id);

  if (confirmReport) {
    await message.delete();
    const leaderboardChannelId = getEnvVariable("leaderboard_channel_id");
    await getDiscordChannelById(NormClient, leaderboardChannelId).then((leaderboardChannel) => {
      if (leaderboardChannel) {
        updateLeaderboardChannel(leaderboardChannel);
      }
    });
  } else {
    const previousEmbed = message.embeds[0];
    await message.edit(MessageBuilder.reportedTeamButtons(buttonInteraction, previousEmbed));
  }
}

async function brokenQueue(buttonInteraction: ButtonInteraction, message: Message) {
  const playerinMatch = await ActiveMatchRepository.isPlayerInActiveMatch(buttonInteraction.user.id);
  if (!playerinMatch) return;
  let vote = false;
  const playerVoting = await ActiveMatchRepository.getPlayerInActiveMatch(buttonInteraction.user.id);
  if (playerVoting?.brokenQueue == false) {
    vote = true;
  } else {
    vote = false;
  }
  await ActiveMatchRepository.updatePlayerInActiveMatch(buttonInteraction.user.id, {
    brokenQueue: vote,
  });

  const brokenQueueVotes = await ActiveMatchRepository.getAllBrokenQueueVotesInActiveMatch(buttonInteraction.user.id);
  if (brokenQueueVotes >= 4) {
    message.delete();
    await ActiveMatchRepository.removeAllPlayersInActiveMatch(buttonInteraction.user.id);
  } else {
    const teams = await ActiveMatchRepository.getAllBrokenQueueVotersInActiveMatch(buttonInteraction.user.id);
    const currentMatch = await getActiveMatch(buttonInteraction.user.id);
    await Promise.all([
      message.edit(await MessageBuilder.voteBrokenQueueMessage(currentMatch, teams, brokenQueueVotes)),
    ]);
  }
}
