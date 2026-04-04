import path from "path";
import {
  getGuildConfigPath,
  getPrismaStudioAssetsRoot,
  getPrismaStudioCliPath,
  getPrismaStudioConfigPath,
  getPrismaStudioNodePath,
  getPrismaStudioWorkspaceRoot,
  getRuntimeEnvPath,
  resolveRuntimeRoot,
} from "../runtimePaths";
import { APP_VERSION } from "../appMetadata";

describe("runtimePaths", () => {
  const originalNormHome = process.env["NORM_HOME"];
  const packagedExecPath =
    process.platform === "win32" ? "C:\\portable\\norm\\Norm.exe" : "/opt/norm/Norm";
  const portableRoot =
    process.platform === "win32" ? "C:\\portable\\norm" : "/opt/norm";
  const sourceRoot =
    process.platform === "win32" ? "C:\\workspace\\norm" : "/workspace/norm";

  afterEach(() => {
    if (originalNormHome === undefined) {
      delete process.env["NORM_HOME"];
    } else {
      process.env["NORM_HOME"] = originalNormHome;
    }
  });

  it("prefers NORM_HOME when it is configured", () => {
    const runtimeRoot = resolveRuntimeRoot({
      cwd: sourceRoot,
      env: { NORM_HOME: portableRoot },
      execPath: packagedExecPath,
      packaged: true,
    });

    expect(runtimeRoot).toBe(path.resolve(portableRoot));
  });

  it("uses the executable directory for packaged builds when NORM_HOME is absent", () => {
    const runtimeRoot = resolveRuntimeRoot({
      cwd: sourceRoot,
      env: {},
      execPath: packagedExecPath,
      packaged: true,
    });

    expect(runtimeRoot).toBe(path.resolve(path.dirname(packagedExecPath)));
  });

  it("falls back to the current working directory in source mode", () => {
    const runtimeRoot = resolveRuntimeRoot({
      cwd: sourceRoot,
      env: {},
      packaged: false,
    });

    expect(runtimeRoot).toBe(path.resolve(sourceRoot));
  });

  it("builds env and guild config paths from the resolved runtime root", () => {
    process.env["NORM_HOME"] = portableRoot;

    expect(getRuntimeEnvPath()).toBe(path.resolve(portableRoot, ".env"));
    expect(getGuildConfigPath()).toBe(path.resolve(portableRoot, ".guild-instance-config.json"));
  });

  it("builds packaged Prisma Studio paths under the internal extracted asset root", () => {
    process.env["NORM_HOME"] = portableRoot;

    expect(getPrismaStudioAssetsRoot({ packaged: true })).toBe(
      path.resolve(portableRoot, ".norm-internal", "sea-assets", APP_VERSION, "prisma-studio")
    );
    expect(getPrismaStudioNodePath({ packaged: true })).toBe(
      path.resolve(portableRoot, ".norm-internal", "sea-assets", APP_VERSION, "prisma-studio", "node.exe")
    );
    expect(getPrismaStudioCliPath({ packaged: true })).toBe(
      path.resolve(
        portableRoot,
        ".norm-internal",
        "sea-assets",
        APP_VERSION,
        "prisma-studio",
        "tools",
        "node_modules",
        "prisma",
        "build",
        "index.js"
      )
    );
    expect(getPrismaStudioWorkspaceRoot({ packaged: true })).toBe(
      path.resolve(portableRoot, ".norm-internal", "sea-assets", APP_VERSION, "prisma-studio", "workspace")
    );
    expect(getPrismaStudioConfigPath({ packaged: true })).toBe(
      path.resolve(
        portableRoot,
        ".norm-internal",
        "sea-assets",
        APP_VERSION,
        "prisma-studio",
        "tools",
        "prisma.studio.config.js"
      )
    );
  });
});
