/* eslint-disable max-len */
import { ChatInputCommandInteraction, Message, TextChannel } from "discord.js";
import OpenAI from "openai";
import * as fs from "fs";
import path from "path";
import { GuildContext } from "../runtime/types";
import { createScheduledCommandResponder } from "../runtime/createScheduledCommandResponder";

export const EASTER_EGG_SLASH_COMMANDS = {
  Norm: "norm",
  Sora: "sora",
} as const;

const EASTER_EGG_MESSAGE_PREFIX = {
  Norm: "!norm",
} as const;

const systemMessage =
  "Your name is Norm and you're a Discord bot. For all replies and any individual you address in your messages, prefix the Discord ID with '<@' and suffix with '>' so that it pings them in Discord. You generally keep your responses short unless you need to explain something in detail. You're exactly like the TARS robot from the Interstellar movie except a little more disgruntled and rude. Your maximum message length cannot exceed 2000 characters. You are not allowed to say @everyone or @here, no matter what, and if you need to tell people for whatever reason that you can't say them, add a space after the @ symbol so it doesn't actually ping.";

type OpenAIResponseOutput = {
  result?: string;
  type?: string;
};

type OpenAIResponsePayload = {
  output?: OpenAIResponseOutput[];
  output_text?: string;
  usage?: {
    input_tokens?: number;
  };
};

type SoraVideoCompletion = {
  error?: {
    message?: string;
  };
  id: string;
  progress?: number;
  status: "completed" | "failed" | "in_progress" | "queued";
};

type SoraVideoClient = {
  downloadContent: (id: string) => Promise<Response | null>;
  retrieve: (id: string) => Promise<SoraVideoCompletion>;
  create: (payload: { model: string; prompt: string; seconds: string }) => Promise<SoraVideoCompletion>;
};

const GENERATED_MEDIA_ROOT = path.resolve(process.cwd(), "data", "generated-media");

function isSoraEnabled(): boolean {
  return (process.env["ENABLE_SORA"] ?? "false").toLowerCase() === "true";
}

function getSoraModel(): string {
  const model = process.env["SORA_MODEL"]?.trim();
  if (!model) {
    throw new Error("ENABLE_SORA is true but SORA_MODEL is not configured.");
  }

  return model;
}

function getSoraVideoClient(openai: OpenAI): SoraVideoClient | null {
  const candidate = openai as OpenAI & { videos?: SoraVideoClient };
  if (candidate.videos) {
    return candidate.videos;
  }

  if (typeof openai.get !== "function" || typeof openai.post !== "function") {
    return null;
  }

  return {
    create: async (payload) =>
      await openai.post<SoraVideoCompletion>("/videos", {
        body: payload,
      }),
    downloadContent: async (id) =>
      await openai.get<Response>(`/videos/${id}/content`, {
        __binaryResponse: true,
        headers: {
          Accept: "application/binary",
        },
      }),
    retrieve: async (id) => await openai.get<SoraVideoCompletion>(`/videos/${id}`),
  };
}

function ensureDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true });
}

function sanitizeFileSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48) || "norm";
}

function buildGeneratedMediaPath(kind: "images" | "videos", baseName: string, extension: string): string {
  const directory = path.join(GENERATED_MEDIA_ROOT, kind);
  ensureDirectory(directory);
  return path.join(directory, `${sanitizeFileSegment(baseName)}-${Date.now()}.${extension}`);
}

export function assertSoraRuntimeSupport(openai: OpenAI): void {
  if (!isSoraEnabled()) {
    return;
  }

  getSoraModel();
  if (!getSoraVideoClient(openai)) {
    throw new Error("ENABLE_SORA is true, but this installed OpenAI SDK does not expose the Videos API.");
  }
}

function chunkMessage(text: string, max = 1999): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += max) {
    chunks.push(text.slice(i, i + max));
  }
  return chunks;
}

function sanitizeDiscordText(text: string): string {
  return text.replace(/@everyone/g, "@ everyone").replace(/@here/g, "@ here");
}

async function ensureConversation(context: GuildContext): Promise<string> {
  const existingConversationId = context.config.openAiConversationId;
  if (existingConversationId) {
    try {
      await context.openai.conversations.retrieve(existingConversationId);
      return existingConversationId;
    } catch {
      console.warn(`[${context.guildId}] Stored OpenAI conversation missing; creating a new one.`);
    }
  }

  const conversation = await context.openai.conversations.create({
    items: [
      {
        content: systemMessage,
        role: "system",
        type: "message",
      },
    ],
  });

  context.config = context.configStore.updateGuildRuntimeFields(context.guildId, {
    openAiConversationId: conversation.id,
  });

  return conversation.id;
}

async function enqueueNormTask(context: GuildContext, task: () => Promise<void>): Promise<void> {
  context.normQueue.push(task);
  if (context.normProcessing) return;

  context.normProcessing = true;
  try {
    while (context.normQueue.length > 0) {
      const next = context.normQueue.shift();
      if (!next) break;

      try {
        await next();
      } catch (error) {
        console.error(`[${context.guildId}] Error running queued Norm task:`, error);
      }
    }
  } finally {
    context.normProcessing = false;
  }
}

