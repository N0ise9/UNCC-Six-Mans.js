import path from "path";
import { getGuildConfigPath, getRuntimeEnvPath, resolveRuntimeRoot } from "../runtimePaths";

describe("runtimePaths", () => {
  const originalNormHome = process.env["NORM_HOME"];

  afterEach(() => {
    if (originalNormHome === undefined) {
      delete process.env["NORM_HOME"];
    } else {
      process.env["NORM_HOME"] = originalNormHome;
    }
  });

  it("prefers NORM_HOME when it is configured", () => {
    const runtimeRoot = resolveRuntimeRoot({
      cwd: "C:\\workspace\\norm",
      env: { NORM_HOME: "C:\\portable\\norm" },
      execPath: "C:\\portable\\norm\\Norm.exe",
      packaged: true,
    });

    expect(runtimeRoot).toBe(path.resolve("C:\\portable\\norm"));
  });

  it("uses the executable directory for packaged builds when NORM_HOME is absent", () => {
    const runtimeRoot = resolveRuntimeRoot({
      cwd: "C:\\workspace\\norm",
      env: {},
      execPath: "C:\\portable\\norm\\Norm.exe",
      packaged: true,
    });

    expect(runtimeRoot).toBe(path.resolve("C:\\portable\\norm"));
  });

  it("falls back to the current working directory in source mode", () => {
    const runtimeRoot = resolveRuntimeRoot({
      cwd: "C:\\workspace\\norm",
      env: {},
      packaged: false,
    });

    expect(runtimeRoot).toBe(path.resolve("C:\\workspace\\norm"));
  });

  it("builds env and guild config paths from the resolved runtime root", () => {
    process.env["NORM_HOME"] = "C:\\portable\\norm";

    expect(getRuntimeEnvPath()).toBe(path.resolve("C:\\portable\\norm", ".env"));
    expect(getGuildConfigPath()).toBe(path.resolve("C:\\portable\\norm", ".guild-instance-config.json"));
  });
});
