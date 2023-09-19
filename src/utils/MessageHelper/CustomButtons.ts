import { InteractionButtonOptions, MessageButton } from "discord.js";

export const enum ButtonCustomID {
  JoinQueue = "joinQueue",
  LeaveQueue = "leaveQueue",
  CreateRandomTeam = "randomizeTeams",
  ChooseTeam = "chooseTeam",
  FillTeam = "fillTeam",
  RemoveAll = "removeAll",
  BreakMatch = "breakMatch",
  ReportBlue = "reportBlue",
  ReportOrange = "reportOrange",
  BrokenQueue = "brokenQueue",
}

export type QueueButtonOptions =
  | {
    disabled: true;
    buttonId: ButtonCustomID;
  }
  | {
    disabled: false;
  };

interface CustomButtonOptions extends Partial<Omit<InteractionButtonOptions, "customId">> {
  customId: ButtonCustomID;
}

export default class CustomButton extends MessageButton {
  constructor(customOptions: CustomButtonOptions) {
    const options: InteractionButtonOptions = (() => {
      switch (customOptions.customId) {
        case ButtonCustomID.JoinQueue:
          return {
            label: "Join",
            style: "SUCCESS",
            ...customOptions,
          };
        case ButtonCustomID.LeaveQueue:
          return {
            label: "Leave",
            style: "DANGER",
            ...customOptions,
          };
        case ButtonCustomID.CreateRandomTeam:
          return {
            label: "Random",
            style: "PRIMARY",
            ...customOptions,
          };
        case ButtonCustomID.ChooseTeam:
          return {
            label: "Captains",
            style: "PRIMARY",
            ...customOptions,
          };
        case ButtonCustomID.FillTeam:
          return {
            label: "DEV: Fill Queue",
            style: "DANGER",
            ...customOptions,
          };
        case ButtonCustomID.RemoveAll:
          return {
            label: "DEV: Remove All",
            style: "DANGER",
            ...customOptions,
          };
        case ButtonCustomID.BreakMatch:
          return {
            label: "DEV: Break Match",
            style: "DANGER",
            ...customOptions,
          };
        case ButtonCustomID.ReportBlue:
          return {
            label: "🔷 Blue Team Won 🔷",
            style: "SECONDARY",
            ...customOptions,
          };
        case ButtonCustomID.ReportOrange:
          return {
            label: "🔶 Orange Team Won 🔶",
            style: "SECONDARY",
            ...customOptions,
          };
        case ButtonCustomID.BrokenQueue:
          return {
            label: "Broken Queue",
            style: "DANGER",
            ...customOptions,
          };
      }
    })();

    super(options);
  }
}