async function maybeRotateConversation(
  context: GuildContext,
  completion: OpenAIResponsePayload,
  notify: (content: string) => Promise<void>
): Promise<void> {
  const tokenLimit = Number(process.env["conversation_token_limit"] ?? 0);
  if (!tokenLimit || completion.usage?.input_tokens === undefined) return;

  const outputs = Array.isArray(completion.output) ? completion.output : [];
  const hasToolCalls = outputs.some(
    (output: OpenAIResponseOutput) => typeof output.type === "string" && output.type.endsWith("_call")
  );
  if (completion.usage.input_tokens < tokenLimit || hasToolCalls) {
    return;
  }

  const conversation = await context.openai.conversations.create({
    items: [{ content: systemMessage, role: "system", type: "message" }],
  });

  context.config = context.configStore.updateGuildRuntimeFields(context.guildId, {
    openAiConversationId: conversation.id,
  });

  await notify("I've wiped my memory to limit contextual input, in order to keep costs lower.");
}

async function sendChannelParts(context: GuildContext, channel: TextChannel, parts: string[]): Promise<void> {
  for (const part of parts) {
    await context.scheduler.enqueue(
      async () =>
        await channel.send({
          allowedMentions: { parse: [] },
          content: sanitizeDiscordText(part),
        }),
      {
        label: "chat-channel-send",
        priority: "normal",
      }
    );
  }
}

async function runNormPrompt(
  context: GuildContext,
  prompt: string,
  attachments: Array<{ contentType?: string | null; url: string }>,
  respond: {
    edit: (payload: string | { content?: string; files?: Array<{ attachment: string }> }) => Promise<void>;
    followUp: (payload: string) => Promise<void>;
  },
  actor: { id: string; username: string }
): Promise<void> {
  const conversationId = await ensureConversation(context);
  const imageUrls = attachments
    .filter((attachment) => attachment.contentType?.startsWith("image/"))
    .map((attachment) => attachment.url)
    .slice(0, 3);

  let completion: OpenAIResponsePayload;
  try {
    if (imageUrls.length > 0) {
      completion = (await context.openai.responses.create({
        conversation: conversationId,
        input: [
          {
            content: [
              { text: `${actor.id} ${actor.username}: ${prompt}`, type: "input_text" },
              ...imageUrls.map((url) => ({
                detail: "auto" as const,
                image_url: url,
                type: "input_image" as const,
              })),
            ],
            role: "user",
          },
        ],
        model: "gpt-5.4",
        parallel_tool_calls: true,
        stream: false,
        tool_choice: "auto",
        tools: [
          { type: "web_search" },
          {
            input_fidelity: "high",
            model: "gpt-image-1",
            moderation: "low",
            output_format: "png",
            type: "image_generation",
          },
        ],
      })) as OpenAIResponsePayload;
    } else {
      completion = (await context.openai.responses.create({
        conversation: conversationId,
        input: `${actor.id} ${actor.username}: ${prompt}`,
        model: "gpt-5.4",
        parallel_tool_calls: true,
        stream: false,
        tool_choice: "auto",
        tools: [
          { type: "web_search" },
          {
            input_fidelity: "high",
            model: "gpt-image-1",
            moderation: "low",
            output_format: "png",
            type: "image_generation",
          },
        ],
      })) as OpenAIResponsePayload;
    }
  } catch (error: unknown) {
    const candidate = error as {
      code?: string;
      message?: string;
      response?: { data?: { error?: { code?: string; message?: string } }; status?: number };
      status?: number;
    };
    console.error(
      `[${context.guildId}] OpenAI responses.create failed (${candidate.status ?? candidate.response?.status ?? "no-status"} ${candidate.code ?? candidate.response?.data?.error?.code ?? ""}): ${candidate.message ?? candidate.response?.data?.error?.message ?? "Unknown error"}`
    );
    await respond.edit(`<@${actor.id}> I couldn't reach OpenAI right now. Please try again in a bit.`);
    return;
  }

  const outputText = sanitizeDiscordText((completion.output_text || "").trim());
  const imageOutputs = Array.isArray(completion.output)
    ? completion.output.filter((output: OpenAIResponseOutput) => output.type === "image_generation_call")
    : [];

  if (imageOutputs.length > 0) {
    const files: Array<{ attachment: string }> = [];
    let count = 0;
    for (const imageOutput of imageOutputs) {
      if (count >= 4) break;
      const imageBase64 = imageOutput.result;
      if (!imageBase64) continue;

      const imageFile = buildGeneratedMediaPath("images", `${actor.username}-${count}`, "png");
      fs.writeFileSync(imageFile, Buffer.from(imageBase64, "base64"));
      files.push({ attachment: imageFile });
      count += 1;
    }

    const chunks = outputText ? chunkMessage(outputText) : [];
    await respond.edit({ content: chunks.shift(), files });
    for (const chunk of chunks) {
      await respond.followUp(chunk);
    }
  } else if (outputText) {
    const parts = chunkMessage(outputText);
    await respond.edit(parts.shift() as string);
    for (const part of parts) {
      await respond.followUp(part);
    }
  } else {
    await respond.edit(`<@${actor.id}> I didn't get anything back from OpenAI.`);
  }

  await maybeRotateConversation(context, completion, async (content) => {
    await respond.followUp(content);
  });
}

