import {
  ButtonInteraction,
  EmbedField,
  MessageActionRow,
  MessageButton,
  MessageEmbed,
  MessageOptions,
  MessageSelectMenu,
  MessageSelectOptionData,
} from "discord.js";
import { ActiveMatchCreated } from "../../services/MatchService";
import { Team } from "../../types/common";
import { getEnvVariable } from "../utils";
import { PlayerInQueue } from "../../repositories/QueueRepository/types";
import EmbedBuilder, { BaseEmbed } from "./EmbedBuilder";
import ButtonBuilder from "./ButtonBuilder";
import CustomButton, { ButtonCustomID } from "./CustomButtons";
import { ActiveMatchTeams } from "../../repositories/ActiveMatchRepository/types";
import EventRepository from "../../repositories/EventRepository/EventRepository";

export const enum MenuCustomID {
  BlueSelect = "blueSelect",
  OrangeSelect = "orangeSelect",
}

export default class MessageBuilder {
  private static readonly normIconURL =
    "https://raw.githubusercontent.com/mattwells19/UNCC-Six-Mans.js/main/media/norm_still.png";
  private static readonly isDev = getEnvVariable("ENVIRONMENT") === "dev";

  static leaderboardMessage(leaderboardInfo: string[]): MessageOptions {
    const embeds = leaderboardInfo.map((content, index) => {
      const embedCtr = leaderboardInfo.length > 1 ? `(${index + 1}/${leaderboardInfo.length})` : "";

      return EmbedBuilder.leaderboardEmbed("```" + content + "```", `UNCC 6 Mans | Leaderboard ${embedCtr}`.trim());
    });

    return {
      embeds,
    };
  }

  static queueMessage(ballchasers: ReadonlyArray<Readonly<PlayerInQueue>>): MessageOptions {
    let embed;
    if (ballchasers.length == 0) {
      embed = EmbedBuilder.queueEmbed("Queue is Empty", "Click the green button to join the queue!");
    } else {
      const ballChaserList = ballchasers
        .map((ballChaser) => {
          // + 1 since it seems that joining the queue calculates to 59 instead of 60
          const queueTime = ballChaser.queueTime?.diffNow().as("minutes") ?? 0;
          return `${ballChaser.name} (${Math.min(queueTime + 1, 60).toFixed()} mins)`;
        })
        .join("\n");

      embed = EmbedBuilder.queueEmbed(
        `Current Queue: ${ballchasers.length}/6`,
        "Click the green button to join the queue! \n\n" + ballChaserList
      );
    }

    return {
      components: [ButtonBuilder.queueButtons()],
      embeds: [embed],
    };
  }

  static fullQueueMessage(ballchasers: ReadonlyArray<Readonly<PlayerInQueue>>): MessageOptions {
    const embed = new MessageEmbed({
      color: "GREEN",
      thumbnail: { url: this.normIconURL },
    });
    const randomTeamsButton = new MessageButton({
      customId: ButtonCustomID.CreateRandomTeam,
      label: "Random (0)",
      style: "PRIMARY",
    });
    const pickCaptainsButton = new MessageButton({
      customId: ButtonCustomID.ChooseTeam,
      label: "Captains (0)",
      style: "PRIMARY",
    });
    const leaveButton = new MessageButton({
      customId: ButtonCustomID.LeaveQueue,
      label: "Leave",
      style: "DANGER",
    });
    const removeAllButton = new MessageButton({
      customId: ButtonCustomID.RemoveAll,
      label: "DEV: Remove All",
      style: "DANGER",
    });
    const ballChaserList = ballchasers
      .map((ballChaser) => {
        // + 1 since it seems that joining the queue calculates to 59 instead of 60
        const queueTime = ballChaser.queueTime?.diffNow().as("minutes") ?? 0;
        return `${ballChaser.name} (${Math.min(queueTime + 1, 60).toFixed()} mins)`;
      })
      .join("\n");

    embed
      .setTitle("Queue is Full")
      .setDescription("Vote for Captains or Random teams to get started! \n\n" + ballChaserList);

    return {
      components: this.isDev
        ? [new MessageActionRow({ components: [pickCaptainsButton, randomTeamsButton, leaveButton, removeAllButton] })]
        : [new MessageActionRow({ components: [pickCaptainsButton, randomTeamsButton, leaveButton] })],
      embeds: [embed],
    };
  }

