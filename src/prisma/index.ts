import { PrismaPg } from "@prisma/adapter-pg";
import { getEnvVariable } from "../utils";
import { PrismaClient } from "../generated/prisma/client";

export * from "../generated/prisma/client";

export function resolveDatabaseUrl(databaseUrl?: string): string {
  return databaseUrl ?? getEnvVariable("DATABASE_URL");
}

export function createPrismaClient(databaseUrl?: string): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: resolveDatabaseUrl(databaseUrl),
  });

  return new PrismaClient({ adapter });
}
