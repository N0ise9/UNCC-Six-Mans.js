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

export const VOTE_MATCH_SIZE_PREFIX = "voteMatchSize:";

export function createVoteMatchSizeCustomId(matchSize: number): string {
  return `${VOTE_MATCH_SIZE_PREFIX}${matchSize}`;
}

export function parseVoteMatchSizeCustomId(customId: string): number | null {
  if (!customId.startsWith(VOTE_MATCH_SIZE_PREFIX)) {
    return null;
  }

  const parsed = Number.parseInt(customId.slice(VOTE_MATCH_SIZE_PREFIX.length), 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return null;
  }

  return parsed;
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
