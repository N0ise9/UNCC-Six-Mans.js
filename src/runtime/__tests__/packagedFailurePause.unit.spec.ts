import {
  PackagedFailurePauseOptions,
  pauseForPackagedFailure,
  shouldPauseForPackagedFailure,
} from "../packagedFailurePause";

function interactiveOptions(overrides: Partial<PackagedFailurePauseOptions> = {}): PackagedFailurePauseOptions {
  return {
    code: 1,
    env: {},
    input: { isTTY: true } as NodeJS.ReadStream,
    output: { isTTY: true, write: jest.fn(() => true) } as unknown as NodeJS.WriteStream,
    packaged: true,
    platform: "win32",
    ...overrides,
  };
}

describe("packagedFailurePause", () => {
  it("pauses for interactive packaged Windows failures", async () => {
    const waitForKeypress = jest.fn(async () => undefined);
    const output = { isTTY: true, write: jest.fn(() => true) } as unknown as NodeJS.WriteStream;

    await pauseForPackagedFailure(interactiveOptions({ output, waitForKeypress }));

    expect(waitForKeypress).toHaveBeenCalledTimes(1);
    expect(output.write).toHaveBeenCalledWith(expect.stringContaining("Press any key"));
  });

  it.each([
    ["successful exit", { code: 0 }],
    ["CI", { env: { CI: "true" } }],
    ["non-Windows", { platform: "linux" as NodeJS.Platform }],
    ["nonpackaged", { packaged: false }],
    ["noninteractive input", { input: { isTTY: false } as NodeJS.ReadStream }],
    ["noninteractive output", { output: { isTTY: false } as NodeJS.WriteStream }],
  ])("does not pause for %s", async (_label, overrides) => {
    const waitForKeypress = jest.fn(async () => undefined);

    await pauseForPackagedFailure(interactiveOptions({ ...overrides, waitForKeypress }));

    expect(waitForKeypress).not.toHaveBeenCalled();
    expect(shouldPauseForPackagedFailure(interactiveOptions(overrides))).toBe(false);
  });

  it("can be disabled explicitly with an environment variable", () => {
    expect(
      shouldPauseForPackagedFailure(interactiveOptions({ env: { NORM_DISABLE_FAILURE_PAUSE: "true" } }))
    ).toBe(false);
  });
});