  static async activeMatchMessage({ blue, orange }: ActiveMatchCreated): Promise<MessageOptions> {
    const embed = await EmbedBuilder.activeMatchEmbed({ blue, orange });

    return {
      components: [ButtonBuilder.activeMatchButtons()],
      embeds: [embed],
    };
  }

  static captainChooseMessage(firstPick = true, ballChasers: ReadonlyArray<PlayerInQueue>): MessageOptions {
    //Get Available Players and Map players
    const availablePlayers: Array<MessageSelectOptionData> = [];
    const orangeTeam: Array<string> = [];
    const blueTeam: Array<string> = [];
    let captain = "";
    const embedColor = firstPick ? Team.Blue : Team.Orange;

    ballChasers.forEach((player) => {
      if (player.team === Team.Blue) {
        if (player.isCap && firstPick) {
          captain = player.name;
        }
        blueTeam.push("<@" + player.id + ">");
      } else if (player.team === Team.Orange) {
        if (player.isCap && !firstPick) {
          captain = player.name;
        }
        orangeTeam.push("<@" + player.id + ">");
      } else {
        availablePlayers.push({ description: "MMR: " + player.mmr, label: player.name, value: player.id });
      }
    });

    const playerChoices = new MessageSelectMenu();

    if (firstPick) {
      playerChoices.setCustomId(MenuCustomID.BlueSelect).setPlaceholder(captain + " choose a player");
    } else {
      playerChoices
        .setCustomId(MenuCustomID.OrangeSelect)
        .setPlaceholder(captain + " choose 2 players")
        .setMinValues(2)
        .setMaxValues(2);
    }

    playerChoices.addOptions(availablePlayers);

    const embed = EmbedBuilder.captainsChooseEmbed(embedColor, captain)
      .addField("🔷 Blue Team 🔷", blueTeam.join("\n"))
      .addField("🔶 Orange Team 🔶", orangeTeam.join("\n"));

    const components = [new MessageActionRow({ components: [playerChoices] })];
    if (this.isDev) {
      components.push(ButtonBuilder.breakMatchButtons());
    }
    return {
      components,
      embeds: [embed],
    };
  }

  static async voteBrokenQueueMessage(
    { blue, orange }: ActiveMatchCreated,
    brokenQueuePlayers: ActiveMatchTeams,
    brokenQueueVotes: number
  ): Promise<MessageOptions> {
    const brokenHeart = "\uD83D\uDC94";
    const blueTeam = blue.players.map((player) => {
      const voter = brokenQueuePlayers.blueTeam.find((p) => p.id == player.id);
      if (voter) {
        return `<@${player.id}> ${brokenHeart}`;
      } else {
        return `<@${player.id}>`;
      }
    });
    const orangeTeam: Array<string> = orange.players.map((player) => {
      const voter = brokenQueuePlayers.orangeTeam.find((p) => p.id == player.id);
      if (voter) {
        return `<@${player.id}> ${brokenHeart}`;
      } else {
        return `<@${player.id}>`;
      }
    });
    const brokenQueueButton = new CustomButton({
      customId: ButtonCustomID.BrokenQueue,
      label: "Broken Queue (" + brokenQueueVotes + ")",
    });
    const reportBlueWonButton = new CustomButton({
      customId: ButtonCustomID.ReportBlue,
    });
    const reportOrangeWonButton = new CustomButton({
      customId: ButtonCustomID.ReportOrange,
    });
    const activeMatchEmbed = new BaseEmbed({
      color: "DARK_RED",
      fields: [
        { name: "🔷 Blue Team 🔷", value: blueTeam.join("\n") },
        { name: "🔶 Orange Team 🔶", value: orangeTeam.join("\n") },
      ],
      title: "Teams are set!",
    });

    let probability;
    let winner;
    if (blue.winProbability > orange.winProbability) {
      probability = blue.winProbability;
      winner = "Blue Team is";
    } else if (blue.winProbability < orange.winProbability) {
      probability = orange.winProbability;
      winner = "Orange Team is";
    } else {
      probability = "50";
      winner = "Both teams are";
    }

    const event = await EventRepository.getCurrentEvent();
    const blueMMR = blue.mmrStake * event.mmrMult;
    const orangeMMR = orange.mmrStake * event.mmrMult;

    activeMatchEmbed.addField(
      "MMR Stake & Probability Rating:\n",
      "🔷 Blue Team: \u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0**(+" +
        blueMMR.toString() +
        ")**\u00A0\u00A0**(-" +
        orange.mmrStake.toString() +
        ")** 🔷\n🔶 Orange Team:\u00A0\u00A0**(+" +
        orangeMMR.toString() +
        ")**\u00A0\u00A0**(-" +
        blue.mmrStake.toString() +
        ")** 🔶\n" +
        winner +
        " predicted to have a **" +
        probability +
        "%** chance of winning."
    );

    if (event.mmrMult != 1) {
      activeMatchEmbed.addField(
        "X" + event.mmrMult.toString() + " MMR Event!",
        "Winnings are multiplied by **" + event.mmrMult.toString() + "** for this match!"
      );
    }

    activeMatchEmbed.addField("Reporting", "Use the buttons to report which team won the match.");
    const components = [
      new MessageActionRow({
        components: [brokenQueueButton, reportBlueWonButton, reportOrangeWonButton],
      }),
    ];

    return {
      components: components,
      embeds: [activeMatchEmbed],
    };
  }

