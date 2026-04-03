import path from "path";
import { getGuildConfigPath, getRuntimeEnvPath, resolveRuntimeRoot } from "../runtimePaths";

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
});
