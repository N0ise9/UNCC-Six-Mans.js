import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

const rootDirectory = process.cwd();
const seaDirectory = path.resolve(rootDirectory, "release", "sea");
const bundledScriptPath = path.resolve(seaDirectory, "norm.bundle.cjs");
const seaConfigPath = path.resolve(seaDirectory, "sea-config.json");
const seaBlobPath = path.resolve(seaDirectory, "norm.blob");

fs.mkdirSync(seaDirectory, { recursive: true });

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