  static voteCaptainsOrRandomMessage(
    ballchasers: ReadonlyArray<Readonly<PlayerInQueue>>,
    captainsVotes: number,
    randomVotes: number,
    voterList: PlayerInQueue[],
    players: Map<string, string>
  ): MessageOptions {
    const captainsCounterLabel = captainsVotes;
    const randomCounterLabel = randomVotes;
    const embed = new MessageEmbed({
      color: "GREEN",
      thumbnail: { url: this.normIconURL },
    });
    const randomTeamsButton = new MessageButton({
      customId: ButtonCustomID.CreateRandomTeam,
      label: "Random (" + randomCounterLabel.toString() + ")",
      style: "PRIMARY",
    });
    const pickCaptainsButton = new MessageButton({
      customId: ButtonCustomID.ChooseTeam,
      label: "Captains (" + captainsCounterLabel.toString() + ")",
      style: "PRIMARY",
    });
    const leaveButton = new MessageButton({
      customId: ButtonCustomID.LeaveQueue,
      label: "Leave",
      style: "DANGER",
    });
    const removeAllButton = new MessageButton({
      customId: ButtonCustomID.RemoveAll,
      label: "DEV: Remove All",
      style: "DANGER",
    });

    const cap = "\uD83C\uDDE8";
    const ran = "\uD83C\uDDF7";
    const ballChaserList = ballchasers
      .map((ballChaser) => {
        // + 1 since it seems that joining the queue calculates to 59 instead of 60
        const queueTime = ballChaser.queueTime?.diffNow().as("minutes") ?? 0;
        const voter = voterList.find((p) => p.id == ballChaser.id);
        const vote = players.get(ballChaser.id);
        if (voter && vote == ButtonCustomID.ChooseTeam) {
          return `${cap} ${ballChaser.name} (${Math.min(queueTime + 1, 60).toFixed()} mins)`;
        } else if (voter && vote == ButtonCustomID.CreateRandomTeam) {
          return `${ran} ${ballChaser.name} (${Math.min(queueTime + 1, 60).toFixed()} mins)`;
        } else {
          return `${ballChaser.name} (${Math.min(queueTime + 1, 60).toFixed()} mins)`;
        }
      })
      .join("\n");

    embed
      .setTitle("Queue is Full")
      .setDescription("Vote for Captains or Random teams to get started! \n\n" + ballChaserList);

    return {
      components: this.isDev
        ? [new MessageActionRow({ components: [pickCaptainsButton, randomTeamsButton, leaveButton, removeAllButton] })]
        : [new MessageActionRow({ components: [pickCaptainsButton, randomTeamsButton, leaveButton] })],
      embeds: [embed],
    };
  }

