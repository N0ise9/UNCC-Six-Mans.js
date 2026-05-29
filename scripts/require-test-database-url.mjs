import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const runtimeRoot = process.cwd();
const envFilePath = path.resolve(runtimeRoot, ".env");
const testEnvFilePath = path.resolve(runtimeRoot, ".env.test.local");
const guildConfigPath = path.resolve(runtimeRoot, ".guild-instance-config.json");

export function resolveIntegrationTestEnvironment() {
  const parsedTestEnv = readDotEnvFile(testEnvFilePath);
  const parsedEnv = readDotEnvFile(envFilePath);
  const testDatabaseUrl = normalizeDatabaseUrl(process.env.TEST_DATABASE_URL ?? parsedTestEnv.TEST_DATABASE_URL);

  if (!testDatabaseUrl) {
    throw new Error("TEST_DATABASE_URL is required for integration tests. Set it in the shell or .env.test.local.");
  }

  const protectedDatabaseUrls = new Set();

  for (const value of [
    process.env.DATABASE_URL,
    parsedEnv.DATABASE_URL,
    ...decryptStoredGuildDatabaseUrls(guildConfigPath, process.env.CONFIG_ENCRYPTION_KEY ?? parsedEnv.CONFIG_ENCRYPTION_KEY),
  ]) {
    const normalized = normalizeDatabaseUrl(value);
    if (normalized) {
      protectedDatabaseUrls.add(normalized);
    }
  }

  if (protectedDatabaseUrls.has(testDatabaseUrl)) {
    throw new Error(
      [
        "TEST_DATABASE_URL points at the same database used by the bot runtime.",
        `Refusing to run integration tests against ${maskDatabaseUrl(testDatabaseUrl)}.`,
        "Use a dedicated disposable test database instead.",
      ].join(" ")
    );
  }

  return {
    source: process.env.TEST_DATABASE_URL ? "environment" : "dot-env-test-local",
    testDatabaseUrl,
  };
}

if (isDirectExecution()) {
  try {
    resolveIntegrationTestEnvironment();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function decryptStoredGuildDatabaseUrls(configPath, encryptionKey) {
  if (!encryptionKey || !fs.existsSync(configPath)) {
    return [];
  }

  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const guilds = Array.isArray(config.guilds) ? config.guilds : [];
    return guilds.flatMap((guild) => {
      const encryptedValue = guild?.databaseUrl;
      if (!encryptedValue?.authTag || !encryptedValue?.ciphertext || !encryptedValue?.iv) {
        return [];
      }

      try {
        const key = crypto.createHash("sha256").update(encryptionKey).digest();
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(encryptedValue.iv, "base64"));
        decipher.setAuthTag(Buffer.from(encryptedValue.authTag, "base64"));
        return [
          Buffer.concat([
            decipher.update(Buffer.from(encryptedValue.ciphertext, "base64")),
            decipher.final(),
          ]).toString("utf8"),
        ];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function maskDatabaseUrl(value) {
  try {
    const url = new URL(value);
    const username = url.username ? `${decodeURIComponent(url.username)}:` : "";
    const password = url.password ? "***" : "";
    const auth = username || password ? `${username}${password}@` : "";
    return `${url.protocol}//${auth}${url.host}${url.pathname}`;
  } catch {
    return value;
  }
}

function normalizeDatabaseUrl(value) {
  if (!value) {
    return null;
  }

  const trimmed = value.trim().replace(/^"(.*)"$/, "$1");
  return trimmed.length > 0 ? trimmed : null;
}

function readDotEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  return dotenv.parse(fs.readFileSync(filePath, "utf8"));
}

function isDirectExecution() {
  return process.argv[1] ? path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)) : false;
}
