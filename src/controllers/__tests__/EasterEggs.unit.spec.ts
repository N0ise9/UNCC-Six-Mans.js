import { ChatInputCommandInteraction } from "discord.js";
import OpenAI from "openai";
import { GuildConfigStore } from "../../runtime/GuildConfigStore";
import { DiscordWorkScheduler } from "../../runtime/DiscordWorkScheduler";
import { GuildContext, GuildInstanceConfig } from "../../runtime/types";
import { assertSoraRuntimeSupport, DEFAULT_SORA_MODEL, handleEasterEggSlashInteraction } from "../EasterEggs";

type TestAttachment = {
  contentType?: string | null;
  name: string;
  size: number;
  url: string;
};

function createNormContext(response: { output_text?: string } = { output_text: "I read it." }) {
  const responsesCreate = jest.fn(async () => response);
  const conversationsRetrieve = jest.fn(async () => ({ id: "conversation-1" }));
  const config = {
    guildId: "guild-1",
    openAiConversationId: "conversation-1",
  } as GuildInstanceConfig;

  const context = {
    config,
    configStore: {
      updateGuildRuntimeFields: jest.fn((_guildId: string, fields: Partial<GuildInstanceConfig>) => ({
        ...config,
        ...fields,
      })),
    } as unknown as GuildConfigStore,
    guildId: "guild-1",
    normProcessing: false,
    normQueue: [],
    openai: {
      conversations: {
        create: jest.fn(async () => ({ id: "conversation-2" })),
        retrieve: conversationsRetrieve,
      },
      responses: {
        create: responsesCreate,
      },
    } as unknown as OpenAI,
    scheduler: new DiscordWorkScheduler(1, 0),
  } as unknown as GuildContext;

  return {
    context,
    conversationsRetrieve,
    responsesCreate,
  };
}

function createNormInteraction(attachments: Partial<Record<string, TestAttachment | null>>) {
  const editReply = jest.fn(async () => undefined);
  const followUp = jest.fn(async () => undefined);
  const getAttachment = jest.fn((name: string) => attachments[name] ?? null);
  const getString = jest.fn((name: string) => (name === "prompt" ? "summarize this" : null));

  const interaction = {
    commandName: "norm",
    editReply,
    followUp,
    id: "interaction-1",
    options: {
      getAttachment,
      getString,
    },
    user: {
      id: "user-1",
      username: "Destroyer",
    },
  } as unknown as ChatInputCommandInteraction;

  return {
    editReply,
    followUp,
    getAttachment,
    getString,
    interaction,
  };
}

describe("handleEasterEggSlashInteraction", () => {
  it("sends mixed images and files to OpenAI as multimodal input", async () => {
    const { context, responsesCreate } = createNormContext();
    const { editReply, interaction } = createNormInteraction({
      file1: {
        contentType: "image/png",
        name: "queue.png",
        size: 4096,
        url: "https://cdn.discordapp.com/attachments/1/2/queue.png?ex=1",
      },
      file2: {
        contentType: "application/pdf",
        name: "rules.pdf",
        size: 8192,
        url: "https://cdn.discordapp.com/attachments/1/3/rules.pdf?ex=1",
      },
    });

    await handleEasterEggSlashInteraction(context, interaction);

    expect(responsesCreate).toHaveBeenCalledTimes(1);
    expect(responsesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        input: [
          {
            content: [
              { text: "user-1 Destroyer: summarize this", type: "input_text" },
              {
                detail: "auto",
                image_url: "https://cdn.discordapp.com/attachments/1/2/queue.png?ex=1",
                type: "input_image",
              },
              {
                file_url: "https://cdn.discordapp.com/attachments/1/3/rules.pdf?ex=1",
                filename: "rules.pdf",
                type: "input_file",
              },
            ],
            role: "user",
          },
        ],
      })
    );
    expect(editReply).toHaveBeenCalledWith("I read it.");
  });

  it("rejects known non-image file attachments over the OpenAI request limit", async () => {
    const { context, conversationsRetrieve, responsesCreate } = createNormContext();
    const { editReply, interaction } = createNormInteraction({
      file1: {
        contentType: "application/pdf",
        name: "huge.pdf",
        size: 50 * 1024 * 1024 + 1,
        url: "https://cdn.discordapp.com/attachments/1/2/huge.pdf?ex=1",
      },
    });

    await handleEasterEggSlashInteraction(context, interaction);

    expect(conversationsRetrieve).not.toHaveBeenCalled();
    expect(responsesCreate).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith(expect.stringContaining("50 MB total"));
  });
});

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
