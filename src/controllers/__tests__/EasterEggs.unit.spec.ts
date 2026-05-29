import { ChatInputCommandInteraction } from "discord.js";
import OpenAI from "openai";
import { GuildConfigStore } from "../../runtime/GuildConfigStore";
import { DiscordWorkScheduler } from "../../runtime/DiscordWorkScheduler";
import { GuildContext, GuildInstanceConfig } from "../../runtime/types";
import { assertSoraRuntimeSupport, DEFAULT_SORA_MODEL, handleEasterEggSlashInteraction } from "../EasterEggs";

type TestAttachment = {
  contentType?: string | null;
  size: number;
  url: string;
};

type TestConversationItem = {
  content: Array<Record<string, unknown>>;
  id: string;
  type: "message";
};

function createOpenAIDownloadError(url: string) {
  const error = new Error(`400 Error while downloading ${url}. Upstream status code: 404.`) as Error & {
    code: string;
    status: number;
  };
  error.code = "invalid_value";
  error.status = 400;
  return error;
}

async function withMutedConsoleError(task: () => Promise<void>): Promise<void> {
  const errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    await task();
  } finally {
    errorSpy.mockRestore();
  }
}

function createNormContext(
  response: { output_text?: string } = { output_text: "I read it." },
  conversationItems: TestConversationItem[] = []
) {
  const responsesCreate = jest.fn(async (_payload: Record<string, unknown>) => response);
  const conversationsRetrieve = jest.fn(async () => ({ id: "conversation-1" }));
  const conversationsItemsDelete = jest.fn(async () => ({ id: "conversation-1" }));
  const conversationsItemsList = jest.fn(() => conversationItems);
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
        items: {
          delete: conversationsItemsDelete,
          list: conversationsItemsList,
        },
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
    conversationsItemsDelete,
    conversationsItemsList,
    conversationsRetrieve,
    responsesCreate,
  };
}

