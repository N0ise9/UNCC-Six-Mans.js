import { DiscordWorkScheduler } from "../DiscordWorkScheduler";

describe("DiscordWorkScheduler", () => {
  it("replaces queued edits that share a dedupe key", async () => {
    const scheduler = new DiscordWorkScheduler(1, 0);
    const blockerSignal: { release?: () => void } = {};

    const blocker = scheduler.enqueue(
      async () =>
        await new Promise<void>((resolve) => {
          blockerSignal.release = resolve;
        }),
      {
        label: "blocker",
        priority: "high",
      }
    );

    const firstTask = jest.fn(async () => "first");
    const secondTask = jest.fn(async () => "second");

    const firstPromise = scheduler.enqueue(firstTask, {
      coalesce: "replace",
      dedupeKey: "message-edit:queue",
      label: "queue-edit",
    });
    const secondPromise = scheduler.enqueue(secondTask, {
      coalesce: "replace",
      dedupeKey: "message-edit:queue",
      label: "queue-edit",
    });

    await Promise.resolve();
    const unblock = blockerSignal.release;
    if (typeof unblock === "function") {
      unblock();
    }
    await blocker;
    await scheduler.drain();

    await expect(firstPromise).resolves.toBeUndefined();
    await expect(secondPromise).resolves.toBe("second");
    expect(firstTask).not.toHaveBeenCalled();
    expect(secondTask).toHaveBeenCalledTimes(1);
  });

  it("drops obsolete work when shouldRun fails before dispatch", async () => {
    const scheduler = new DiscordWorkScheduler(1, 0);
    const execute = jest.fn(async () => "stale");

    const result = await scheduler.enqueue(execute, {
      label: "obsolete-edit",
      shouldRun: () => false,
    });

    await scheduler.drain();

    expect(result).toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });

  it("retries rate-limited work and resumes processing after retry_after", async () => {
    const scheduler = new DiscordWorkScheduler(1, 0);
    let attempts = 0;
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const result = await scheduler.enqueue(
        async () => {
          attempts += 1;
          if (attempts === 1) {
            throw { retryAfter: 0.001 };
          }

          return "ok";
        },
        {
          label: "rate-limited-edit",
        }
      );

      await scheduler.drain();

      expect(result).toBe("ok");
      expect(attempts).toBe(2);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
