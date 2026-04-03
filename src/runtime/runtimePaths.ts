import path from "path";
import dotenv from "dotenv";
import { isSea } from "node:sea";

const DEFAULT_CONFIG_FILENAME = ".guild-instance-config.json";

export function resolveRuntimeRoot(options?: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  packaged?: boolean;
}): string {
  const env = options?.env ?? process.env;
  const configuredRoot = env["NORM_HOME"]?.trim();
  if (configuredRoot) {
    return path.resolve(configuredRoot);
  }

  const packaged = options?.packaged ?? isSea();
  if (packaged) {
    return path.dirname(options?.execPath ?? process.execPath);
  }

  return path.resolve(options?.cwd ?? process.cwd());
}

export function resolveRuntimePath(...segments: string[]): string {
  return path.resolve(resolveRuntimeRoot(), ...segments);
}

export function getRuntimeEnvPath(): string {
  return resolveRuntimePath(".env");
}

export function getGuildConfigPath(): string {
  return resolveRuntimePath(DEFAULT_CONFIG_FILENAME);
}

export function getGeneratedMediaRoot(): string {
  return resolveRuntimePath("data", "generated-media");
}

export function loadRuntimeEnv(): dotenv.DotenvConfigOutput {
  return dotenv.config({ path: getRuntimeEnvPath() });
}
