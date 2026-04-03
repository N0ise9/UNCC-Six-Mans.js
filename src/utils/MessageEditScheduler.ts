import { Message } from "discord.js";

/**
 * Coalesces bursts of edits into a single Discord API call per message.
 *
 * - Debounces for a short window (default 600ms)
 * - Ensures only one in-flight edit per message
 * - If edits arrive while an edit is in-flight, it will run one more edit with the latest payload
 */
type EditPayload = Parameters<Message["edit"]>[0];

interface Entry {
  timer: NodeJS.Timeout | null;
  inFlight: Promise<unknown> | null;
  dirty: boolean;
  latest: EditPayload | null;
}

export class MessageEditScheduler {
  private entries = new Map<string, Entry>();

  constructor(private readonly debounceMs: number = 600) {}

  schedule(message: Message, payload: EditPayload) {
    const key = message.id;
    const entry = this.entries.get(key) ?? { dirty: false, inFlight: null, latest: null, timer: null };
    entry.latest = payload;

    if (entry.inFlight) {
      // An edit is currently running; mark dirty so we apply latest after it finishes.
      entry.dirty = true;
      this.entries.set(key, entry);
      return;
    }

    if (entry.timer) {
      this.entries.set(key, entry);
      return; // already scheduled; latest payload updated
    }

    entry.timer = setTimeout(() => this.flush(message).catch(() => {}), this.debounceMs);
    this.entries.set(key, entry);
  }

  async flush(message: Message) {
    const key = message.id;
    const entry = this.entries.get(key);
    if (!entry) return;

    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }

    if (entry.inFlight) return;

    const payload = entry.latest;
    if (!payload) {
      this.entries.delete(key);
      return;
    }

    entry.inFlight = message
      .edit(payload)
      .catch(() => {
        // Message may have been deleted; ignore.
      })
      .finally(() => {
        const cur = this.entries.get(key);
        if (!cur) return;

        cur.inFlight = null;

        if (cur.dirty) {
          cur.dirty = false;
          // Immediate flush for newest payload
          cur.timer = setTimeout(() => this.flush(message).catch(() => {}), 0);
          this.entries.set(key, cur);
          return;
        }

        if (!cur.timer) this.entries.delete(key);
      });

    this.entries.set(key, entry);
    await entry.inFlight;
  }
}

// Single shared scheduler for the process.
export const messageEditScheduler = new MessageEditScheduler(600);