  static disabledVoteCaptainsOrRandomMessage(
    ballchasers: ReadonlyArray<Readonly<PlayerInQueue>>,
    captainsVotes: number,
    randomVotes: number,
    voterList: PlayerInQueue[],
    players: Map<string, string>
  ): MessageOptions {
    const captainsCounterLabel = captainsVotes;
    const randomCounterLabel = randomVotes;
    const embed = new MessageEmbed({
      color: "GREEN",
      thumbnail: { url: this.normIconURL },
    });
    const randomTeamsButton = new MessageButton({
      customId: ButtonCustomID.CreateRandomTeam,
      disabled: true,
      label: "Random (" + randomCounterLabel.toString() + ")",
      style: "PRIMARY",
    });
    const pickCaptainsButton = new MessageButton({
      customId: ButtonCustomID.ChooseTeam,
      disabled: true,
      label: "Captains (" + captainsCounterLabel.toString() + ")",
      style: "PRIMARY",
    });
    const leaveButton = new MessageButton({
      customId: ButtonCustomID.LeaveQueue,
      label: "Leave",
      style: "DANGER",
    });
    const removeAllButton = new MessageButton({
      customId: ButtonCustomID.RemoveAll,
      label: "DEV: Remove All",
      style: "DANGER",
    });

    const cap = "\uD83C\uDDE8";
    const ran = "\uD83C\uDDF7";
    const ballChaserList = ballchasers
      .map((ballChaser) => {
        // + 1 since it seems that joining the queue calculates to 59 instead of 60
        const queueTime = ballChaser.queueTime?.diffNow().as("minutes") ?? 0;
        const voter = voterList.find((p) => p.id == ballChaser.id);
        const vote = players.get(ballChaser.id);
        if (voter && vote == ButtonCustomID.ChooseTeam) {
          return `${cap} ${ballChaser.name} (${Math.min(queueTime + 1, 60).toFixed()} mins)`;
        } else if (voter && vote == ButtonCustomID.CreateRandomTeam) {
          return `${ran} ${ballChaser.name} (${Math.min(queueTime + 1, 60).toFixed()} mins)`;
        } else {
          return `${ballChaser.name} (${Math.min(queueTime + 1, 60).toFixed()} mins)`;
        }
      })
      .join("\n");

    embed
      .setTitle("Queue is Full")
      .setDescription("Vote for Captains or Random teams to get started! \n\n" + ballChaserList);

    return {
      components: this.isDev
        ? [new MessageActionRow({ components: [pickCaptainsButton, randomTeamsButton, leaveButton, removeAllButton] })]
        : [new MessageActionRow({ components: [pickCaptainsButton, randomTeamsButton, leaveButton] })],
      embeds: [embed],
    };
  }

  static reportedTeamButtons(buttonInteraction: ButtonInteraction, activeMatchEmbed: MessageEmbed): MessageOptions {
    let reportedTeam;
    const reportBlue = new CustomButton({ customId: ButtonCustomID.ReportBlue });
    const reportOrange = new CustomButton({ customId: ButtonCustomID.ReportOrange });

    switch (buttonInteraction.customId) {
      case ButtonCustomID.ReportBlue: {
        reportBlue.setStyle("PRIMARY");
        reportedTeam = "**Blue Team**";
        break;
      }
      case ButtonCustomID.ReportOrange: {
        reportOrange.setStyle("PRIMARY");
        reportedTeam = "**Orange Team**";
        break;
      }
    }
    const newField: EmbedField = {
      inline: false,
      name: "Reporting",
      value:
        "<@" +
        buttonInteraction.user +
        "> reported " +
        reportedTeam +
        " as the winner.\nAwaiting confirmation from the other team...\n" +
        "If this is incorrect, click the button of the correct team.",
    };
    const embed = new MessageEmbed(activeMatchEmbed);
    const updatedFields = embed.fields.map((field) => {
      if (field.name === "Reporting") {
        return newField;
      } else {
        return field;
      }
    });
    embed.setFields(updatedFields);

    return {
      components: [new MessageActionRow({ components: [reportBlue, reportOrange] })],
      embeds: [embed],
    };
  }
}
