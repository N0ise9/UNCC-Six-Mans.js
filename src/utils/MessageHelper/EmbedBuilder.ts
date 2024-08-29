import { EmbedBuilder as MessageEmbed, EmbedData } from "discord.js";
import { Team } from "../../types/common";
import { ColorCodes } from "../utils";

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
    return new BaseEmbed({ color: ColorCodes.Blue, description, title });
  }

  static queueEmbed(title: string, description: string): MessageEmbed {
    return new BaseEmbed({ color: ColorCodes.Green, description, title });
  }

  static fullQueueEmbed(description: string): BaseEmbed {
    return new BaseEmbed({ color: ColorCodes.Green, description, title: "Queue is Full" });
  }

  static activeMatchEmbed(): BaseEmbed {
    return new BaseEmbed({ color: ColorCodes.DarkRed, title: "Teams are set!" });
  }

  static voteForCaptainsOrRandomEmbed(title: string, description: string): BaseEmbed {
    return new BaseEmbed({ color: ColorCodes.Green, description, title });
  }

  static captainsChooseEmbed(team: Team, captain: string): BaseEmbed {
    switch (team) {
      case Team.Blue:
        return new BaseEmbed({ color: ColorCodes.Blue, description: "🔷 " + captain + " 🔷 chooses first" });
      case Team.Orange:
        return new BaseEmbed({ color: ColorCodes.Orange, description: "🔶 " + captain + " 🔶 choose 2 players" });
    }
  }
}
