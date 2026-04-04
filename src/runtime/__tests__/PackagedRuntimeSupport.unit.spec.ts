import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ensurePackagedRuntimeSupportFiles } from "../PackagedRuntimeSupport";

function toArrayBuffer(content: string): ArrayBuffer {
  const buffer = Buffer.from(content, "utf8");
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

describe("PackagedRuntimeSupport", () => {
  let tempDirectory: string;

  beforeEach(() => {
    tempDirectory = fs.mkdtempSync(path.resolve(os.tmpdir(), "norm-packaged-runtime-"));
  });

  afterEach(() => {
    fs.rmSync(tempDirectory, { force: true, recursive: true });
  });

  it("does nothing outside packaged mode", () => {
    const result = ensurePackagedRuntimeSupportFiles({
      packaged: false,
      runtimeRoot: tempDirectory,
    });

    expect(result.createdFiles).toEqual([]);
    expect(fs.readdirSync(tempDirectory)).toEqual([]);
  });

  it("creates missing packaged companion files on first run", () => {
    const result = ensurePackagedRuntimeSupportFiles({
      assetKeys: () => ["runtime-files/.env.sample", "runtime-files/README.md"],
      assetReader: (key) => {
        switch (key) {
          case "runtime-files/.env.sample":
            return toArrayBuffer("token=\nopenai=\n");
          case "runtime-files/README.md":
            return toArrayBuffer("# Norm\n");
          default:
            throw new Error(`Unexpected asset key: ${key}`);
        }
      },
      packaged: true,
      platform: "win32",
      runtimeRoot: tempDirectory,
    });

    expect(result.createdFiles.map((file) => path.basename(file.path)).sort()).toEqual([
      ".env",
      ".env.sample",
      "Norm.cmd",
      "README.md",
    ]);
    expect(fs.readFileSync(path.resolve(tempDirectory, ".env"), "utf8")).toBe("token=\nopenai=\n");
    expect(fs.readFileSync(path.resolve(tempDirectory, ".env.sample"), "utf8")).toBe("token=\nopenai=\n");
    expect(fs.readFileSync(path.resolve(tempDirectory, "README.md"), "utf8")).toBe("# Norm\n");
    expect(fs.readFileSync(path.resolve(tempDirectory, "Norm.cmd"), "utf8")).toContain('".\\Norm.exe" %*');
  });

  it("does not overwrite existing runtime files", () => {
    fs.writeFileSync(path.resolve(tempDirectory, ".env"), "token=custom\n", "utf8");
    fs.writeFileSync(path.resolve(tempDirectory, "README.md"), "custom readme\n", "utf8");

    const result = ensurePackagedRuntimeSupportFiles({
      assetKeys: () => ["runtime-files/.env.sample", "runtime-files/README.md"],
      assetReader: (key) => {
        switch (key) {
          case "runtime-files/.env.sample":
            return toArrayBuffer("token=\nopenai=\n");
          case "runtime-files/README.md":
            return toArrayBuffer("# Norm\n");
          default:
            throw new Error(`Unexpected asset key: ${key}`);
        }
      },
      packaged: true,
      platform: "win32",
      runtimeRoot: tempDirectory,
    });

    expect(fs.readFileSync(path.resolve(tempDirectory, ".env"), "utf8")).toBe("token=custom\n");
    expect(fs.readFileSync(path.resolve(tempDirectory, "README.md"), "utf8")).toBe("custom readme\n");
    expect(result.createdFiles.map((file) => path.basename(file.path)).sort()).toEqual([".env.sample", "Norm.cmd"]);
  });
});
