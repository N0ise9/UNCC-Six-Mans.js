import { ActionRowBuilder, ButtonBuilder } from "discord.js";
import { getEnvVariable } from "../utils";
import CustomButton, { ButtonCustomID, QueueButtonOptions } from "./CustomButtons";

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
  static queueButtons(options: QueueButtonOptions = { disabled: false }): ActionRowBuilder {
    const dynamicJoinButton = new CustomButton({
      customId: ButtonCustomID.JoinQueue,
      disabled: options.disabled,
      label: options.disabled && options.buttonId === ButtonCustomID.JoinQueue ? "Please wait..." : "Join",
    });
    const dynamicLeaveButton = new CustomButton({
      customId: ButtonCustomID.LeaveQueue,
      disabled: options.disabled,
      label: options.disabled && options.buttonId === ButtonCustomID.LeaveQueue ? "Please wait..." : "Leave",
    });

    const components = [dynamicJoinButton, dynamicLeaveButton];
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
