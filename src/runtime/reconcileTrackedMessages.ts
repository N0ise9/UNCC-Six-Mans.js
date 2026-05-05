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
        rateLimitKey: `message:${message.id}:edit`,
      });

      nextMessages.push(edited ?? message);
      continue;
    }

    if (!message && payload) {
      const created = await scheduler.enqueue(async () => await channel.send(payload), {
        label: `${labelPrefix}-create-${index}`,
        priority,
        rateLimitKey: `channel:${channel.id}:send`,
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
        rateLimitKey: `message:${message.id}:delete`,
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
  const normalizedPayloads = normalizeKeyedPayloads(payloads);
  const trackedByKey = new Map<string, KeyedTrackedMessage>();
  const duplicateTrackedMessages: KeyedTrackedMessage[] = [];
  const usedKeys = new Set<string>();
  const nextMessages: KeyedTrackedMessage[] = [];

  for (const trackedMessage of trackedMessages) {
    if (trackedByKey.has(trackedMessage.key)) {
      duplicateTrackedMessages.push(trackedMessage);
      continue;
    }

    trackedByKey.set(trackedMessage.key, trackedMessage);
  }

  for (const keyedPayload of normalizedPayloads) {
    const trackedMessage = trackedByKey.get(keyedPayload.key);
    if (trackedMessage) {
      const edited = await scheduler.enqueue(async () => await trackedMessage.message.edit(keyedPayload.payload), {
        coalesce: "replace",
        dedupeKey: `message-edit:${trackedMessage.message.id}`,
        label: `${labelPrefix}-edit-${keyedPayload.key}`,
        priority,
        rateLimitKey: `message:${trackedMessage.message.id}:edit`,
      });

      nextMessages.push({
        key: keyedPayload.key,
        message: edited ?? trackedMessage.message,
      });
      checkpointKeyedTrackedMessage(trackedMessages, keyedPayload.key, edited ?? trackedMessage.message);
      usedKeys.add(keyedPayload.key);
      continue;
    }

    const created = await scheduler.enqueue(async () => await channel.send(keyedPayload.payload), {
      label: `${labelPrefix}-create-${keyedPayload.key}`,
      priority,
      rateLimitKey: `channel:${channel.id}:send`,
    });

    if (created) {
      nextMessages.push({
        key: keyedPayload.key,
        message: created,
      });
      checkpointKeyedTrackedMessage(trackedMessages, keyedPayload.key, created);
    }
    usedKeys.add(keyedPayload.key);
  }

  for (const duplicateTrackedMessage of duplicateTrackedMessages) {
    await scheduler.enqueue(async () => await duplicateTrackedMessage.message.delete().catch(() => undefined), {
      coalesce: "replace",
      dedupeKey: `message-delete:${duplicateTrackedMessage.message.id}`,
      label: `${labelPrefix}-delete-duplicate-${duplicateTrackedMessage.key}`,
      priority,
      rateLimitKey: `message:${duplicateTrackedMessage.message.id}:delete`,
    });
  }

  for (const trackedMessage of trackedMessages) {
    if (!trackedByKey.has(trackedMessage.key)) {
      continue;
    }

    if (trackedByKey.get(trackedMessage.key)?.message.id !== trackedMessage.message.id) {
      continue;
    }

    if (usedKeys.has(trackedMessage.key)) {
      continue;
    }

    await scheduler.enqueue(async () => await trackedMessage.message.delete().catch(() => undefined), {
      coalesce: "replace",
      dedupeKey: `message-delete:${trackedMessage.message.id}`,
      label: `${labelPrefix}-delete-${trackedMessage.key}`,
      priority,
      rateLimitKey: `message:${trackedMessage.message.id}:delete`,
    });
  }

  return nextMessages;
}

function checkpointKeyedTrackedMessage(
  trackedMessages: KeyedTrackedMessage[],
  key: string,
  message: Message
): void {
  const existingIndex = trackedMessages.findIndex((trackedMessage) => trackedMessage.key === key);
  const checkpoint = { key, message };

  if (existingIndex >= 0) {
    trackedMessages[existingIndex] = checkpoint;
    return;
  }

  trackedMessages.push(checkpoint);
}

function normalizeKeyedPayloads(
  payloads: Array<{ key: string; payload: BaseMessageOptions }>
): Array<{ key: string; payload: BaseMessageOptions }> {
  const orderedKeys: string[] = [];
  const payloadByKey = new Map<string, BaseMessageOptions>();

  for (const keyedPayload of payloads) {
    if (!payloadByKey.has(keyedPayload.key)) {
      orderedKeys.push(keyedPayload.key);
    }

    payloadByKey.set(keyedPayload.key, keyedPayload.payload);
  }

  return orderedKeys.map((key) => ({
    key,
    payload: payloadByKey.get(key)!,
  }));
}
