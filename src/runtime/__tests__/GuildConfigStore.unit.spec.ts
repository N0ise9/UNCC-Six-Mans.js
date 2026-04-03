import fs from "fs";
import os from "os";
import path from "path";
import { GuildConfigStore } from "../GuildConfigStore";

describe("GuildConfigStore", () => {
  const originalKey = process.env["CONFIG_ENCRYPTION_KEY"];

  beforeEach(() => {
    process.env["CONFIG_ENCRYPTION_KEY"] = "unit-test-config-key";
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env["CONFIG_ENCRYPTION_KEY"];
    } else {
      process.env["CONFIG_ENCRYPTION_KEY"] = originalKey;
    }
  });

  function createStore(): { filePath: string; store: GuildConfigStore } {
    const filePath = path.join(os.tmpdir(), `guild-config-${Date.now()}-${Math.random()}.json`);
    return {
      filePath,
      store: new GuildConfigStore(filePath),
    };
  }

  function cleanup(filePath: string): void {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  it("stores encrypted database urls while returning decrypted guild config values", () => {
    const { filePath, store } = createStore();

    try {
      store.setGuildConfig({
        chatChannelId: "chat-1",
        databaseUrl: "postgres://user:pass@localhost:5432/guild_one",
        guildId: "guild-1",
        leaderboardChannelId: "leaderboard-1",
        queueChannelId: "queue-1",
      });

      const raw = fs.readFileSync(filePath, "utf8");
      const config = store.getGuildConfig("guild-1");

      expect(raw).not.toContain("postgres://user:pass@localhost:5432/guild_one");
      expect(config).not.toBeNull();
      expect(config?.chatChannelId).toBe("chat-1");
      expect(config?.databaseUrl).toBe("postgres://user:pass@localhost:5432/guild_one");
      expect(config?.queueChannelId).toBe("queue-1");
      expect(config?.enabled).toBe(true);
    } finally {
      cleanup(filePath);
    }
  });

  it("updates runtime fields and preserves guild isolation across multiple configs", () => {
    const { filePath, store } = createStore();

    try {
      store.setGuildConfig({
        chatChannelId: "chat-1",
        databaseUrl: "postgres://guild-one",
        guildId: "guild-1",
        leaderboardChannelId: "leaderboard-1",
        queueChannelId: "queue-1",
      });
      store.setGuildConfig({
        chatChannelId: "chat-2",
        databaseUrl: "postgres://guild-two",
        guildId: "guild-2",
        leaderboardChannelId: "leaderboard-2",
        queueChannelId: "queue-2",
      });

      store.updateGuildRuntimeFields("guild-1", {
        leaderboardMessageIds: ["leaderboard-message-1", "leaderboard-message-2"],
        openAiConversationId: "conv-1",
        queueMessageId: "queue-message-1",
      });
      store.disableGuild("guild-2");

      const first = store.getGuildConfig("guild-1");
      const second = store.getGuildConfig("guild-2");

      expect(first?.leaderboardMessageIds).toEqual(["leaderboard-message-1", "leaderboard-message-2"]);
      expect(first?.openAiConversationId).toBe("conv-1");
      expect(first?.queueMessageId).toBe("queue-message-1");
      expect(first?.databaseUrl).toBe("postgres://guild-one");
      expect(second?.databaseUrl).toBe("postgres://guild-two");
      expect(second?.enabled).toBe(false);
    } finally {
      cleanup(filePath);
    }
  });

  it("treats omitted runtime fields as unchanged and null as cleared", () => {
    const { filePath, store } = createStore();

    try {
      store.setGuildConfig({
        chatChannelId: "chat-1",
        databaseUrl: "postgres://guild-one",
        guildId: "guild-1",
        leaderboardChannelId: "leaderboard-1",
        openAiConversationId: "seed-conversation",
        queueChannelId: "queue-1",
      });

      store.updateGuildRuntimeFields("guild-1", {
        leaderboardMessageIds: ["leaderboard-message-1"],
        queueMessageId: "queue-message-1",
      });
      store.updateGuildRuntimeFields("guild-1", {
        leaderboardMessageIds: null,
        openAiConversationId: null,
      });

      const config = store.getGuildConfig("guild-1");

      expect(config?.leaderboardMessageIds).toBeUndefined();
      expect(config?.openAiConversationId).toBeUndefined();
      expect(config?.queueMessageId).toBe("queue-message-1");
    } finally {
      cleanup(filePath);
    }
  });

  it("returns a per-guild read error instead of crashing startup when a config cannot be decrypted", () => {
    const { filePath, store } = createStore();

    try {
      store.setGuildConfig({
        chatChannelId: "chat-1",
        databaseUrl: "postgres://guild-one",
        guildId: "guild-1",
        leaderboardChannelId: "leaderboard-1",
        queueChannelId: "queue-1",
      });

      process.env["CONFIG_ENCRYPTION_KEY"] = "different-unit-test-key";

      const configResult = store.getGuildConfigResult("guild-1");
      const allResults = store.getGuildConfigResults();

      expect(configResult).not.toBeNull();
      expect(configResult?.config).toBeNull();
      expect(configResult?.error).toBeInstanceOf(Error);
      expect(allResults).toHaveLength(1);
      expect(allResults[0]?.guildId).toBe("guild-1");
      expect(allResults[0]?.config).toBeNull();
      expect(allResults[0]?.error).toBeInstanceOf(Error);
    } finally {
      cleanup(filePath);
    }
  });

  it("reads legacy guild configs without chatChannelId and rewrites away old voiceChannelId", () => {
    const { filePath, store } = createStore();

    try {
      store.setGuildConfig({
        chatChannelId: "chat-1",
        databaseUrl: "postgres://guild-one",
        guildId: "guild-1",
        leaderboardChannelId: "leaderboard-1",
        queueChannelId: "queue-1",
      });

      const rawConfig = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
        guilds: Array<Record<string, unknown>>;
      };
      delete rawConfig.guilds[0]?.["chatChannelId"];
      rawConfig.guilds[0]!["voiceChannelId"] = "voice-legacy";
      fs.writeFileSync(
        filePath,
        JSON.stringify(rawConfig, null, 2),
        "utf8"
      );

      const config = store.getGuildConfig("guild-1");
      const raw = fs.readFileSync(filePath, "utf8");

      expect(config?.databaseUrl).toBe("postgres://guild-one");
      expect(config?.chatChannelId).toBeUndefined();
      expect(raw).not.toContain("voiceChannelId");
      expect(raw).toContain("\"queueChannelId\": \"queue-1\"");
    } finally {
      cleanup(filePath);
    }
  });
});
