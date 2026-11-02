import path from "path";
import {
  getConsoleLogArchiveRoot,
  getConsoleLogFilename,
  getConsoleLogPath,
  getGuildConfigPath,
  getPackagedExecutableDirectory,
  getPrismaStudioAssetsRoot,
  getPrismaStudioCliPath,
  getPrismaStudioConfigPath,
  getPrismaStudioNodePath,
  getPrismaStudioWorkspaceRoot,
  getRuntimeEnvPath,
  isConsoleLogFilename,
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

  it("builds console log paths beside the packaged executable", () => {
    process.env["NORM_HOME"] = sourceRoot;
    const now = new Date(2026, 3, 7, 12, 34, 56);

    expect(getPackagedExecutableDirectory({ execPath: packagedExecPath })).toBe(path.resolve(portableRoot));
    expect(getConsoleLogFilename(now)).toBe("console_log-2026-04-07_12-34-56.txt");
    expect(getConsoleLogArchiveRoot({ execPath: packagedExecPath })).toBe(path.resolve(portableRoot, "logs"));
    expect(getConsoleLogPath({ execPath: packagedExecPath, now })).toBe(
      path.resolve(portableRoot, "console_log-2026-04-07_12-34-56.txt")
    );
  });

  it("matches only bot-owned console log filenames", () => {
    expect(isConsoleLogFilename("console_log-2026-04-07_12-34-56.txt")).toBe(true);
    expect(isConsoleLogFilename("console_log-2026-04-07_12-34-56-1.txt")).toBe(true);
    expect(isConsoleLogFilename("console_log-manual.txt")).toBe(false);
    expect(isConsoleLogFilename("notes.txt")).toBe(false);
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
