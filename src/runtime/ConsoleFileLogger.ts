import fs from "node:fs";
import path from "node:path";
import {
  getConsoleLogArchiveRoot,
  getConsoleLogPath,
  getPackagedExecutableDirectory,
  isConsoleLogFilename,
  isPackagedRuntime,
} from "./runtimePaths";

type WriteCallback = (error?: Error | null) => void;

type WritableTarget = {
  write(chunk: string | Uint8Array, callback?: WriteCallback): boolean;
  write(chunk: string | Uint8Array, encoding?: BufferEncoding, callback?: WriteCallback): boolean;
};

type FileOps = Pick<typeof fs, "createWriteStream" | "existsSync" | "mkdirSync" | "readdirSync" | "renameSync">;

type ConsoleFileLoggerOptions = {
  execPath?: string;
  fileOps?: FileOps;
  now?: Date;
  packaged?: boolean;
  stderr?: WritableTarget;
  stdout?: WritableTarget;
};

export type ConsoleFileLogger = {
  dispose: () => Promise<void>;
  logFilePath: string | null;
};

export function startConsoleFileLogger(options: ConsoleFileLoggerOptions = {}): ConsoleFileLogger {
  if (!isPackagedRuntime({ packaged: options.packaged })) {
    return createNoopConsoleFileLogger();
  }

  const fileOps = options.fileOps ?? fs;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const originalStdoutWrite = stdout.write;
  const originalStderrWrite = stderr.write;

  try {
    archiveExistingConsoleLogs(options.execPath, fileOps);

    const logFilePath = getConsoleLogPath({
      execPath: options.execPath,
      now: options.now,
    });
    const stream = fileOps.createWriteStream(logFilePath, {
      encoding: "utf8",
      flags: "a",
    });
    let fileLoggingEnabled = true;

    const reportLoggerFailure = (message: string): void => {
      if (!fileLoggingEnabled) {
        return;
      }

      fileLoggingEnabled = false;
      originalStderrWrite.call(stderr, `${message}\n`);
    };

    stream.on("error", (error) => {
      reportLoggerFailure(
        `[ConsoleFileLogger] Failed to write live console log at ${logFilePath}: ${toErrorMessage(error)}`
      );
    });

    const restoreStdout = patchWritableTarget(
      stdout,
      originalStdoutWrite,
      stream,
      () => fileLoggingEnabled,
      reportLoggerFailure
    );
    const restoreStderr = patchWritableTarget(
      stderr,
      originalStderrWrite,
      stream,
      () => fileLoggingEnabled,
      reportLoggerFailure
    );

    return {
      dispose: async () => {
        restoreStderr();
        restoreStdout();

        if (stream.destroyed || stream.writableEnded) {
          return;
        }

        await new Promise<void>((resolve) => {
          stream.end(() => resolve());
        });
      },
      logFilePath,
    };
  } catch (error) {
    originalStderrWrite.call(
      stderr,
      `[ConsoleFileLogger] Failed to initialize live console logging: ${toErrorMessage(error)}\n`
    );
    return createNoopConsoleFileLogger();
  }
}

function createNoopConsoleFileLogger(): ConsoleFileLogger {
  return {
    dispose: async () => undefined,
    logFilePath: null,
  };
}

function archiveExistingConsoleLogs(execPath: string | undefined, fileOps: FileOps): void {
  const runtimeRoot = getPackagedExecutableDirectory({ execPath });
  const archiveRoot = getConsoleLogArchiveRoot({ execPath });
  const existingFiles = fileOps
    .readdirSync(runtimeRoot, { encoding: "utf8" })
    .filter((fileName) => isConsoleLogFilename(fileName));

  if (existingFiles.length === 0) {
    return;
  }

  fileOps.mkdirSync(archiveRoot, { recursive: true });
  for (const fileName of existingFiles) {
    const sourcePath = path.resolve(runtimeRoot, fileName);
    const destinationPath = resolveAvailablePath(path.resolve(archiveRoot, fileName), fileOps.existsSync);
    fileOps.renameSync(sourcePath, destinationPath);
  }
}

function resolveAvailablePath(filePath: string, existsSync: FileOps["existsSync"]): string {
  if (!existsSync(filePath)) {
    return filePath;
  }

  const parsed = path.parse(filePath);
  let suffix = 1;
  let candidatePath = path.resolve(parsed.dir, `${parsed.name}-${suffix}${parsed.ext}`);
  while (existsSync(candidatePath)) {
    suffix += 1;
    candidatePath = path.resolve(parsed.dir, `${parsed.name}-${suffix}${parsed.ext}`);
  }

  return candidatePath;
}

function patchWritableTarget(
  target: WritableTarget,
  originalWrite: WritableTarget["write"],
  stream: fs.WriteStream,
  isFileLoggingEnabled: () => boolean,
  reportLoggerFailure: (message: string) => void
): () => void {
  const invokeOriginalWrite = originalWrite as (...args: unknown[]) => boolean;
  const patchedWrite = (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | WriteCallback,
    callback?: WriteCallback
  ): boolean => {
    const didWriteToConsole = invokeOriginalWrite.call(target, chunk, encodingOrCallback, callback);

    if (isFileLoggingEnabled() && (typeof chunk === "string" || chunk instanceof Uint8Array)) {
      try {
        writeChunkToStream(
          stream,
          chunk,
          typeof encodingOrCallback === "string" ? (encodingOrCallback as BufferEncoding) : undefined
        );
      } catch (error) {
        reportLoggerFailure(`[ConsoleFileLogger] Failed while teeing console output: ${toErrorMessage(error)}`);
      }
    }

    return didWriteToConsole;
  };

  target.write = patchedWrite as WritableTarget["write"];
  return () => {
    target.write = originalWrite;
  };
}

function writeChunkToStream(
  stream: fs.WriteStream,
  chunk: string | Uint8Array,
  encoding?: BufferEncoding
): void {
  if (typeof chunk === "string") {
    if (encoding) {
      stream.write(chunk, encoding);
      return;
    }

    stream.write(chunk);
    return;
  }

  stream.write(chunk);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "an unknown error occurred";
}
