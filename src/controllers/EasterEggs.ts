/* eslint-disable max-len */
/* eslint-disable no-console */

import { ChatInputCommandInteraction, Message, TextChannel } from "discord.js";
import OpenAI from "openai";
import path from "path";
import * as fs from "fs";
import { GuildContext } from "../runtime/types";

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
  id: string;
  status: "completed" | "failed" | "in_progress" | "queued";
};

type SoraVideoClient = {
  downloadContent: (id: string) => Promise<Response | null>;
  retrieve: (id: string) => Promise<SoraVideoCompletion>;
  create: (payload: { model: string; prompt: string; seconds: string }) => Promise<SoraVideoCompletion>;
};

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
    } catch (error) {
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

      const imageFile = path.join(__dirname, `../images/${actor.username}-${Date.now()}-${count}.png`);
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
  switch (interaction.commandName) {
    case EASTER_EGG_SLASH_COMMANDS.Norm: {
      const prompt = interaction.options.getString("prompt");
      if (!prompt) {
        await interaction.editReply("Prompt was empty.");
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
            edit: async (payload) => {
              await context.scheduler.enqueue(
                async () => await interaction.editReply(payload),
                {
                  dedupeKey: `interaction-edit:${interaction.id}`,
                  label: "interaction-edit-reply",
                  priority: "normal",
                }
              );
            },
            followUp: async (payload) => {
              await context.scheduler.enqueue(
                async () =>
                  await interaction.followUp({
                    allowedMentions: { parse: [] },
                    content: payload,
                  }),
                {
                  label: "interaction-follow-up",
                  priority: "normal",
                }
              );
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
      const prompt = interaction.options.getString("prompt");
      const durationStr = interaction.options.getString("duration") ?? "8";
      const validDurations = new Set(["4", "8", "12"]);
      const secondsStr = validDurations.has(durationStr) ? durationStr : "8";
      const duration = Number(secondsStr);

      if (!prompt) {
        await interaction.editReply("Prompt was empty.");
        return;
      }

      try {
        const videoClient = (context.openai as OpenAI & { videos?: SoraVideoClient }).videos;
        if (!videoClient) {
          await interaction.editReply("This OpenAI SDK build does not support Sora video generation yet.");
          return;
        }

        let completion = await videoClient.create({
          model: "sora-2-2025-12-08",
          prompt,
          seconds: secondsStr,
        });

        while (completion.status === "in_progress" || completion.status === "queued") {
          completion = await videoClient.retrieve(completion.id);
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }

        if (completion.status === "failed") {
          await interaction.editReply(`<@${interaction.user.id}> I couldn't create a video right now.`);
          return;
        }

        const video = await videoClient.downloadContent(completion.id);
        if (!video) {
          await interaction.editReply(`<@${interaction.user.id}> I couldn't create a video right now.`);
          return;
        }

        const body = await video.arrayBuffer();
        const buffer = Buffer.from(body);
        const filePath = path.join(__dirname, `../recordings/${interaction.user.username}-${Date.now()}-sora.mp4`);
        fs.writeFileSync(filePath, buffer);

        await context.scheduler.enqueue(
          async () =>
            await interaction.editReply({
              content: `<@${interaction.user.id}> Estimated cost: $${(duration * 0.1).toFixed(2)}.`,
              files: [{ attachment: filePath }],
            }),
          {
            dedupeKey: `interaction-edit:${interaction.id}`,
            label: "interaction-edit-reply",
            priority: "normal",
          }
        );
      } catch (error) {
        console.error(`[${context.guildId}] /sora error:`, error);
        await interaction.editReply(`<@${interaction.user.id}> I couldn't generate the video. Please try again later.`);
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
