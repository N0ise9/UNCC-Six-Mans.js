/* eslint-disable max-len */
import { ChatInputCommandInteraction } from "discord.js";
import OpenAI from "openai";
import type { Video, VideoCreateParams, Videos } from "openai/resources/videos";
import * as fs from "fs";
import { GuildContext } from "../runtime/types";
import { createScheduledCommandResponder } from "../runtime/createScheduledCommandResponder";
import { buildGeneratedMediaPath } from "../runtime/generatedMediaRetention";

export const EASTER_EGG_SLASH_COMMANDS = {
  Norm: "norm",
  Sora: "sora",
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

type NormAttachment = {
  contentType?: string | null;
  size?: number | null;
  url: string;
};

type NormInputContent =
  | {
      text: string;
      type: "input_text";
    }
  | {
      detail: "auto";
      image_url: string;
      type: "input_image";
    }
  | {
      file_url: string;
      type: "input_file";
    };

type SoraVideoClient = Pick<Videos, "create" | "downloadContent" | "retrieve">;
type SoraVideoSeconds = NonNullable<VideoCreateParams["seconds"]>;
const VALID_SORA_DURATIONS = new Set<SoraVideoSeconds>(["4", "8", "12"]);
const SORA_POLL_INTERVAL_MS = 2_000;
const SORA_MAX_POLL_ATTEMPTS = 150;
const MAX_OPENAI_FILE_INPUT_BYTES = 50 * 1024 * 1024;
const DISCORD_ATTACHMENT_URL_PATTERN = /https:\/\/cdn\.discordapp\.com\/(?:attachments|ephemeral-attachments)\/[^\s"'<>]+/i;
const DISCORD_ATTACHMENT_URL_PREFIX_PATTERN = /^https:\/\/cdn\.discordapp\.com\/(?:attachments|ephemeral-attachments)\//i;
const SKIPPED_ATTACHMENT_NOTICE = "I ignored one or more expired or inaccessible attachments.";
export const DEFAULT_SORA_MODEL = "sora-2-2025-12-08";

type OpenAIErrorDetails = {
  code?: string;
  message: string;
  searchableMessage: string;
  status?: number;
};

type OpenAIResponseError = {
  code?: string;
  message?: string;
  response?: { data?: { error?: { code?: string; message?: string } }; status?: number };
  status?: number;
};

function isSoraEnabled(): boolean {
  return (process.env["ENABLE_SORA"] ?? "false").toLowerCase() === "true";
}

function getSoraModel(): string {
  return DEFAULT_SORA_MODEL;
}

function getSoraVideoClient(openai: OpenAI): SoraVideoClient | null {
  const candidate = openai as OpenAI & { videos?: Partial<SoraVideoClient> };
  if (
    candidate.videos &&
    typeof candidate.videos.create === "function" &&
    typeof candidate.videos.downloadContent === "function" &&
    typeof candidate.videos.retrieve === "function"
  ) {
    return candidate.videos as SoraVideoClient;
  }

  return null;
}

export function assertSoraRuntimeSupport(openai: OpenAI): void {
  if (!isSoraEnabled()) {
    return;
  }

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

function isImageAttachment(attachment: NormAttachment): boolean {
  return attachment.contentType?.startsWith("image/") === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeExtractedUrl(url: string): string {
  return url.replace(/[)\].,]+$/g, "");
}

function isDiscordAttachmentUrl(value: unknown): value is string {
  return typeof value === "string" && DISCORD_ATTACHMENT_URL_PREFIX_PATTERN.test(normalizeExtractedUrl(value));
}

function areSameUrl(left: string, right: string): boolean {
  return normalizeExtractedUrl(left) === normalizeExtractedUrl(right);
}

function getOpenAIErrorDetails(error: unknown): OpenAIErrorDetails {
  const candidate = error as OpenAIResponseError;
  const status = candidate.status ?? candidate.response?.status;
  const code = candidate.code ?? candidate.response?.data?.error?.code;
  const responseMessage = candidate.response?.data?.error?.message;
  const message = candidate.message ?? responseMessage ?? "Unknown error";
  const searchableMessages = [candidate.message, responseMessage].filter(
    (value, index, values): value is string => typeof value === "string" && values.indexOf(value) === index
  );

  return {
    code,
    message,
    searchableMessage: searchableMessages.length > 0 ? searchableMessages.join(" ") : message,
    status,
  };
}

function extractFailedDiscordAttachmentUrl(error: unknown): string | null {
  const details = getOpenAIErrorDetails(error);
  if (details.status !== 400) return null;
  if (details.code && details.code !== "invalid_value") return null;
  if (!/error while downloading/i.test(details.searchableMessage)) return null;

  const match = details.searchableMessage.match(DISCORD_ATTACHMENT_URL_PATTERN);
  if (!match) return null;

  const url = normalizeExtractedUrl(match[0]);
  return isDiscordAttachmentUrl(url) ? url : null;
}

function messageItemHasDiscordAttachmentReference(item: unknown): boolean {
  if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) {
    return false;
  }

  return item.content.some((content) => {
    if (!isRecord(content)) return false;
    return (
      (content.type === "input_file" && isDiscordAttachmentUrl(content.file_url)) ||
      (content.type === "input_image" && isDiscordAttachmentUrl(content.image_url))
    );
  });
}

async function deleteDiscordAttachmentConversationItems(context: GuildContext, conversationId: string): Promise<number> {
  let deletedCount = 0;

  for await (const item of context.openai.conversations.items.list(conversationId, { order: "asc" })) {
    if (!messageItemHasDiscordAttachmentReference(item)) continue;
    if (!isRecord(item) || typeof item.id !== "string") continue;

    await context.openai.conversations.items.delete(item.id, { conversation_id: conversationId });
    deletedCount += 1;
  }

  return deletedCount;
}

function getKnownNonImageFileBytes(attachments: NormAttachment[]): number {
  return attachments
    .filter((attachment) => !isImageAttachment(attachment))
    .reduce((total, attachment) => {
      return typeof attachment.size === "number" ? total + attachment.size : total;
    }, 0);
}

function buildNormInputContent(actor: { id: string; username: string }, prompt: string, attachments: NormAttachment[]) {
  const content: NormInputContent[] = [{ text: `${actor.id} ${actor.username}: ${prompt}`, type: "input_text" }];

  for (const attachment of attachments.slice(0, 3)) {
    if (isImageAttachment(attachment)) {
      content.push({
        detail: "auto",
        image_url: attachment.url,
        type: "input_image",
      });
      continue;
    }

    content.push({
      file_url: attachment.url,
      type: "input_file",
    });
  }

  return content;
}

function buildNormResponseRequest(
  conversationId: string,
  actor: { id: string; username: string },
  prompt: string,
  attachments: NormAttachment[]
): { hasAttachmentInputs: boolean; request: Record<string, unknown> } {
  const inputContent = buildNormInputContent(actor, prompt, attachments);
  const hasAttachmentInputs = inputContent.length > 1;
  const baseRequest = {
    conversation: conversationId,
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
  };

  if (!hasAttachmentInputs) {
    return {
      hasAttachmentInputs,
      request: {
        ...baseRequest,
        input: `${actor.id} ${actor.username}: ${prompt}`,
      },
    };
  }

  return {
    hasAttachmentInputs,
    request: {
      ...baseRequest,
      input: [
        {
          content: inputContent,
          role: "user",
        },
      ],
    },
  };
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

async function waitForSoraCompletion(videoClient: SoraVideoClient, video: Video): Promise<Video> {
  let currentVideo = video;
  let attempt = 0;

  while (
    (currentVideo.status === "in_progress" || currentVideo.status === "queued") &&
    attempt < SORA_MAX_POLL_ATTEMPTS
  ) {
    attempt += 1;
    await new Promise((resolve) => setTimeout(resolve, SORA_POLL_INTERVAL_MS));
    currentVideo = await videoClient.retrieve(currentVideo.id);
  }

  if (currentVideo.status === "in_progress" || currentVideo.status === "queued") {
    throw new Error("Sora generation timed out before the video completed.");
  }

  return currentVideo;
}

async function runNormPrompt(
  context: GuildContext,
  prompt: string,
  attachments: NormAttachment[],
  respond: {
    edit: (payload: string | { content?: string; files?: Array<{ attachment: string }> }) => Promise<void>;
    followUp: (payload: string) => Promise<void>;
  },
  actor: { id: string; username: string }
): Promise<void> {
  const knownNonImageFileBytes = getKnownNonImageFileBytes(attachments);
  if (knownNonImageFileBytes > MAX_OPENAI_FILE_INPUT_BYTES) {
    await respond.edit(
      `<@${actor.id}> I can read attached files up to 50 MB total. This set is too large; try fewer or smaller files.`
    );
    return;
  }

  const conversationId = await ensureConversation(context);
  let activeAttachments = attachments.slice(0, 3);
  let completion: OpenAIResponsePayload | undefined;
  let cleanedStaleConversationAttachments = false;
  let skippedUnavailableAttachments = false;
  let staleConversationCleanupAttempted = false;

  while (!completion) {
    const request = buildNormResponseRequest(conversationId, actor, prompt, activeAttachments);
    const hasAttachmentInputs = request.hasAttachmentInputs;

    try {
      completion = (await context.openai.responses.create(request.request)) as OpenAIResponsePayload;
    } catch (error: unknown) {
      const details = getOpenAIErrorDetails(error);
      console.error(
        `[${context.guildId}] OpenAI responses.create failed (${details.status ?? "no-status"} ${details.code ?? ""}): ${details.message}`
      );

      const failedDiscordUrl = extractFailedDiscordAttachmentUrl(error);
      if (failedDiscordUrl) {
        const nextAttachments = activeAttachments.filter((attachment) => !areSameUrl(attachment.url, failedDiscordUrl));
        if (nextAttachments.length < activeAttachments.length) {
          activeAttachments = nextAttachments;
          skippedUnavailableAttachments = true;
          continue;
        }

        if (!staleConversationCleanupAttempted) {
          staleConversationCleanupAttempted = true;
          try {
            const deletedCount = await deleteDiscordAttachmentConversationItems(context, conversationId);
            if (deletedCount > 0) {
              cleanedStaleConversationAttachments = true;
              continue;
            }
          } catch (cleanupError) {
            console.error(`[${context.guildId}] Failed to remove stale OpenAI conversation attachments:`, cleanupError);
          }
        }
      }

      const reply = hasAttachmentInputs || attachments.length > 0
        ? `<@${actor.id}> I couldn't read one or more attached files. The file link may have expired, or OpenAI may not support that file type. Try reattaching it or sending a PDF/text file.`
        : `<@${actor.id}> I couldn't reach OpenAI right now. Please try again in a bit.`;
      await respond.edit(reply);
      return;
    }
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

  if (skippedUnavailableAttachments || cleanedStaleConversationAttachments) {
    await respond.followUp(SKIPPED_ATTACHMENT_NOTICE);
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

      const attachments = [1, 2, 3]
        .map((index) => {
          return (
            interaction.options.getAttachment(`file${index}`) ??
            interaction.options.getAttachment(`image${index}`)
          );
        })
        .filter((attachment): attachment is NonNullable<typeof attachment> => Boolean(attachment))
        .map((attachment) => ({
          contentType: attachment.contentType,
          size: attachment.size,
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
      const seconds = VALID_SORA_DURATIONS.has(durationStr as SoraVideoSeconds)
        ? (durationStr as SoraVideoSeconds)
        : "8";

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

        const completion = await videoClient.create({
          model: soraModel,
          prompt,
          seconds,
        });
        const completedVideo = await waitForSoraCompletion(videoClient, completion);

        if (completedVideo.status === "failed") {
          const reason = completedVideo.error?.message ? ` ${completedVideo.error.message}` : "";
          await responder.edit(`<@${interaction.user.id}> I couldn't create a video right now.${reason}`);
          return;
        }

        const video = await videoClient.downloadContent(completedVideo.id);
        const body = await video.arrayBuffer();
        const buffer = Buffer.from(body);
        const filePath = buildGeneratedMediaPath("videos", `${interaction.user.username}-sora`, "mp4");
        fs.writeFileSync(filePath, buffer);

        await responder.edit({
          content: `<@${interaction.user.id}> Here's your Sora video.`,
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
