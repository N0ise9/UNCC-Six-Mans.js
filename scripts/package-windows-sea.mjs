import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { rcedit } from "rcedit";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json");
const rootDirectory = process.cwd();
const releaseDirectory = path.resolve(rootDirectory, "release");
const seaDirectory = path.resolve(releaseDirectory, "sea");
const packageDirectory = path.resolve(releaseDirectory, "windows-portable");
const seaConfigPath = path.resolve(seaDirectory, "sea-config.json");
const bundledBlobPath = path.resolve(seaDirectory, "norm.blob");
const executablePath = path.resolve(packageDirectory, "Norm.exe");
const iconPath = path.resolve(rootDirectory, "media", "norm_icon.ico");
const legacyLauncherPath = path.resolve(packageDirectory, "Norm.cmd");
const sentinelFuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
const requiredIconSizes = [16, 24, 32, 48, 64, 128, 256];

function getWindowsVersion(version) {
  const parts = String(version)
    .split(/[.-]/u)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isInteger(part) && part >= 0)
    .slice(0, 4);

  while (parts.length < 4) {
    parts.push(0);
  }

  return parts.join(".");
}

function getIconSizes(filePath) {
  const bytes = fs.readFileSync(filePath);

  if (bytes.length < 6 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) {
    throw new Error(`Windows executable icon is not a valid ICO file at ${filePath}.`);
  }

  const count = bytes.readUInt16LE(4);
  const sizes = [];

  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 16;

    if (offset + 16 > bytes.length) {
      throw new Error(`Windows executable icon has a truncated directory at ${filePath}.`);
    }

    sizes.push(bytes[offset] === 0 ? 256 : bytes[offset]);
  }

  return sizes;
}

if (process.platform !== "win32") {
  throw new Error("Windows SEA packaging must be run on Windows.");
}

if (!fs.existsSync(seaConfigPath) || !fs.existsSync(bundledBlobPath)) {
  throw new Error("SEA bundle output is missing. Run `npm run bundle:sea` first.");
}

if (!fs.existsSync(iconPath)) {
  throw new Error(`Windows executable icon is missing at ${iconPath}.`);
}

const missingIconSizes = requiredIconSizes.filter((size) => !getIconSizes(iconPath).includes(size));
if (missingIconSizes.length > 0) {
  throw new Error(`Windows executable icon is missing required sizes: ${missingIconSizes.join(", ")}.`);
}

fs.mkdirSync(packageDirectory, { recursive: true });

for (const filePath of [
  executablePath,
  legacyLauncherPath,
  path.resolve(packageDirectory, ".env.sample"),
  path.resolve(packageDirectory, "README.md"),
]) {
  fs.rmSync(filePath, { force: true });
}

fs.copyFileSync(process.execPath, executablePath);

const windowsVersion = getWindowsVersion(packageJson.version);
await rcedit(executablePath, {
  icon: iconPath,
  "file-version": windowsVersion,
  "product-version": windowsVersion,
  "requested-execution-level": "asInvoker",
  "version-string": {
    CompanyName: "Norm",
    FileDescription: "Norm",
    InternalName: "Norm",
    OriginalFilename: "Norm.exe",
    ProductName: "Norm",
  },
});
console.info(`Embedded Windows icon and Norm metadata into ${executablePath}.`);

for (const fileName of [".env.sample", "README.md"]) {
  const sourcePath = path.resolve(rootDirectory, fileName);
  if (fs.existsSync(sourcePath)) {
    fs.copyFileSync(sourcePath, path.resolve(packageDirectory, fileName));
  }
}

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
