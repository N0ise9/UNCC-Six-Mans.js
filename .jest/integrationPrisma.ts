import { PrismaClient, createPrismaClient } from "../src/prisma";

export const DEFAULT_TEST_EVENT_ID = 1;
export const DEFAULT_TEST_EVENT_NAME = "Integration Test Event";

export function requireTestDatabaseUrl(): string {
  const databaseUrl = process.env.TEST_DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for integration tests.");
  }

  return databaseUrl;
}

export function createIntegrationTestPrismaClient(): PrismaClient {
  return createPrismaClient(requireTestDatabaseUrl());
}

export async function resetIntegrationDatabase(prisma?: PrismaClient | null): Promise<void> {
  if (!prisma) {
    return;
  }

  await prisma.leaderboard.deleteMany();
  await prisma.activeMatch.deleteMany();
  await prisma.queue.deleteMany();
  await prisma.ballChaser.deleteMany();
  await prisma.event.deleteMany();
}

export async function ensureDefaultIntegrationEvent(
  prisma: PrismaClient,
  eventId = DEFAULT_TEST_EVENT_ID,
  name = DEFAULT_TEST_EVENT_NAME
): Promise<void> {
  await prisma.event.create({
    data: {
      id: eventId,
      name,
    },
  });
}
