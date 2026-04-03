import path from "path";
import dotenv from "dotenv";
import { isSea } from "node:sea";

const DEFAULT_CONFIG_FILENAME = ".guild-instance-config.json";
const PRISMA_STUDIO_TOOLS_DIRECTORY = "studio-tools";
const PRISMA_STUDIO_WORKSPACE_DIRECTORY = "studio-workspace";
const PRISMA_STUDIO_CONFIG_FILENAME = "prisma.studio.config.ts";

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

export function isPackagedRuntime(options?: { packaged?: boolean }): boolean {
  return options?.packaged ?? isSea();
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

export function getPrismaStudioToolsRoot(options?: { packaged?: boolean }): string {
  if (isPackagedRuntime(options)) {
    return resolveRuntimePath(PRISMA_STUDIO_TOOLS_DIRECTORY);
  }

  return resolveRuntimeRoot();
}

export function getPrismaStudioWorkspaceRoot(options?: { packaged?: boolean }): string {
  if (isPackagedRuntime(options)) {
    return resolveRuntimePath(PRISMA_STUDIO_WORKSPACE_DIRECTORY);
  }

  return resolveRuntimeRoot();
}

export function getPrismaStudioNodePath(options?: { packaged?: boolean }): string {
  if (isPackagedRuntime(options)) {
    return path.resolve(getPrismaStudioToolsRoot(options), "node.exe");
  }

  return process.execPath;
}

export function getPrismaStudioCliPath(options?: { packaged?: boolean }): string {
  return path.resolve(getPrismaStudioToolsRoot(options), "node_modules", "prisma", "build", "index.js");
}

export function getPrismaStudioConfigPath(options?: { packaged?: boolean }): string {
  return path.resolve(getPrismaStudioWorkspaceRoot(options), PRISMA_STUDIO_CONFIG_FILENAME);
}

export function loadRuntimeEnv(): dotenv.DotenvConfigOutput {
  return dotenv.config({ path: getRuntimeEnvPath() });
}
