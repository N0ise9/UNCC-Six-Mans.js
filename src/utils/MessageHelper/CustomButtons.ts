import { ButtonBuilder, ButtonStyle } from "discord.js";

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

interface CustomButtonOptions extends Partial<Omit<ButtonBuilder, "customId">> {
  customId: ButtonCustomID;
}

export default class CustomButton extends ButtonBuilder {
  constructor(customOptions: CustomButtonOptions) {
    super(customOptions);
    switch (customOptions.customId) {
      case ButtonCustomID.JoinQueue:
        return new ButtonBuilder().setCustomId("joinQueue").setLabel("Join").setStyle(ButtonStyle.Success);
      case ButtonCustomID.LeaveQueue:
        return new ButtonBuilder().setCustomId("leaveQueue").setLabel("Leave").setStyle(ButtonStyle.Danger);
      case ButtonCustomID.CreateRandomTeam:
        return new ButtonBuilder().setCustomId("randomizeTeams").setLabel("Random").setStyle(ButtonStyle.Primary);
      case ButtonCustomID.ChooseTeam:
        return new ButtonBuilder().setCustomId("chooseTeam").setLabel("Captains").setStyle(ButtonStyle.Primary);
      case ButtonCustomID.FillTeam:
        return new ButtonBuilder().setCustomId("fillTeam").setLabel("DEV: Fill Queue").setStyle(ButtonStyle.Danger);
      case ButtonCustomID.RemoveAll:
        return new ButtonBuilder().setCustomId("removeAll").setLabel("DEV: Remove All").setStyle(ButtonStyle.Danger);
      case ButtonCustomID.BreakMatch:
        return new ButtonBuilder().setCustomId("breakMatch").setLabel("DEV: Break Match").setStyle(ButtonStyle.Danger);
      case ButtonCustomID.BrokenQueue:
        return new ButtonBuilder().setCustomId("brokenQueue").setLabel("Broken Queue").setStyle(ButtonStyle.Danger);
      case ButtonCustomID.ReportBlue:
        return new ButtonBuilder()
          .setCustomId("reportBlue")
          .setLabel("🔷 Blue Team Won 🔷")
          .setStyle(ButtonStyle.Secondary);
      case ButtonCustomID.ReportOrange:
        return new ButtonBuilder()
          .setCustomId("reportOrange")
          .setLabel("🔶 Orange Team Won 🔶")
          .setStyle(ButtonStyle.Secondary);
    }
  }
}

// export default class CustomButton extends ButtonBuilder {
//   constructor(customOptions: CustomButtonOptions) {
//     const options: ButtonComponent = (() => {
//       switch (customOptions.customId) {
//         case ButtonCustomID.JoinQueue:
//           return {
//             disabled: false,
//             emoji: null,
//             label: "Join",
//             style: ButtonStyle.Success,
//             url: "",
//             ...customOptions,
//           };
//         case ButtonCustomID.LeaveQueue:
//           return {
//             disabled: false,
//             emoji: null,
//             label: "Leave",
//             style: ButtonStyle.Danger,
//             url: "",
//             ...customOptions,
//           };
//         case ButtonCustomID.CreateRandomTeam:
//           return {
//             disabled: false,
//             emoji: null,
//             label: "Random",
//             style: ButtonStyle.Primary,
//             url: "",
//             ...customOptions,
//           };
//         case ButtonCustomID.ChooseTeam:
//           return {
//             disabled: false,
//             emoji: null,
//             label: "Captains",
//             style: ButtonStyle.Primary,
//             url: "",
//             ...customOptions,
//           };
//         case ButtonCustomID.FillTeam:
//           return {
//             disabled: false,
//             emoji: null,
//             label: "DEV: Fill Queue",
//             style: ButtonStyle.Danger,
//             url: "",
//             ...customOptions,
//           };
//         case ButtonCustomID.RemoveAll:
//           return {
//             disabled: false,
//             emoji: null,
//             label: "DEV: Remove All",
//             style: ButtonStyle.Danger,
//             url: "",
//             ...customOptions,
//           };
//         case ButtonCustomID.BreakMatch:
//           return {
//             disabled: false,
//             emoji: null,
//             label: "DEV: Break Match",
//             style: ButtonStyle.Danger,
//             url: "",
//             ...customOptions,
//           };
//         case ButtonCustomID.ReportBlue:
//           return {
//             disabled: false,
//             emoji: null,
//             label: "🔷 Blue Team Won 🔷",
//             style: ButtonStyle.Secondary,
//             url: "",
//             ...customOptions,
//           };
//         case ButtonCustomID.ReportOrange:
//           return {
//             disabled: false,
//             emoji: null,
//             label: "🔶 Orange Team Won 🔶",
//             style: ButtonStyle.Secondary,
//             url: "",
//             ...customOptions,
//           };
//         case ButtonCustomID.BrokenQueue:
//           return {
//             disabled: false,
//             emoji: null,
//             label: "Broken Queue",
//             style: ButtonStyle.Danger,
//             url: "",
//             ...customOptions,
//           };
//       }
//     })();

//     super(options);
//   }
// }
