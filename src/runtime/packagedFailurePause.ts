import { isPackagedRuntime } from "./runtimePaths";

export type PackagedFailurePauseOptions = {
  code: number;
  env?: NodeJS.ProcessEnv;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  packaged?: boolean;
  platform?: NodeJS.Platform;
  waitForKeypress?: (input: NodeJS.ReadStream) => Promise<void>;
};

export function shouldPauseForPackagedFailure(options: PackagedFailurePauseOptions): boolean {
  if (options.code === 0) {
    return false;
  }

  if ((options.platform ?? process.platform) !== "win32") {
    return false;
  }

  if (!isPackagedRuntime({ packaged: options.packaged })) {
    return false;
  }

  const env = options.env ?? process.env;
  if (env["CI"] || env["NORM_DISABLE_FAILURE_PAUSE"]) {
    return false;
  }

  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  return input.isTTY === true && output.isTTY === true;
}

export async function pauseForPackagedFailure(options: PackagedFailurePauseOptions): Promise<void> {
  if (!shouldPauseForPackagedFailure(options)) {
    return;
  }

  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  output.write(`\nNorm exited with code ${options.code}. Press any key to close this window.`);
  await (options.waitForKeypress ?? waitForKeypress)(input);
  output.write("\n");
}

async function waitForKeypress(input: NodeJS.ReadStream): Promise<void> {
  await new Promise<void>((resolve) => {
    const restoreRawMode = enableRawMode(input);
    const cleanup = () => {
      input.off("data", cleanup);
      restoreRawMode();
      input.pause();
      resolve();
    };

    input.resume();
    input.once("data", cleanup);
  });
}

function enableRawMode(input: NodeJS.ReadStream): () => void {
  if (typeof input.setRawMode !== "function") {
    return () => undefined;
  }

  try {
    input.setRawMode(true);
    return () => {
      input.setRawMode(false);
    };
  } catch {
    return () => undefined;
  }
}
