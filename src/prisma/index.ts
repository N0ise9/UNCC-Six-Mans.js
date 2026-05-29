import { PrismaPg } from "@prisma/adapter-pg";
import { getEnvVariable } from "../utils";
import { PrismaClient } from "../generated/prisma/client";

export * from "../generated/prisma/client";

export function resolveDatabaseUrl(envVariableName = "DATABASE_URL"): string {
  return getEnvVariable(envVariableName);
}

export function createPrismaClient(databaseUrl: string): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: databaseUrl,
  });

  return new PrismaClient({ adapter });
}

export function createPrismaClientFromEnv(envVariableName = "DATABASE_URL"): PrismaClient {
  return createPrismaClient(resolveDatabaseUrl(envVariableName));
}
