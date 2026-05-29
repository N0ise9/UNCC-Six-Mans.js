import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startConsoleFileLogger } from "../ConsoleFileLogger";

type WritableTarget = {
  write: jest.Mock<boolean, unknown[]>;
};

function createWritableTarget(): WritableTarget {
  return {
    write: jest.fn((..._args: unknown[]) => true),
  };
}

describe("ConsoleFileLogger", () => {
  let tempDirectory: string;

  beforeEach(() => {
    tempDirectory = fs.mkdtempSync(path.resolve(os.tmpdir(), "norm-console-log-"));
  });

  afterEach(() => {
    fs.rmSync(tempDirectory, { force: true, recursive: true });
  });

  it("does nothing outside packaged mode", async () => {
    const stdout = createWritableTarget();
    const stderr = createWritableTarget();
    const logger = startConsoleFileLogger({
      packaged: false,
      stderr,
      stdout,
    });

    stdout.write("hello\n");
    stderr.write("warn\n");
    await logger.dispose();

    expect(logger.logFilePath).toBeNull();
    expect(stdout.write.mock.calls[0]?.[0]).toBe("hello\n");
    expect(stderr.write.mock.calls[0]?.[0]).toBe("warn\n");
    expect(fs.readdirSync(tempDirectory)).toEqual([]);
  });

  it("creates and live-updates the current packaged console log beside the executable", async () => {
    const execPath = path.resolve(tempDirectory, "Norm.exe");
    const stdout = createWritableTarget();
    const stderr = createWritableTarget();
    const logger = startConsoleFileLogger({
      execPath,
      now: new Date(2026, 3, 7, 12, 34, 56),
      packaged: true,
      stderr,
      stdout,
    });

    stdout.write("Starting Norm...\n");
    stderr.write("A warning.\n");
    await logger.dispose();

    const logPath = path.resolve(tempDirectory, "console_log-2026-04-07_12-34-56.txt");
    expect(logger.logFilePath).toBe(logPath);
    expect(stdout.write.mock.calls[0]?.[0]).toBe("Starting Norm...\n");
    expect(stderr.write.mock.calls[0]?.[0]).toBe("A warning.\n");
    expect(fs.readFileSync(logPath, "utf8")).toBe("Starting Norm...\nA warning.\n");
  });

  it("archives older console logs into a sibling logs folder on startup", async () => {
    const execPath = path.resolve(tempDirectory, "Norm.exe");
    const oldLogName = "console_log-2026-04-06_10-00-00.txt";
    fs.writeFileSync(path.resolve(tempDirectory, oldLogName), "older log\n", "utf8");
    fs.writeFileSync(path.resolve(tempDirectory, "notes.txt"), "leave me alone\n", "utf8");

    const logger = startConsoleFileLogger({
      execPath,
      now: new Date(2026, 3, 7, 12, 34, 56),
      packaged: true,
      stderr: createWritableTarget(),
      stdout: createWritableTarget(),
    });

    await logger.dispose();

    expect(fs.existsSync(path.resolve(tempDirectory, oldLogName))).toBe(false);
    expect(fs.readFileSync(path.resolve(tempDirectory, "logs", oldLogName), "utf8")).toBe("older log\n");
    expect(fs.readFileSync(path.resolve(tempDirectory, "notes.txt"), "utf8")).toBe("leave me alone\n");
  });

  it("suffixes archived log names when a collision already exists in the logs folder", async () => {
    const execPath = path.resolve(tempDirectory, "Norm.exe");
    const oldLogName = "console_log-2026-04-06_10-00-00.txt";
    fs.mkdirSync(path.resolve(tempDirectory, "logs"), { recursive: true });
    fs.writeFileSync(path.resolve(tempDirectory, oldLogName), "root copy\n", "utf8");
    fs.writeFileSync(path.resolve(tempDirectory, "logs", oldLogName), "archived copy\n", "utf8");

    const logger = startConsoleFileLogger({
      execPath,
      now: new Date(2026, 3, 7, 12, 34, 56),
      packaged: true,
      stderr: createWritableTarget(),
      stdout: createWritableTarget(),
    });

    await logger.dispose();

    expect(fs.readFileSync(path.resolve(tempDirectory, "logs", oldLogName), "utf8")).toBe("archived copy\n");
    expect(fs.readFileSync(path.resolve(tempDirectory, "logs", "console_log-2026-04-06_10-00-00-1.txt"), "utf8")).toBe(
      "root copy\n"
    );
  });

  it("falls back to console-only mode when the log stream cannot be created", async () => {
    const execPath = path.resolve(tempDirectory, "Norm.exe");
    const stdout = createWritableTarget();
    const stderr = createWritableTarget();
    const logger = startConsoleFileLogger({
      execPath,
      fileOps: {
        ...fs,
        createWriteStream: () => {
          throw new Error("disk full");
        },
      },
      packaged: true,
      stderr,
      stdout,
    });

    stdout.write("still on stdout\n");
    await logger.dispose();

    expect(logger.logFilePath).toBeNull();
    expect(stderr.write).toHaveBeenCalledWith(
      expect.stringContaining("Failed to initialize live console logging: disk full")
    );
    expect(fs.readdirSync(tempDirectory)).toEqual([]);
  });
});
