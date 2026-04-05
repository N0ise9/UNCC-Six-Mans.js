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

interface KeyedTrackedMessage {
  key: string;
  message: Message;
}

interface ReconcileKeyedTrackedMessagesOptions {
  channel: TextChannel;
  labelPrefix: string;
  payloads: Array<{ key: string; payload: BaseMessageOptions }>;
  priority?: "high" | "normal" | "low";
  scheduler: DiscordWorkScheduler;
  trackedMessages: KeyedTrackedMessage[];
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

export async function reconcileKeyedTrackedMessages({
  channel,
  labelPrefix,
  payloads,
  priority = "normal",
  scheduler,
  trackedMessages,
}: ReconcileKeyedTrackedMessagesOptions): Promise<KeyedTrackedMessage[]> {
  const trackedByKey = new Map(trackedMessages.map((trackedMessage) => [trackedMessage.key, trackedMessage]));
  const usedKeys = new Set<string>();
  const nextMessages: KeyedTrackedMessage[] = [];

  for (const keyedPayload of payloads) {
    const trackedMessage = trackedByKey.get(keyedPayload.key);
    if (trackedMessage) {
      const edited = await scheduler.enqueue(async () => await trackedMessage.message.edit(keyedPayload.payload), {
        coalesce: "replace",
        dedupeKey: `message-edit:${trackedMessage.message.id}`,
        label: `${labelPrefix}-edit-${keyedPayload.key}`,
        priority,
      });

      nextMessages.push({
        key: keyedPayload.key,
        message: edited ?? trackedMessage.message,
      });
      usedKeys.add(keyedPayload.key);
      continue;
    }

    const created = await scheduler.enqueue(async () => await channel.send(keyedPayload.payload), {
      label: `${labelPrefix}-create-${keyedPayload.key}`,
      priority,
    });

    if (created) {
      nextMessages.push({
        key: keyedPayload.key,
        message: created,
      });
    }
    usedKeys.add(keyedPayload.key);
  }

  for (const trackedMessage of trackedMessages) {
    if (usedKeys.has(trackedMessage.key)) {
      continue;
    }

    await scheduler.enqueue(async () => await trackedMessage.message.delete().catch(() => undefined), {
      coalesce: "replace",
      dedupeKey: `message-delete:${trackedMessage.message.id}`,
      label: `${labelPrefix}-delete-${trackedMessage.key}`,
      priority,
    });
  }

  return nextMessages;
}