function createNormInteraction(
  attachments: Partial<Record<string, TestAttachment | null>>,
  prompt = "summarize this"
) {
  const editReply = jest.fn(async () => undefined);
  const followUp = jest.fn(async () => undefined);
  const getAttachment = jest.fn((name: string) => attachments[name] ?? null);
  const getString = jest.fn((name: string) => (name === "prompt" ? prompt : null));

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
        size: 4096,
        url: "https://cdn.discordapp.com/attachments/1/2/queue.png?ex=1",
      },
      file2: {
        contentType: "application/pdf",
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
                type: "input_file",
              },
            ],
            role: "user",
          },
        ],
      })
    );
    const payload = responsesCreate.mock.calls[0]?.[0] as {
      input: Array<{ content: Array<Record<string, unknown>> }>;
    };
    expect(payload.input[0]?.content[2]).not.toHaveProperty("filename");
    expect(editReply).toHaveBeenCalledWith("I read it.");
  });

  it("removes stale Discord attachment items and retries text-only prompts", async () => {
    const staleUrl = "https://cdn.discordapp.com/ephemeral-attachments/1/2/chapter.pdf?ex=1&hm=gone";
    const { context, conversationsItemsDelete, conversationsItemsList, responsesCreate } = createNormContext(
      { output_text: "unused" },
      [
        {
          content: [
            { text: "user-1 Destroyer: old file", type: "input_text" },
            { file_url: staleUrl, type: "input_file" },
          ],
          id: "item-stale-file",
          type: "message",
        },
      ]
    );
    responsesCreate.mockRejectedValueOnce(createOpenAIDownloadError(staleUrl)).mockResolvedValueOnce({
      output_text: "Hello from clean history.",
    });
    const { editReply, followUp, interaction } = createNormInteraction({}, "hi");

    await withMutedConsoleError(async () => {
      await handleEasterEggSlashInteraction(context, interaction);
    });

    expect(responsesCreate).toHaveBeenCalledTimes(2);
    expect(conversationsItemsList).toHaveBeenCalledWith("conversation-1", { order: "asc" });
    expect(conversationsItemsDelete).toHaveBeenCalledWith("item-stale-file", { conversation_id: "conversation-1" });
    expect(editReply).toHaveBeenCalledWith("Hello from clean history.");
    expect(followUp).not.toHaveBeenCalled();
  });

  it("skips an inaccessible current attachment and retries with the remaining input", async () => {
    const badUrl = "https://cdn.discordapp.com/attachments/1/2/missing.pdf?ex=1&hm=gone";
    const goodUrl = "https://cdn.discordapp.com/attachments/1/3/rules.pdf?ex=1&hm=ok";
    const { context, responsesCreate } = createNormContext();
    responsesCreate.mockRejectedValueOnce(createOpenAIDownloadError(badUrl)).mockResolvedValueOnce({
      output_text: "I read the available file.",
    });
    const { editReply, followUp, interaction } = createNormInteraction({
      file1: {
        contentType: "application/pdf",
        size: 8192,
        url: badUrl,
      },
      file2: {
        contentType: "application/pdf",
        size: 4096,
        url: goodUrl,
      },
    });

    await withMutedConsoleError(async () => {
      await handleEasterEggSlashInteraction(context, interaction);
    });

    expect(responsesCreate).toHaveBeenCalledTimes(2);
    const retryPayload = responsesCreate.mock.calls[1]?.[0] as {
      input: Array<{ content: Array<Record<string, unknown>> }>;
    };
    expect(JSON.stringify(retryPayload)).not.toContain(badUrl);
    expect(retryPayload.input[0]?.content).toEqual([
      { text: "user-1 Destroyer: summarize this", type: "input_text" },
      { file_url: goodUrl, type: "input_file" },
    ]);
    expect(editReply).toHaveBeenCalledWith("I read the available file.");
    expect(followUp).not.toHaveBeenCalled();
  });

  it("skips all inaccessible current attachments and still sends the text prompt", async () => {
    const badImageUrl = "https://cdn.discordapp.com/attachments/1/2/missing.png?ex=1&hm=gone";
    const badFileUrl = "https://cdn.discordapp.com/attachments/1/3/missing.pdf?ex=1&hm=gone";
    const { context, responsesCreate } = createNormContext();
    responsesCreate
      .mockRejectedValueOnce(createOpenAIDownloadError(badImageUrl))
      .mockRejectedValueOnce(createOpenAIDownloadError(badFileUrl))
      .mockResolvedValueOnce({ output_text: "Text still works." });
    const { editReply, followUp, interaction } = createNormInteraction({
      file1: {
        contentType: "image/png",
        size: 4096,
        url: badImageUrl,
      },
      file2: {
        contentType: "application/pdf",
        size: 8192,
        url: badFileUrl,
      },
    });

    await withMutedConsoleError(async () => {
      await handleEasterEggSlashInteraction(context, interaction);
    });

    expect(responsesCreate).toHaveBeenCalledTimes(3);
    expect(responsesCreate.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({ input: "user-1 Destroyer: summarize this" })
    );
    expect(editReply).toHaveBeenCalledWith("Text still works.");
    expect(followUp).not.toHaveBeenCalled();
  });

  it("does not retry forever when stale conversation cleanup fails", async () => {
    const staleUrl = "https://cdn.discordapp.com/ephemeral-attachments/1/2/chapter.pdf?ex=1&hm=gone";
    const { context, conversationsItemsDelete, conversationsItemsList, responsesCreate } = createNormContext();
    conversationsItemsList.mockImplementation(() => {
      throw new Error("list failed");
    });
    responsesCreate.mockRejectedValueOnce(createOpenAIDownloadError(staleUrl));
    const { editReply, interaction } = createNormInteraction({}, "hi");

    await withMutedConsoleError(async () => {
      await handleEasterEggSlashInteraction(context, interaction);
    });

    expect(responsesCreate).toHaveBeenCalledTimes(1);
    expect(conversationsItemsDelete).not.toHaveBeenCalled();
    expect(editReply).toHaveBeenCalledWith("<@user-1> I couldn't reach OpenAI right now. Please try again in a bit.");
  });

  it("rejects known non-image file attachments over the OpenAI request limit", async () => {
    const { context, conversationsRetrieve, responsesCreate } = createNormContext();
    const { editReply, interaction } = createNormInteraction({
      file1: {
        contentType: "application/pdf",
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
