import { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PrismaStudioManager } from "../PrismaStudioManager";
import { GuildInstanceConfig } from "../types";

function createConfig(guildId: string): GuildInstanceConfig {
  return {
    chatChannelId: `${guildId}-chat`,
    createdAt: "2026-01-01T00:00:00.000Z",
    databaseUrl: `postgresql://localhost/${guildId}`,
    enabled: true,
    guildId,
    leaderboardChannelId: `${guildId}-leaderboard`,
    queueChannelId: `${guildId}-queue`,
    soraEnabled: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function createChildProcess(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  const mutableChild = child as ChildProcess & { exitCode: number | null };
  const stdout = new EventEmitter() as NonNullable<ChildProcess["stdout"]>;
  const stderr = new EventEmitter() as NonNullable<ChildProcess["stderr"]>;
  mutableChild.exitCode = null;
  stdout.setEncoding = jest.fn() as typeof stdout.setEncoding;
  stderr.setEncoding = jest.fn() as typeof stderr.setEncoding;
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = jest.fn(() => {
    mutableChild.exitCode = 0;
    queueMicrotask(() => {
      child.emit("exit", 0);
    });
    return true;
  }) as ChildProcess["kill"];
  return child;
}

describe("PrismaStudioManager", () => {
  it("reuses the managed Prisma Studio process for repeated commands in the same guild", async () => {
    const browserOpener = jest.fn(async () => undefined);
    const spawnProcess = jest.fn(() => createChildProcess());
    const isPortOpen = jest
      .fn<Promise<boolean>, [number]>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);

    const manager = new PrismaStudioManager({
      browserOpener,
      isPortAvailable: async () => true,
      isPortOpen,
      portCandidates: [5555],
      readyPollMs: 0,
      readyTimeoutMs: 100,
      spawnProcess: spawnProcess as unknown as typeof import("node:child_process").spawn,
    });

    try {
      await manager.launchForGuild(createConfig("guild-1"));
      await manager.launchForGuild(createConfig("guild-1"));

      expect(spawnProcess).toHaveBeenCalledTimes(1);
      expect(browserOpener).toHaveBeenCalledTimes(2);
    } finally {
      await manager.dispose();
    }
  });

  it("replaces the managed Prisma Studio process when a different guild requests it", async () => {
    const browserOpener = jest.fn(async () => undefined);
    const firstChild = createChildProcess();
    const secondChild = createChildProcess();
    const spawnProcess = jest.fn().mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild);
    const isPortOpen = jest
      .fn<Promise<boolean>, [number]>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const manager = new PrismaStudioManager({
      browserOpener,
      isPortAvailable: async () => true,
      isPortOpen,
      portCandidates: [5555],
      readyPollMs: 0,
      readyTimeoutMs: 100,
      spawnProcess: spawnProcess as unknown as typeof import("node:child_process").spawn,
    });

    try {
      await manager.launchForGuild(createConfig("guild-1"));
      await manager.launchForGuild(createConfig("guild-2"));

      expect(firstChild.kill).toHaveBeenCalledTimes(1);
      expect(spawnProcess).toHaveBeenCalledTimes(2);
      expect(browserOpener).toHaveBeenCalledTimes(2);
    } finally {
      await manager.dispose();
    }
  });

  it("includes captured stderr when Prisma Studio exits before becoming ready", async () => {
    const child = createChildProcess();
    const spawnProcess = jest.fn(() => {
      queueMicrotask(() => {
        child.stderr?.emit("data", "Cannot find module 'pathe'");
        (child as ChildProcess & { exitCode: number | null }).exitCode = 1;
        child.emit("exit", 1);
      });
      return child;
    });

    const manager = new PrismaStudioManager({
      isPortAvailable: async () => true,
      isPortOpen: async () => false,
      portCandidates: [5555],
      readyPollMs: 0,
      readyTimeoutMs: 100,
      spawnProcess: spawnProcess as unknown as typeof import("node:child_process").spawn,
    });

    await expect(manager.launchForGuild(createConfig("guild-1"))).rejects.toThrow(
      "Cannot find module 'pathe'"
    );
  });
});
