import { assertSoraRuntimeSupport, DEFAULT_SORA_MODEL } from "../EasterEggs";

describe("assertSoraRuntimeSupport", () => {
  const originalEnableSora = process.env["ENABLE_SORA"];

  afterEach(() => {
    if (originalEnableSora === undefined) {
      delete process.env["ENABLE_SORA"];
    } else {
      process.env["ENABLE_SORA"] = originalEnableSora;
    }
  });

  it("does nothing when sora is disabled", () => {
    delete process.env["ENABLE_SORA"];

    expect(() => assertSoraRuntimeSupport({} as never)).not.toThrow();
  });

  it("uses the fixed Sora model", () => {
    expect(DEFAULT_SORA_MODEL).toBe("sora-2-2025-12-08");
  });

  it("fails fast when sora is enabled without a video-capable client", () => {
    process.env["ENABLE_SORA"] = "true";

    expect(() => assertSoraRuntimeSupport({} as never)).toThrow("Videos API");
  });

  it("accepts an sdk client with the typed videos api when sora is enabled", () => {
    process.env["ENABLE_SORA"] = "true";

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
