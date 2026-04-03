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
  priority: TaskPriority;
  reject: (reason?: unknown) => void;
  resolve: (value: T | undefined) => void;
  shouldRun?: () => boolean;
}

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  high: 0,
  normal: 1,
  low: 2,
};

export class DiscordWorkScheduler {
  private readonly queue: Array<ScheduledTask<unknown>> = [];
  private running = 0;
  private nextTaskId = 1;
  private pausedUntil = 0;
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
      priority?: TaskPriority;
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
        priority: options?.priority ?? "normal",
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
    const retryAfterMs = getRetryAfterMs(error);
    if (retryAfterMs && task.attempts < task.maxRetries) {
      this.pausedUntil = Math.max(this.pausedUntil, Date.now() + retryAfterMs);
      task.attempts += 1;
      this.queue.unshift(task);
      console.warn(`[DiscordWorkScheduler] ${task.label} rate limited; retrying in ${retryAfterMs}ms`);
      this.pump();
      return;
    }

    task.reject(error);
    this.pump();
  }

  private pump(): void {
    if (this.running >= this.maxConcurrent) return;

    const now = Date.now();
    if (this.pausedUntil > now) {
      setTimeout(() => this.pump(), this.pausedUntil - now);
      return;
    }

    if (this.nextDispatchAt > now) {
      setTimeout(() => this.pump(), this.nextDispatchAt - now);
      return;
    }

    const task = this.queue.shift();
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
}

function getRetryAfterMs(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;

  const candidate = error as {
    code?: number | string;
    rawError?: { retry_after?: number };
    retryAfter?: number;
    status?: number;
  };

  const retryAfterSeconds = candidate.retryAfter ?? candidate.rawError?.retry_after;
  if (retryAfterSeconds !== undefined) {
    return Math.ceil(retryAfterSeconds * 1000);
  }

  if (candidate.status === 429) {
    return 1000;
  }

  return null;
}
