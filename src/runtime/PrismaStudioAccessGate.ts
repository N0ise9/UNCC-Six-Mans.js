import crypto from "node:crypto";

export const PRISMA_STUDIO_COOLDOWN_MS = 60_000;
export const PRISMA_STUDIO_FAILURE_WINDOW_MS = 10 * 60 * 1000;
export const PRISMA_STUDIO_LOCKOUT_MS = 15 * 60 * 1000;
export const PRISMA_STUDIO_MAX_FAILURES = 3;

export type PrismaStudioAccessDecision =
  | {
      allowed: true;
    }
  | {
      allowed: false;
      message: string;
      reason: "cooldown" | "locked" | "not_configured" | "rejected";
    };

type PrismaStudioAccessGateOptions = {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
};

export class PrismaStudioAccessGate {
  private cooldownUntil = 0;
  private failedAttemptTimestamps: number[] = [];
  private lockoutUntil = 0;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => number;

  constructor(options: PrismaStudioAccessGateOptions = {}) {
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => Date.now());
  }

  authorize(password: string): PrismaStudioAccessDecision {
    const configuredPassword = this.env["PRISMA_STUDIO_PASSWORD"];
    if (!configuredPassword) {
      return {
        allowed: false,
        message: "Prisma Studio is not configured on the host.",
        reason: "not_configured",
      };
    }

    const now = this.now();
    this.pruneFailures(now);

    if (this.lockoutUntil > 0 && now < this.lockoutUntil) {
      return {
        allowed: false,
        message: "Prisma Studio access is temporarily locked. Please try again later.",
        reason: "locked",
      };
    }

    if (this.cooldownUntil > 0 && now < this.cooldownUntil) {
      return {
        allowed: false,
        message: "Prisma Studio was launched recently. Please wait a moment and try again.",
        reason: "cooldown",
      };
    }

    if (!timingSafePasswordEquals(configuredPassword, password)) {
      this.failedAttemptTimestamps.push(now);
      this.pruneFailures(now);

      if (this.failedAttemptTimestamps.length >= PRISMA_STUDIO_MAX_FAILURES) {
        this.failedAttemptTimestamps = [];
        this.lockoutUntil = now + PRISMA_STUDIO_LOCKOUT_MS;
        return {
          allowed: false,
          message: "Prisma Studio access is temporarily locked. Please try again later.",
          reason: "locked",
        };
      }

      return {
        allowed: false,
        message: "Prisma Studio request was rejected.",
        reason: "rejected",
      };
    }

    this.failedAttemptTimestamps = [];
    this.lockoutUntil = 0;
    return { allowed: true };
  }

  recordSuccessfulLaunch(): void {
    this.cooldownUntil = this.now() + PRISMA_STUDIO_COOLDOWN_MS;
  }

  private pruneFailures(now: number): void {
    this.failedAttemptTimestamps = this.failedAttemptTimestamps.filter(
      (timestamp) => now - timestamp <= PRISMA_STUDIO_FAILURE_WINDOW_MS
    );

    if (this.lockoutUntil > 0 && now >= this.lockoutUntil) {
      this.lockoutUntil = 0;
    }
  }
}

function timingSafePasswordEquals(expected: string, received: string): boolean {
  const expectedDigest = crypto.createHash("sha256").update(expected, "utf8").digest();
  const receivedDigest = crypto.createHash("sha256").update(received, "utf8").digest();
  return crypto.timingSafeEqual(expectedDigest, receivedDigest);
}
