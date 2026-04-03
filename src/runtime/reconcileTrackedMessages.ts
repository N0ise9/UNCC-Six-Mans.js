import { BaseMessageOptions, Message, TextChannel } from "discord.js";
import { DiscordWorkScheduler } from "./DiscordWorkScheduler";

interface ReconcileTrackedMessagesOptions {
  channel: TextChannel;
  labelPrefix: string;
  payloads: BaseMessageOptions[];
  priority?: "high" | "normal" | "low";
  scheduler: DiscordWorkScheduler;
  trackedMessages: Message[];
}

export async function reconcileTrackedMessages({
  channel,
  labelPrefix,
  payloads,
  priority = "normal",
  scheduler,
  trackedMessages,
}: ReconcileTrackedMessagesOptions): Promise<Message[]> {
  const nextMessages: Message[] = [];
  const total = Math.max(trackedMessages.length, payloads.length);

  for (let index = 0; index < total; index += 1) {
    const message = trackedMessages[index];
    const payload = payloads[index];

    if (message && payload) {
      const edited = await scheduler.enqueue(async () => await message.edit(payload), {
        coalesce: "replace",
        dedupeKey: `message-edit:${message.id}`,
        label: `${labelPrefix}-edit-${index}`,
        priority,
      });

      nextMessages.push(edited ?? message);
      continue;
    }

    if (!message && payload) {
      const created = await scheduler.enqueue(async () => await channel.send(payload), {
        label: `${labelPrefix}-create-${index}`,
        priority,
      });

      if (created) {
        nextMessages.push(created);
      }
      continue;
    }

    if (message) {
      await scheduler.enqueue(async () => await message.delete().catch(() => undefined), {
        coalesce: "replace",
        dedupeKey: `message-delete:${message.id}`,
        label: `${labelPrefix}-delete-${index}`,
        priority,
      });
    }
  }

  return nextMessages;
}
