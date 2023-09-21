import { EmbedBuilder as MessageEmbed, EmbedData } from "discord.js";
import { ActiveMatchCreated } from "../../services/MatchService";
import { Team } from "../../types/common";
import EventRepository from "../../repositories/EventRepository/EventRepository";

export class BaseEmbed extends MessageEmbed {
  private static readonly normIconURL =
    "https://raw.githubusercontent.com/N0ise9/UNCC-Six-Mans.js/main/media/norm_still.png";

  constructor(messageOptions: EmbedData) {
    messageOptions.thumbnail = { url: BaseEmbed.normIconURL };
    super(messageOptions);
  }
}

export default class EmbedBuilder {
  static leaderboardEmbed(description: string, title: string): MessageEmbed {
    return new BaseEmbed({ color: 3447003, description, title });
  }

  static queueEmbed(title: string, description: string): MessageEmbed {
    return new BaseEmbed({ color: 5763719, description, title });
  }

  static fullQueueEmbed(description: string): BaseEmbed {
    return new BaseEmbed({ color: 5763719, description, title: "Queue is Full" });
  }

  static async activeMatchEmbed({ blue, orange }: ActiveMatchCreated): Promise<BaseEmbed> {
    const blueTeam: Array<string> = blue.players.map((player) => "<@" + player.id + ">");
    const orangeTeam: Array<string> = orange.players.map((player) => "<@" + player.id + ">");
    const activeMatchEmbed = new BaseEmbed({
      color: 10038562,
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

    activeMatchEmbed.addFields({
      name: "MMR Stake & Probability Rating:",
      value:
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
        "%** chance of winning.",
    });

    if (event.mmrMult > 1) {
      activeMatchEmbed.addFields({
        name: "X" + event.mmrMult.toString() + " MMR Event!",
        value: "Winnings are multiplied by **" + event.mmrMult.toString() + "** for this match!",
      });
    }

    activeMatchEmbed.addFields({ name: "Reporting", value: "Use the buttons to report which team won the match." });

    return activeMatchEmbed;
  }

  static voteForCaptainsOrRandomEmbed(title: string, description: string): BaseEmbed {
    return new BaseEmbed({ color: 5763719, description, title });
  }

  static captainsChooseEmbed(team: Team, captain: string): BaseEmbed {
    switch (team) {
      case Team.Blue:
        return new BaseEmbed({ color: 3447003, description: "🔷 " + captain + " 🔷 chooses first" });
      case Team.Orange:
        return new BaseEmbed({ color: 15105570, description: "🔶 " + captain + " 🔶 choose 2 players" });
    }
  }
}
