import { assertSoraRuntimeSupport } from "../EasterEggs";

describe("assertSoraRuntimeSupport", () => {
  const originalEnableSora = process.env["ENABLE_SORA"];
  const originalSoraModel = process.env["SORA_MODEL"];

  afterEach(() => {
    if (originalEnableSora === undefined) {
      delete process.env["ENABLE_SORA"];
    } else {
      process.env["ENABLE_SORA"] = originalEnableSora;
    }

    if (originalSoraModel === undefined) {
      delete process.env["SORA_MODEL"];
    } else {
      process.env["SORA_MODEL"] = originalSoraModel;
    }
  });

  it("does nothing when sora is disabled", () => {
    delete process.env["ENABLE_SORA"];
    delete process.env["SORA_MODEL"];

    expect(() => assertSoraRuntimeSupport({} as never)).not.toThrow();
  });

  it("fails fast when sora is enabled without a model", () => {
    process.env["ENABLE_SORA"] = "true";
    delete process.env["SORA_MODEL"];

    expect(() => assertSoraRuntimeSupport({} as never)).toThrow("SORA_MODEL");
  });

  it("fails fast when sora is enabled without a video-capable client", () => {
    process.env["ENABLE_SORA"] = "true";
    process.env["SORA_MODEL"] = "sora-test";

    expect(() => assertSoraRuntimeSupport({} as never)).toThrow("Videos API");
  });

  it("accepts an sdk client with the typed videos api when sora is enabled", () => {
    process.env["ENABLE_SORA"] = "true";
    process.env["SORA_MODEL"] = "sora-test";

    expect(() =>
      assertSoraRuntimeSupport({
        videos: {
          create: jest.fn(),
          downloadContent: jest.fn(),
          retrieve: jest.fn(),
        },
      } as never)
    ).not.toThrow();
  });
});
