import {
  PRISMA_STUDIO_COOLDOWN_MS,
  PRISMA_STUDIO_FAILURE_WINDOW_MS,
  PRISMA_STUDIO_LOCKOUT_MS,
  PrismaStudioAccessGate,
} from "../PrismaStudioAccessGate";

describe("PrismaStudioAccessGate", () => {
  it("rejects access when the host password is not configured", () => {
    const gate = new PrismaStudioAccessGate({
      env: {},
      now: () => 0,
    });

    expect(gate.authorize("anything")).toEqual({
      allowed: false,
      message: "Prisma Studio is not configured on the host.",
      reason: "not_configured",
    });
  });

  it("rejects an incorrect password without leaking details", () => {
    const gate = new PrismaStudioAccessGate({
      env: { PRISMA_STUDIO_PASSWORD: "secret" },
      now: () => 0,
    });

    expect(gate.authorize("wrong")).toEqual({
      allowed: false,
      message: "Prisma Studio request was rejected.",
      reason: "rejected",
    });
  });

  it("locks access after three failed attempts inside the failure window", () => {
    let now = 0;
    const gate = new PrismaStudioAccessGate({
      env: { PRISMA_STUDIO_PASSWORD: "secret" },
      now: () => now,
    });

    const firstAttempt = gate.authorize("wrong-1");
    expect(firstAttempt.allowed).toBe(false);
    expect(firstAttempt).toMatchObject({ reason: "rejected" });
    now += 1_000;
    const secondAttempt = gate.authorize("wrong-2");
    expect(secondAttempt.allowed).toBe(false);
    expect(secondAttempt).toMatchObject({ reason: "rejected" });
    now += 1_000;
    expect(gate.authorize("wrong-3")).toEqual({
      allowed: false,
      message: "Prisma Studio access is temporarily locked. Please try again later.",
      reason: "locked",
    });

    now += PRISMA_STUDIO_LOCKOUT_MS - 1;
    const lockedAttempt = gate.authorize("secret");
    expect(lockedAttempt.allowed).toBe(false);
    expect(lockedAttempt).toMatchObject({ reason: "locked" });

    now += 1;
    expect(gate.authorize("secret")).toEqual({ allowed: true });
  });

  it("resets failed attempts after a successful password and applies the launch cooldown", () => {
    let now = 0;
    const gate = new PrismaStudioAccessGate({
      env: { PRISMA_STUDIO_PASSWORD: "secret" },
      now: () => now,
    });

    gate.authorize("wrong");
    gate.authorize("wrong");
    expect(gate.authorize("secret")).toEqual({ allowed: true });

    gate.recordSuccessfulLaunch();
    expect(gate.authorize("secret")).toEqual({
      allowed: false,
      message: "Prisma Studio was launched recently. Please wait a moment and try again.",
      reason: "cooldown",
    });

    now += PRISMA_STUDIO_COOLDOWN_MS;
    expect(gate.authorize("secret")).toEqual({ allowed: true });
  });

  it("forgets failed attempts that fall outside the failure window", () => {
    let now = 0;
    const gate = new PrismaStudioAccessGate({
      env: { PRISMA_STUDIO_PASSWORD: "secret" },
      now: () => now,
    });

    gate.authorize("wrong");
    now += PRISMA_STUDIO_FAILURE_WINDOW_MS + 1;
    gate.authorize("wrong");
    now += PRISMA_STUDIO_FAILURE_WINDOW_MS + 1;

    expect(gate.authorize("wrong")).toEqual({
      allowed: false,
      message: "Prisma Studio request was rejected.",
      reason: "rejected",
    });
  });
});