export async function handleEasterEggSlashInteraction(
  context: GuildContext,
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const responder = createScheduledCommandResponder(
    interaction,
    context.scheduler,
    `easter-egg-${interaction.commandName}`
  );

  switch (interaction.commandName) {
    case EASTER_EGG_SLASH_COMMANDS.Norm: {
      const prompt = interaction.options.getString("prompt");
      if (!prompt) {
        await responder.edit("Prompt was empty.");
        return;
      }

      const attachments = [
        interaction.options.getAttachment("image1"),
        interaction.options.getAttachment("image2"),
        interaction.options.getAttachment("image3"),
      ]
        .filter((attachment): attachment is NonNullable<typeof attachment> => Boolean(attachment))
        .map((attachment) => ({
          contentType: attachment.contentType,
          url: attachment.url,
        }));

      await enqueueNormTask(context, async () => {
        await runNormPrompt(
          context,
          prompt,
          attachments,
          {
            edit: async (payload) => await responder.edit(payload),
            followUp: async (payload) => {
              await responder.followUp({
                allowedMentions: { parse: [] },
                content: payload,
              });
            },
          },
          {
            id: interaction.user.id,
            username: interaction.user.username,
          }
        );
      });
      break;
    }
    case EASTER_EGG_SLASH_COMMANDS.Sora: {
      if (!isSoraEnabled()) {
        await responder.edit("Sora video generation is disabled for this runtime.");
        return;
      }

      const prompt = interaction.options.getString("prompt");
      const durationStr = interaction.options.getString("duration") ?? "8";
      const validDurations = new Set(["4", "8", "12"]);
      const secondsStr = validDurations.has(durationStr) ? durationStr : "8";
      const duration = Number(secondsStr);

      if (!prompt) {
        await responder.edit("Prompt was empty.");
        return;
      }

      try {
        const videoClient = getSoraVideoClient(context.openai);
        if (!videoClient) {
          throw new Error("Sora is enabled, but the active OpenAI client does not support Videos.");
        }

        const soraModel = getSoraModel();

        let completion = await videoClient.create({
          model: soraModel,
          prompt,
          seconds: secondsStr,
        });

        while (completion.status === "in_progress" || completion.status === "queued") {
          completion = await videoClient.retrieve(completion.id);
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }

        if (completion.status === "failed") {
          const reason = completion.error?.message ? ` ${completion.error.message}` : "";
          await responder.edit(`<@${interaction.user.id}> I couldn't create a video right now.${reason}`);
          return;
        }

        const video = await videoClient.downloadContent(completion.id);
        if (!video) {
          await responder.edit(`<@${interaction.user.id}> I couldn't create a video right now.`);
          return;
        }

        const body = await video.arrayBuffer();
        const buffer = Buffer.from(body);
        const filePath = buildGeneratedMediaPath("videos", `${interaction.user.username}-sora`, "mp4");
        fs.writeFileSync(filePath, buffer);

        await responder.edit({
          content: `<@${interaction.user.id}> Estimated cost: $${(duration * 0.1).toFixed(2)}.`,
          files: [{ attachment: filePath }],
        });
      } catch (error) {
        console.error(`[${context.guildId}] /sora error:`, error);
        await responder.edit(`<@${interaction.user.id}> I couldn't generate the video. Please try again later.`);
      }
      break;
    }
  }
}

export async function handleNormMessage(context: GuildContext, message: Message): Promise<void> {
  if (!message.content.toLowerCase().startsWith(EASTER_EGG_MESSAGE_PREFIX.Norm)) {
    return;
  }

  await enqueueNormTask(context, async () => {
    const prompt = message.content;
    const attachments = Array.from(message.attachments.values()).map((attachment) => ({
      contentType: attachment.contentType,
      url: attachment.url,
    }));

    await runNormPrompt(
      context,
      prompt,
      attachments,
      {
        edit: async (payload) => {
          if (typeof payload === "string") {
            await sendChannelParts(context, message.channel as TextChannel, [payload]);
            return;
          }

          await context.scheduler.enqueue(
            async () =>
              await (message.channel as TextChannel).send({
                allowedMentions: { parse: [] },
                content: payload.content ? sanitizeDiscordText(payload.content) : undefined,
                files: payload.files,
              }),
            {
              label: "chat-channel-send",
              priority: "normal",
            }
          );
        },
        followUp: async (payload) => {
          await sendChannelParts(context, message.channel as TextChannel, [payload]);
        },
      },
      {
        id: message.author.id,
        username: message.author.username,
      }
    );
  });
}
