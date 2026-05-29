import { ChatInputCommandInteraction } from "discord.js";
import { DiscordWorkScheduler } from "./DiscordWorkScheduler";

type ScheduledCommandResponder = {
  edit: (payload: Parameters<ChatInputCommandInteraction["editReply"]>[0]) => Promise<void>;
  followUp: (payload: Parameters<ChatInputCommandInteraction["followUp"]>[0]) => Promise<void>;
};

export function createScheduledCommandResponder(
  interaction: ChatInputCommandInteraction,
  scheduler: DiscordWorkScheduler,
  labelPrefix: string,
  priority: "high" | "normal" | "low" = "normal"
): ScheduledCommandResponder {
  return {
    edit: async (payload) => {
      await scheduler.enqueue(async () => await interaction.editReply(payload), {
        coalesce: "replace",
        dedupeKey: `interaction-edit:${interaction.id}`,
        label: `${labelPrefix}-edit-reply`,
        priority,
        rateLimitKey: `interaction:${interaction.id}`,
      });
    },
    followUp: async (payload) => {
      await scheduler.enqueue(async () => await interaction.followUp(payload), {
        label: `${labelPrefix}-follow-up`,
        priority,
        rateLimitKey: `interaction:${interaction.id}`,
      });
    },
  };
}
