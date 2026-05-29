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

  it("does not pause unrelated lanes when one lane is rate limited", async () => {
    const scheduler = new DiscordWorkScheduler(1, 0);
    let laneAAttempts = 0;
    const executionOrder: string[] = [];
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const laneAPromise = scheduler.enqueue(
        async () => {
          laneAAttempts += 1;
          if (laneAAttempts === 1) {
            throw { retryAfter: 0.05 };
          }

          executionOrder.push("lane-a");
          return "lane-a";
        },
        {
          label: "lane-a-edit",
          rateLimitKey: "lane:a",
        }
      );

      const laneBTask = jest.fn(async () => {
        executionOrder.push("lane-b");
        return "lane-b";
      });

      const laneBPromise = scheduler.enqueue(laneBTask, {
        label: "lane-b-edit",
        rateLimitKey: "lane:b",
      });

      await expect(laneBPromise).resolves.toBe("lane-b");
      await expect(laneAPromise).resolves.toBe("lane-a");
      await scheduler.drain();

      expect(laneBTask).toHaveBeenCalledTimes(1);
      expect(executionOrder[0]).toBe("lane-b");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("still pauses all lanes for a global rate limit", async () => {
    const scheduler = new DiscordWorkScheduler(1, 0);
    let laneAAttempts = 0;
    const executionOrder: string[] = [];
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const laneAPromise = scheduler.enqueue(
        async () => {
          laneAAttempts += 1;
          if (laneAAttempts === 1) {
            throw {
              rawError: {
                global: true,
                retry_after: 0.05,
              },
            };
          }

          executionOrder.push("lane-a");
          return "lane-a";
        },
        {
          label: "lane-a-edit",
          rateLimitKey: "lane:a",
        }
      );

      const laneBTask = jest.fn(async () => {
        executionOrder.push("lane-b");
        return "lane-b";
      });

      const laneBPromise = scheduler.enqueue(laneBTask, {
        label: "lane-b-edit",
        rateLimitKey: "lane:b",
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(laneBTask).not.toHaveBeenCalled();

      await expect(laneAPromise).resolves.toBe("lane-a");
      await expect(laneBPromise).resolves.toBe("lane-b");
      await scheduler.drain();

      expect(executionOrder).toEqual(["lane-a", "lane-b"]);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
