import fs from "node:fs";
import path from "node:path";

const rootDirectory = process.cwd();
const targets = process.argv.slice(2);
const defaultTargets = ["build"];

for (const target of targets.length > 0 ? targets : defaultTargets) {
  const absoluteTargetPath = path.resolve(rootDirectory, target);
  fs.rmSync(absoluteTargetPath, { force: true, recursive: true });
}
