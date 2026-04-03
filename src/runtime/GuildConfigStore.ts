import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getEnvVariable } from "../utils";
import { EncryptedValue, GuildConfigUpsertInput, GuildInstanceConfig, GuildInstanceStoredConfig } from "./types";

interface GuildConfigFile {
  guilds: GuildInstanceStoredConfig[];
  version: 1;
}

type LegacyGuildConfigEntry = GuildInstanceStoredConfig & {
  voiceChannelId?: string;
};

export interface GuildConfigReadResult {
  enabled: boolean;
  error?: Error;
  guildId: string;
  config: GuildInstanceConfig | null;
}

const CONFIG_FILE_NAME = ".guild-instance-config.json";

type GuildRuntimeFieldUpdates = {
  leaderboardMessageIds?: string[] | null;
  openAiConversationId?: string | null;
  queueMessageId?: string | null;
};

export class GuildConfigStore {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? path.resolve(process.cwd(), CONFIG_FILE_NAME);
  }

  getConfigPath(): string {
    return this.filePath;
  }

  getGuildConfig(guildId: string): GuildInstanceConfig | null {
    const file = this.readFile();
    const guild = file.guilds.find((entry) => entry.guildId === guildId);
    return guild ? this.decryptGuildConfig(guild) : null;
  }

  getGuildConfigResult(guildId: string): GuildConfigReadResult | null {
    const file = this.readFile();
    const guild = file.guilds.find((entry) => entry.guildId === guildId);
    if (!guild) {
      return null;
    }

    return this.decryptGuildConfigResult(guild);
  }

  getGuildConfigs(): GuildInstanceConfig[] {
    return this.readFile().guilds.map((entry) => this.decryptGuildConfig(entry));
  }

  getGuildConfigResults(): GuildConfigReadResult[] {
    return this.readFile().guilds.map((entry) => this.decryptGuildConfigResult(entry));
  }

  disableGuild(guildId: string): GuildInstanceConfig | null {
    const file = this.readFile();
    const index = file.guilds.findIndex((entry) => entry.guildId === guildId);
    if (index < 0) return null;

    const updated: GuildInstanceStoredConfig = {
      ...file.guilds[index],
      enabled: false,
      updatedAt: new Date().toISOString(),
    };
    file.guilds[index] = updated;
    this.writeFile(file);
    return this.decryptGuildConfig(updated);
  }

  setGuildConfig(input: GuildConfigUpsertInput): GuildInstanceConfig {
    const file = this.readFile();
    const now = new Date().toISOString();
    const index = file.guilds.findIndex((entry) => entry.guildId === input.guildId);
    const previous = index >= 0 ? file.guilds[index] : null;

    const updated: GuildInstanceStoredConfig = {
      apiStatusChannelId: input.apiStatusChannelId,
      chatChannelId: input.chatChannelId,
      createdAt: previous?.createdAt ?? now,
      databaseUrl: this.encryptValue(input.databaseUrl),
      enabled: true,
      guildId: input.guildId,
      leaderboardChannelId: input.leaderboardChannelId,
      leaderboardMessageIds: previous?.leaderboardMessageIds,
      openAiConversationId: input.openAiConversationId ?? previous?.openAiConversationId,
      queueChannelId: input.queueChannelId,
      queueMessageId: previous?.queueMessageId,
      updatedAt: now,
    };

    if (index >= 0) {
      file.guilds[index] = updated;
    } else {
      file.guilds.push(updated);
    }

    this.writeFile(file);
    return this.decryptGuildConfig(updated);
  }

  updateGuildRuntimeFields(
    guildId: string,
    fields: GuildRuntimeFieldUpdates
  ): GuildInstanceConfig {
    const file = this.readFile();
    const index = file.guilds.findIndex((entry) => entry.guildId === guildId);
    if (index < 0) {
      throw new Error(`No stored guild config for ${guildId}.`);
    }

    const existing = file.guilds[index];

    const updated: GuildInstanceStoredConfig = {
      ...existing,
      leaderboardMessageIds: this.resolveOptionalArrayField(
        fields.leaderboardMessageIds,
        existing.leaderboardMessageIds
      ),
      openAiConversationId: this.resolveOptionalStringField(
        fields.openAiConversationId,
        existing.openAiConversationId
      ),
      queueMessageId: this.resolveOptionalStringField(fields.queueMessageId, existing.queueMessageId),
      updatedAt: new Date().toISOString(),
    };

    file.guilds[index] = updated;
    this.writeFile(file);
    return this.decryptGuildConfig(updated);
  }

  private decryptGuildConfig(config: GuildInstanceStoredConfig): GuildInstanceConfig {
    return {
      ...config,
      databaseUrl: this.decryptValue(config.databaseUrl),
    };
  }

  private decryptGuildConfigResult(config: GuildInstanceStoredConfig): GuildConfigReadResult {
    try {
      return {
        config: this.decryptGuildConfig(config),
        enabled: config.enabled,
        guildId: config.guildId,
      };
    } catch (error) {
      return {
        config: null,
        enabled: config.enabled,
        error: toError(error),
        guildId: config.guildId,
      };
    }
  }

  private resolveOptionalArrayField(
    nextValue: string[] | null | undefined,
    currentValue: string[] | undefined
  ): string[] | undefined {
    if (nextValue === undefined) {
      return currentValue;
    }

    return nextValue === null ? undefined : nextValue;
  }

  private resolveOptionalStringField(
    nextValue: string | null | undefined,
    currentValue: string | undefined
  ): string | undefined {
    if (nextValue === undefined) {
      return currentValue;
    }

    return nextValue === null ? undefined : nextValue;
  }

  private decryptValue(value: EncryptedValue): string {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      this.getEncryptionKey(),
      Buffer.from(value.iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(value.authTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, "base64")),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  }

  private encryptValue(plaintext: string): EncryptedValue {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.getEncryptionKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      authTag: authTag.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
    };
  }

  private getEncryptionKey(): Buffer {
    const keyMaterial = getEnvVariable("CONFIG_ENCRYPTION_KEY");
    return crypto.createHash("sha256").update(keyMaterial).digest();
  }

  private readFile(): GuildConfigFile {
    if (!fs.existsSync(this.filePath)) {
      return {
        guilds: [],
        version: 1,
      };
    }

    const content = fs.readFileSync(this.filePath, { encoding: "utf8" }).trim();
    if (!content) {
      return {
        guilds: [],
        version: 1,
      };
    }

    const parsed = JSON.parse(content) as { guilds?: LegacyGuildConfigEntry[] };
    const guilds = (parsed.guilds ?? []).map((entry) => normalizeLegacyGuildEntry(entry));
    const normalizedFile: GuildConfigFile = {
      guilds,
      version: 1,
    };

    if (hasLegacyGuildConfigEntries(parsed.guilds ?? [])) {
      this.writeFile(normalizedFile);
    }

    return normalizedFile;
  }

  private writeFile(file: GuildConfigFile): void {
    fs.writeFileSync(this.filePath, JSON.stringify(file, null, 2) + "\n", { encoding: "utf8" });
  }
}

export function maskSecret(value: string): string {
  if (value.length <= 8) return "********";
  return `${value.slice(0, 4)}***${value.slice(-4)}`;
}

function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(typeof error === "string" ? error : "Unknown guild config error");
}

function hasLegacyGuildConfigEntries(entries: LegacyGuildConfigEntry[]): boolean {
  return entries.some((entry) => "voiceChannelId" in entry);
}

function normalizeLegacyGuildEntry(entry: LegacyGuildConfigEntry): GuildInstanceStoredConfig {
  const normalized = { ...entry };
  delete normalized.voiceChannelId;
  return normalized;
}
