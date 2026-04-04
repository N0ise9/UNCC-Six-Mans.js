import { ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { ensurePrismaStudioAssetsExtracted } from "./PrismaStudioAssets";
import {
  getPrismaStudioCliPath,
  getPrismaStudioConfigPath,
  getPrismaStudioNodePath,
  getPrismaStudioWorkspaceRoot,
  isPackagedRuntime,
} from "./runtimePaths";
import { GuildInstanceConfig } from "./types";

type ManagedStudioProcess = {
  child: ChildProcess;
  exited: boolean;
  guildId: string;
  port: number;
};

type PrismaStudioManagerOptions = {
  browserOpener?: (url: string) => Promise<void>;
  ensurePackagedAssets?: () => Promise<void> | void;
  isPortAvailable?: (port: number) => Promise<boolean>;
  isPortOpen?: (port: number) => Promise<boolean>;
  packaged?: boolean;
  portCandidates?: number[];
  readyPollMs?: number;
  readyTimeoutMs?: number;
  spawnProcess?: typeof spawn;
};

const DEFAULT_PORT_CANDIDATES = Array.from({ length: 10 }, (_, index) => 5555 + index);
const LOCALHOST = "127.0.0.1";

export class PrismaStudioManager {
  private readonly browserOpener: (url: string) => Promise<void>;
  private readonly ensurePackagedAssets: () => Promise<void> | void;
  private readonly isPortAvailableFn: (port: number) => Promise<boolean>;
  private readonly isPortOpenFn: (port: number) => Promise<boolean>;
  private readonly portCandidates: number[];
  private readonly readyPollMs: number;
  private readonly readyTimeoutMs: number;
  private readonly spawnProcess: typeof spawn;
  private activeProcess: ManagedStudioProcess | null = null;

  constructor(private readonly options: PrismaStudioManagerOptions = {}) {
    this.browserOpener = options.browserOpener ?? openDefaultBrowser;
    this.ensurePackagedAssets =
      options.ensurePackagedAssets ??
      (() => {
        ensurePrismaStudioAssetsExtracted();
      });
    this.isPortAvailableFn = options.isPortAvailable ?? isPortAvailable;
    this.isPortOpenFn = options.isPortOpen ?? isPortOpen;
    this.portCandidates = options.portCandidates ?? DEFAULT_PORT_CANDIDATES;
    this.readyPollMs = options.readyPollMs ?? 250;
    this.readyTimeoutMs = options.readyTimeoutMs ?? 15_000;
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  async dispose(): Promise<void> {
    await this.stopActiveProcess();
  }

  async launchForGuild(config: GuildInstanceConfig): Promise<void> {
    if (
      this.activeProcess &&
      !this.activeProcess.exited &&
      this.activeProcess.guildId === config.guildId &&
      (await this.isPortOpenFn(this.activeProcess.port))
    ) {
      await this.browserOpener(getStudioUrl(this.activeProcess.port));
      return;
    }

    await this.stopActiveProcess();

    const packaged = isPackagedRuntime({ packaged: this.options.packaged });
    if (packaged) {
      await this.ensurePackagedAssets();
    }

    const port = await this.resolvePort();
    const child = this.spawnStudio(config.databaseUrl, port, packaged);
    const managed: ManagedStudioProcess = {
      child,
      exited: false,
      guildId: config.guildId,
      port,
    };

    child.once("exit", () => {
      managed.exited = true;
      if (this.activeProcess?.child === child) {
        this.activeProcess = null;
      }
    });

    this.activeProcess = managed;
    await this.waitForStudioReady(port, child);
    await this.browserOpener(getStudioUrl(port));
  }

  private async resolvePort(): Promise<number> {
    for (const port of this.portCandidates) {
      if (await this.isPortAvailableFn(port)) {
        return port;
      }
    }

    throw new Error("No localhost port is available for Prisma Studio.");
  }

  private spawnStudio(databaseUrl: string, port: number, packaged: boolean): ChildProcess {
    const nodePath = getPrismaStudioNodePath({ packaged });
    const cliPath = getPrismaStudioCliPath({ packaged });
    const workspaceRoot = getPrismaStudioWorkspaceRoot({ packaged });
    const configPath = getPrismaStudioConfigPath({ packaged });

    ensureFileExists(nodePath, "Prisma Studio node runtime");
    ensureFileExists(cliPath, "Prisma Studio CLI");
    ensureFileExists(configPath, "Prisma Studio config");
    if (!fs.existsSync(workspaceRoot)) {
      throw new Error(`Prisma Studio workspace was not found at ${workspaceRoot}.`);
    }

    const child = this.spawnProcess(
      nodePath,
      [cliPath, "studio", "--port", String(port), "--browser", "none", "--config", configPath],
      {
        cwd: workspaceRoot,
        env: {
          ...process.env,
          BROWSER: "none",
          DATABASE_URL: databaseUrl,
        },
        stdio: "ignore",
        windowsHide: false,
      }
    );

    child.on("error", (error) => {
      console.error("[PrismaStudioManager] Prisma Studio process failed:", error);
    });

    return child;
  }

  private async stopActiveProcess(): Promise<void> {
    const current = this.activeProcess;
    this.activeProcess = null;

    if (!current || current.exited) {
      return;
    }

    await new Promise<void>((resolve) => {
      current.child.once("exit", () => resolve());
      current.child.kill();
      setTimeout(() => {
        if (!current.exited) {
          current.child.kill("SIGKILL");
        }
        resolve();
      }, 2_000).unref();
    });
  }

  private async waitForStudioReady(port: number, child: ChildProcess): Promise<void> {
    const startedAt = Date.now();

    while (Date.now() - startedAt <= this.readyTimeoutMs) {
      if (child.exitCode !== null) {
        throw new Error(`Prisma Studio exited before it became ready (exit code ${child.exitCode}).`);
      }

      if (await this.isPortOpenFn(port)) {
        return;
      }

      await delay(this.readyPollMs);
    }

    throw new Error("Prisma Studio did not become ready before the timeout elapsed.");
  }
}

function ensureFileExists(filePath: string, label: string): void {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} was not found at ${filePath}.`);
  }
}

async function isPortAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = net.createServer();

    server.once("error", () => {
      resolve(false);
    });

    server.listen(port, LOCALHOST, () => {
      server.close(() => resolve(true));
    });
  });
}

async function isPortOpen(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: LOCALHOST, port });

    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });

    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function getStudioUrl(port: number): string {
  return `http://${LOCALHOST}:${port}`;
}

async function openDefaultBrowser(url: string): Promise<void> {
  let command: string;
  let args: string[];

  switch (process.platform) {
    case "win32":
      command = "cmd.exe";
      args = ["/c", "start", "", url];
      break;
    case "darwin":
      command = "open";
      args = [url];
      break;
    default:
      command = "xdg-open";
      args = [url];
      break;
  }

  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });

  child.unref();
}
