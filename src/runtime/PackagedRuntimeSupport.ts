import fs from "node:fs";
import path from "node:path";
import { getAsset, getAssetKeys } from "node:sea";
import { isPackagedRuntime, resolveRuntimeRoot } from "./runtimePaths";

const RUNTIME_FILE_ASSET_PREFIX = "runtime-files/";
const README_FILENAME = "README.md";
const SAMPLE_ENV_FILENAME = ".env.sample";
const RUNTIME_ENV_FILENAME = ".env";
const WINDOWS_LAUNCHER_FILENAME = "Norm.cmd";

type PackagedRuntimeSupportOptions = {
  assetKeys?: () => string[];
  assetReader?: (key: string) => ArrayBuffer;
  packaged?: boolean;
  platform?: NodeJS.Platform;
  runtimeRoot?: string;
};

type CreatedRuntimeFile = {
  path: string;
  reason: "missing";
};

export type PackagedRuntimeSupportResult = {
  createdFiles: CreatedRuntimeFile[];
  runtimeRoot: string;
};

export function ensurePackagedRuntimeSupportFiles(
  options: PackagedRuntimeSupportOptions = {}
): PackagedRuntimeSupportResult {
  const packaged = isPackagedRuntime({ packaged: options.packaged });
  const runtimeRoot = options.runtimeRoot ?? resolveRuntimeRoot({ packaged });

  if (!packaged) {
    return {
      createdFiles: [],
      runtimeRoot,
    };
  }

  fs.mkdirSync(runtimeRoot, { recursive: true });

  const createdFiles: CreatedRuntimeFile[] = [];
  const assetKeys = new Set((options.assetKeys ?? getAssetKeys)());
  const readAsset = options.assetReader ?? getAsset;
  const platform = options.platform ?? process.platform;

  const sampleEnvContent = extractEmbeddedTextAsset(
    assetKeys,
    readAsset,
    `${RUNTIME_FILE_ASSET_PREFIX}${SAMPLE_ENV_FILENAME}`
  );
  const readmeContent = extractEmbeddedTextAsset(
    assetKeys,
    readAsset,
    `${RUNTIME_FILE_ASSET_PREFIX}${README_FILENAME}`
  );

  maybeWriteFile(path.resolve(runtimeRoot, SAMPLE_ENV_FILENAME), sampleEnvContent, createdFiles);
  maybeWriteFile(path.resolve(runtimeRoot, README_FILENAME), readmeContent, createdFiles);
  maybeWriteFile(path.resolve(runtimeRoot, RUNTIME_ENV_FILENAME), sampleEnvContent, createdFiles);

  if (platform === "win32") {
    maybeWriteFile(path.resolve(runtimeRoot, WINDOWS_LAUNCHER_FILENAME), buildWindowsLauncher(), createdFiles);
  }

  return {
    createdFiles,
    runtimeRoot,
  };
}

function extractEmbeddedTextAsset(
  assetKeys: ReadonlySet<string>,
  readAsset: (key: string) => ArrayBuffer,
  assetKey: string
): string | null {
  if (!assetKeys.has(assetKey)) {
    return null;
  }

  return ensureTrailingNewline(Buffer.from(readAsset(assetKey)).toString("utf8"));
}

function maybeWriteFile(filePath: string, content: string | null, createdFiles: CreatedRuntimeFile[]): void {
  if (content === null || fs.existsSync(filePath)) {
    return;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  createdFiles.push({
    path: filePath,
    reason: "missing",
  });
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function buildWindowsLauncher(): string {
  return [
    "@echo off",
    "setlocal",
    "cd /d \"%~dp0\"",
    "echo Starting Norm...",
    "\".\\Norm.exe\" %*",
    "set EXIT_CODE=%ERRORLEVEL%",
    "echo.",
    "echo Norm exited with code %EXIT_CODE%.",
    "pause",
    "exit /b %EXIT_CODE%",
    "",
  ].join("\r\n");
}
