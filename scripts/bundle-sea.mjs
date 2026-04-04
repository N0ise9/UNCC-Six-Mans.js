import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import zlib from "node:zlib";
import { build } from "esbuild";

const rootDirectory = process.cwd();
const seaDirectory = path.resolve(rootDirectory, "release", "sea");
const seaAssetsDirectory = path.resolve(seaDirectory, "assets");
const prismaStudioAssetDirectory = path.resolve(seaAssetsDirectory, "prisma-studio");
const runtimeFileAssetDirectory = path.resolve(seaAssetsDirectory, "runtime-files");
const bundledScriptPath = path.resolve(seaDirectory, "norm.bundle.cjs");
const seaConfigPath = path.resolve(seaDirectory, "sea-config.json");
const seaBlobPath = path.resolve(seaDirectory, "norm.blob");

fs.mkdirSync(seaDirectory, { recursive: true });
fs.rmSync(seaAssetsDirectory, { force: true, recursive: true });
stageRuntimeFiles();
stagePrismaStudioAssets();

await build({
  banner: {
    js: 'const { createRequire } = require("node:module"); require = createRequire(__filename);',
  },
  bundle: true,
  entryPoints: [path.resolve(rootDirectory, "src", "index.ts")],
  format: "cjs",
  legalComments: "none",
  outfile: bundledScriptPath,
  platform: "node",
  target: "node24.14",
});

fs.writeFileSync(
  seaConfigPath,
  JSON.stringify(
    {
      assets: buildSeaAssetMap(seaAssetsDirectory),
      disableExperimentalSEAWarning: true,
      main: bundledScriptPath,
      output: seaBlobPath,
      useCodeCache: false,
    },
    null,
    2
  ) + "\n",
  "utf8"
);

console.info(`SEA bundle created at ${bundledScriptPath}.`);
console.info(`SEA config written to ${seaConfigPath}.`);

const seaBuildResult = spawnSync(process.execPath, ["--experimental-sea-config", seaConfigPath], {
  stdio: "inherit",
});

if (seaBuildResult.status !== 0) {
  throw new Error(`Node SEA blob generation failed with exit code ${seaBuildResult.status ?? "unknown"}.`);
}

console.info(`SEA blob created at ${seaBlobPath}.`);

function stageRuntimeFiles() {
  fs.mkdirSync(runtimeFileAssetDirectory, { recursive: true });

  for (const fileName of [".env.sample", "README.md"]) {
    const sourcePath = path.resolve(rootDirectory, fileName);
    if (fs.existsSync(sourcePath)) {
      fs.copyFileSync(sourcePath, path.resolve(runtimeFileAssetDirectory, fileName));
    }
  }
}

function stagePrismaStudioAssets() {
  const stagedNodeRuntimePath = path.resolve(prismaStudioAssetDirectory, "node.exe.gz");
  const stagedToolsRoot = path.resolve(prismaStudioAssetDirectory, "tools");
  const stagedNodeModulesRoot = path.resolve(stagedToolsRoot, "node_modules");
  const stagedWorkspaceRoot = path.resolve(prismaStudioAssetDirectory, "workspace");
  const stagedSchemaDirectory = path.resolve(stagedWorkspaceRoot, "prisma");

  fs.mkdirSync(stagedNodeModulesRoot, { recursive: true });
  fs.mkdirSync(stagedSchemaDirectory, { recursive: true });
  fs.writeFileSync(stagedNodeRuntimePath, zlib.gzipSync(fs.readFileSync(process.execPath)));

  for (const directoryName of ["prisma", "@prisma", "postgres", "mysql2"]) {
    const sourcePath = path.resolve(rootDirectory, "node_modules", directoryName);
    const targetPath = path.resolve(stagedNodeModulesRoot, directoryName);
    if (fs.existsSync(sourcePath)) {
      fs.cpSync(sourcePath, targetPath, { recursive: true });
    }
  }

  const prismaStudioConfigSourcePath = path.resolve(rootDirectory, "prisma.studio.config.ts");
  if (fs.existsSync(prismaStudioConfigSourcePath)) {
    fs.copyFileSync(prismaStudioConfigSourcePath, path.resolve(stagedWorkspaceRoot, "prisma.studio.config.ts"));
  }

  const schemaSourcePath = path.resolve(rootDirectory, "prisma", "schema.prisma");
  if (fs.existsSync(schemaSourcePath)) {
    fs.copyFileSync(schemaSourcePath, path.resolve(stagedSchemaDirectory, "schema.prisma"));
  }
}

function buildSeaAssetMap(directory) {
  const assets = {};

  for (const filePath of walkFiles(directory)) {
    const relativePath = path.relative(directory, filePath).split(path.sep).join("/");
    assets[relativePath] = filePath;
  }

  return assets;
}

function walkFiles(directory) {
  const files = [];

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.resolve(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...walkFiles(entryPath));
      continue;
    }

    if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}
