import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const rootDirectory = process.cwd();
const releaseDirectory = path.resolve(rootDirectory, "release");
const seaDirectory = path.resolve(releaseDirectory, "sea");
const packageDirectory = path.resolve(releaseDirectory, "windows-portable");
const seaConfigPath = path.resolve(seaDirectory, "sea-config.json");
const bundledBlobPath = path.resolve(seaDirectory, "norm.blob");
const executablePath = path.resolve(packageDirectory, "Norm.exe");
const launcherPath = path.resolve(packageDirectory, "Norm.cmd");
const prismaStudioToolsDirectory = path.resolve(packageDirectory, "studio-tools");
const prismaStudioWorkspaceDirectory = path.resolve(packageDirectory, "studio-workspace");
const sentinelFuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

if (process.platform !== "win32") {
  throw new Error("Windows SEA packaging must be run on Windows.");
}

if (!fs.existsSync(seaConfigPath) || !fs.existsSync(bundledBlobPath)) {
  throw new Error("SEA bundle output is missing. Run `npm run bundle:sea` first.");
}

fs.rmSync(packageDirectory, { force: true, recursive: true });
fs.mkdirSync(packageDirectory, { recursive: true });
fs.mkdirSync(prismaStudioToolsDirectory, { recursive: true });
fs.mkdirSync(path.join(prismaStudioToolsDirectory, "node_modules"), { recursive: true });
fs.mkdirSync(path.join(prismaStudioWorkspaceDirectory, "prisma"), { recursive: true });
fs.mkdirSync(path.join(packageDirectory, "data", "generated-media", "images"), { recursive: true });
fs.mkdirSync(path.join(packageDirectory, "data", "generated-media", "videos"), { recursive: true });
fs.writeFileSync(path.join(packageDirectory, "data", "generated-media", "images", ".gitkeep"), "", "utf8");
fs.writeFileSync(path.join(packageDirectory, "data", "generated-media", "videos", ".gitkeep"), "", "utf8");

fs.copyFileSync(process.execPath, executablePath);
fs.copyFileSync(process.execPath, path.join(prismaStudioToolsDirectory, "node.exe"));

for (const fileName of [".env.sample", "README.md"]) {
  const sourcePath = path.resolve(rootDirectory, fileName);
  if (fs.existsSync(sourcePath)) {
    fs.copyFileSync(sourcePath, path.resolve(packageDirectory, fileName));
  }
}

for (const directoryName of ["prisma", "@prisma", "postgres", "mysql2"]) {
  const sourcePath = path.resolve(rootDirectory, "node_modules", directoryName);
  const targetPath = path.resolve(prismaStudioToolsDirectory, "node_modules", directoryName);
  if (fs.existsSync(sourcePath)) {
    fs.cpSync(sourcePath, targetPath, { recursive: true });
  }
}

for (const fileName of ["prisma.studio.config.ts"]) {
  const sourcePath = path.resolve(rootDirectory, fileName);
  if (fs.existsSync(sourcePath)) {
    fs.copyFileSync(sourcePath, path.resolve(prismaStudioWorkspaceDirectory, fileName));
  }
}

const schemaSourcePath = path.resolve(rootDirectory, "prisma", "schema.prisma");
if (fs.existsSync(schemaSourcePath)) {
  fs.copyFileSync(schemaSourcePath, path.resolve(prismaStudioWorkspaceDirectory, "prisma", "schema.prisma"));
}

fs.writeFileSync(
  launcherPath,
  [
    "@echo off",
    "setlocal",
    'cd /d "%~dp0"',
    'echo Starting Norm...',
    '".\\Norm.exe" %*',
    "set EXIT_CODE=%ERRORLEVEL%",
    "echo.",
    'echo Norm exited with code %EXIT_CODE%.',
    "pause",
    "exit /b %EXIT_CODE%",
    "",
  ].join("\r\n"),
  "utf8"
);

const postjectCliPath = require.resolve("postject/dist/cli.js");
const injectResult = spawnSync(
  process.execPath,
  [
    postjectCliPath,
    executablePath,
    "NODE_SEA_BLOB",
    bundledBlobPath,
    "--sentinel-fuse",
    sentinelFuse,
  ],
  {
    stdio: "inherit",
  }
);

if (injectResult.status !== 0) {
  throw new Error(`postject failed with exit code ${injectResult.status ?? "unknown"}.`);
}

console.info(`Windows portable package created at ${packageDirectory}.`);
