import { ActionRowBuilder, ButtonBuilder } from "discord.js";
import { getEnvVariable } from "../utils";
import CustomButton, { ButtonCustomID } from "./CustomButtons";

const isDev = getEnvVariable("ENVIRONMENT") === "dev";

const leaveButton = new CustomButton({ customId: ButtonCustomID.LeaveQueue });
const fillTeamButton = new CustomButton({ customId: ButtonCustomID.FillTeam });
const removeAllButton = new CustomButton({ customId: ButtonCustomID.RemoveAll });
const randomTeamsButton = new CustomButton({ customId: ButtonCustomID.CreateRandomTeam });
const chooseTeamsButton = new CustomButton({ customId: ButtonCustomID.ChooseTeam });
const breakMatchButton = new CustomButton({ customId: ButtonCustomID.BreakMatch });
const reportBlueWonButton = new CustomButton({ customId: ButtonCustomID.ReportBlue });
const reportOrangeWonButton = new CustomButton({ customId: ButtonCustomID.ReportOrange });
const brokenQueueButton = new CustomButton({ customId: ButtonCustomID.BrokenQueue });

export default class MessageButtons extends ButtonBuilder {
  static queueButtons(): ActionRowBuilder {
    const joinButton = new CustomButton({
      customId: ButtonCustomID.JoinQueue,
    });
    const leaveButton = new CustomButton({
      customId: ButtonCustomID.LeaveQueue,
    });

    const components = [joinButton, leaveButton];
    if (isDev) {
      components.push(fillTeamButton, removeAllButton);
    }
    return new ActionRowBuilder({ components: components });
  }

  static fullQueueButtons(): ActionRowBuilder {
    const components = [chooseTeamsButton, randomTeamsButton, leaveButton];

    if (isDev) {
      components.push(removeAllButton);
    }
    return new ActionRowBuilder({ components: components });
  }

  static activeMatchButtons(): ActionRowBuilder {
    const components = [brokenQueueButton, reportBlueWonButton, reportOrangeWonButton];
    if (isDev) {
      components.push(breakMatchButton);
    }
    return new ActionRowBuilder({ components: components });
  }

  static breakMatchButtons(): ActionRowBuilder {
    return new ActionRowBuilder({ components: [breakMatchButton] });
  }

  static removeAllButtons(): ActionRowBuilder {
    return new ActionRowBuilder({ components: [removeAllButton] });
  }
}
