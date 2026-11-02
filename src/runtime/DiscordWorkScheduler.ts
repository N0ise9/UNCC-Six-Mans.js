type TaskPriority = "high" | "normal" | "low";
type CoalesceStrategy = "replace" | "keep-both";

interface ScheduledTask<T> {
  attempts: number;
  coalesce: CoalesceStrategy;
  createdAt: number;
  dedupeKey?: string;
  execute: () => Promise<T>;
  id: number;
  label: string;
  maxRetries: number;
  onRateLimit?: (details: { global: boolean; retryAfterMs: number }) => void;
  priority: TaskPriority;
  rateLimitKey?: string;
  reject: (reason?: unknown) => void;
  resolve: (value: T | undefined) => void;
  shouldRun?: () => boolean;
}

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  high: 0,
  low: 2,
  normal: 1,
};

export class DiscordWorkScheduler {
  private readonly queue: Array<ScheduledTask<unknown>> = [];
  private running = 0;
  private nextTaskId = 1;
  private globalPausedUntil = 0;
  private readonly pausedUntilByLane = new Map<string, number>();
  private nextDispatchAt = 0;

  constructor(
    private readonly maxConcurrent: number = 2,
    private readonly minSpacingMs: number = 75
  ) {}

  async drain(): Promise<void> {
    while (this.queue.length > 0 || this.running > 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  enqueue<T>(
    execute: () => Promise<T>,
    options?: {
      coalesce?: CoalesceStrategy;
      dedupeKey?: string;
      label?: string;
      maxRetries?: number;
      onRateLimit?: (details: { global: boolean; retryAfterMs: number }) => void;
      priority?: TaskPriority;
      rateLimitKey?: string;
      shouldRun?: () => boolean;
    }
  ): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve, reject) => {
      const task: ScheduledTask<T> = {
        attempts: 0,
        coalesce: options?.coalesce ?? "keep-both",
        createdAt: Date.now(),
        dedupeKey: options?.dedupeKey,
        execute,
        id: this.nextTaskId++,
        label: options?.label ?? "discord-task",
        maxRetries: options?.maxRetries ?? 3,
        onRateLimit: options?.onRateLimit,
        priority: options?.priority ?? "normal",
        rateLimitKey: options?.rateLimitKey,
        reject,
        resolve,
        shouldRun: options?.shouldRun,
      };

      if (task.dedupeKey && task.coalesce === "replace") {
        const existingIndex = this.queue.findIndex((queuedTask) => queuedTask.dedupeKey === task.dedupeKey);
        if (existingIndex >= 0) {
          const [replaced] = this.queue.splice(existingIndex, 1);
          replaced.resolve(undefined);
        }
      }

      this.queue.push(task as ScheduledTask<unknown>);
      this.queue.sort((left, right) => {
        const priorityDiff = PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority];
        if (priorityDiff !== 0) return priorityDiff;
        return left.createdAt - right.createdAt;
      });
      this.pump();
    });
  }

  private handleFailure(task: ScheduledTask<unknown>, error: unknown): void {
    const retry = getRetryAfter(error);
    if (retry && task.attempts < task.maxRetries) {
      const resumeAt = Date.now() + retry.retryAfterMs;
      if (retry.global || !task.rateLimitKey) {
        this.globalPausedUntil = Math.max(this.globalPausedUntil, resumeAt);
      } else {
        this.pausedUntilByLane.set(task.rateLimitKey, Math.max(this.getLanePause(task.rateLimitKey), resumeAt));
      }
      task.attempts += 1;
      task.onRateLimit?.(retry);
      this.queue.unshift(task);
      console.warn(`[DiscordWorkScheduler] ${task.label} rate limited; retrying in ${retry.retryAfterMs}ms`);
      this.pump();
      return;
    }

    task.reject(error);
    this.pump();
  }

  private pump(): void {
    if (this.running >= this.maxConcurrent) return;

    const now = Date.now();
    this.cleanupExpiredLanePauses(now);

    if (this.globalPausedUntil > now) {
      scheduleTimer(this.globalPausedUntil - now, () => this.pump());
      return;
    }

    if (this.nextDispatchAt > now) {
      scheduleTimer(this.nextDispatchAt - now, () => this.pump());
      return;
    }

    const nextTaskIndex = this.findNextRunnableTaskIndex(now);
    if (nextTaskIndex < 0) {
      const nextWakeAt = this.getNextWakeAt(now);
      if (nextWakeAt !== null) {
        scheduleTimer(Math.max(0, nextWakeAt - now), () => this.pump());
      }
      return;
    }

    const [task] = this.queue.splice(nextTaskIndex, 1);
    if (!task) return;

    if (task.shouldRun && !task.shouldRun()) {
      task.resolve(undefined);
      this.pump();
      return;
    }

    this.running += 1;
    this.nextDispatchAt = now + this.minSpacingMs;

    void task
      .execute()
      .then((value) => {
        task.resolve(value);
      })
      .catch((error) => {
        this.handleFailure(task, error);
      })
      .finally(() => {
        this.running -= 1;
        this.pump();
      });
  }

  private cleanupExpiredLanePauses(now: number): void {
    for (const [laneKey, pausedUntil] of this.pausedUntilByLane) {
      if (pausedUntil <= now) {
        this.pausedUntilByLane.delete(laneKey);
      }
    }
  }

  private findNextRunnableTaskIndex(now: number): number {
    for (let index = 0; index < this.queue.length; index += 1) {
      const task = this.queue[index];
      if (!task) continue;

      const lanePause = task.rateLimitKey ? this.getLanePause(task.rateLimitKey) : 0;
      if (lanePause > now) {
        continue;
      }

      return index;
    }

    return -1;
  }

  private getLanePause(laneKey: string): number {
    return this.pausedUntilByLane.get(laneKey) ?? 0;
  }

  private getNextWakeAt(now: number): number | null {
    let nextWakeAt: number | null = null;
    for (const pausedUntil of this.pausedUntilByLane.values()) {
      if (pausedUntil > now) {
        nextWakeAt = nextWakeAt === null ? pausedUntil : Math.min(nextWakeAt, pausedUntil);
      }
    }

    return nextWakeAt;
  }
}

function getRetryAfter(error: unknown): { global: boolean; retryAfterMs: number } | null {
  if (typeof error !== "object" || error === null) return null;

  const candidate = error as {
    code?: number | string;
    rawError?: { global?: boolean; retry_after?: number };
    retryAfter?: number;
    status?: number;
  };

  const retryAfterSeconds = candidate.retryAfter ?? candidate.rawError?.retry_after;
  if (retryAfterSeconds !== undefined) {
    return {
      global: candidate.rawError?.global === true,
      retryAfterMs: Math.ceil(retryAfterSeconds * 1000),
    };
  }

  if (candidate.status === 429) {
    return {
      global: false,
      retryAfterMs: 1000,
    };
  }

  return null;
}

function scheduleTimer(delayMs: number, callback: () => void): void {
  const timer = setTimeout(callback, delayMs);
  timer.unref?.();
}
