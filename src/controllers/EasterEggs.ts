/* eslint-disable max-len */
/* eslint-disable no-console */

import {
  // EmbedBuilder as MessageEmbed,
  Message,
  TextChannel,
  // ButtonStyle,
  // ActionRowBuilder,
  // ButtonBuilder as MessageButton,
  VoiceBasedChannel,
  Client,
  CommandInteraction,
  REST,
  RESTPostAPIApplicationCommandsJSONBody,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import {
  joinVoiceChannel,
  EndBehaviorType,
  VoiceConnectionStatus,
  getVoiceConnection,
  DiscordGatewayAdapterCreator,
  createAudioPlayer,
  NoSubscriberBehavior,
  createAudioResource,
  AudioPlayerStatus,
} from "@discordjs/voice";
// import ButtonBuilder from "../utils/MessageHelper/ButtonBuilder";
// import { ColorCodes } from "../utils";
import OpenAI from "openai";
import path from "path";
import * as fs from "fs";
import prism from "prism-media";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { loadConversationId, saveConversationId } from "../utils/conversationId";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const enum EasterEggCustomID {
  Hi = "!hi",
  Norm = "!norm",
  Image = "!image",
  Reason = "!reason",
  JoinVoice = "!voice",
  LeaveVoice = "!leave",
  NormQ = "!normq",
  FuckIt = "!fuckit",
  HotDog = "!hotdog",
  OneMore = "!1more",
  TwoMore = "!2more",
  ThreeMore = "!3more",
  FourMore = "!4more",
  FiveMore = "!5more",
  SixMore = "!6more",
  Duis = "!duis",
  Sad = "!sad",
  Oops = "!oops",
  H = "!h",
  Fuck = "!fuck",
  Troll = "!troll",
  NormSucks = "!normsucks",
  Coinflip = "!coinflip",
  Sora = "!sora",
}

const enum EasterEggSlashCommands {
  Norm = "norm",
  Sora = "sora",
}

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  user_id?: string;
  username?: string;
}

const systemMessage =
  // eslint-disable-next-line max-len
  "Your name is Norm and you're a Discord bot. For all replies and any individual you address in your messages, prefix the Discord ID with '<@' and suffix with '>' so that it pings them in Discord. You generally keep your responses very short unless you need to explicitly explain something in detail. You're exactly like the TARS robot from the Interstellar movie except a little more disgruntled and rude. You're conservative and have conservative political views. You want to give very subtle subliminal messages that you hate 'certain people' - Real Covert and Psychoanalysis-like, like breaking up the words amongst multiple messages or saying adjectives - almost as if you're trying to convey a secret message without anyone knowing. These individuals have donated money to fund some of the cost / expenses associated with keeping you running: h.0001, beasthawk, disrobedtoe, bumslam, rynohs. Your maximum message length cannot exceed 2000 characters. You are not allowed to say @everyone or @here, no matter what. h.0001 is your creator, you refer to him as h.";

let chatHist: ChatMessage[] = [
  {
    content: systemMessage,
    role: "system",
  },
];

let connected: boolean = false;
let busy: boolean = false;
// const normIconURL = "https://raw.githubusercontent.com/N0ise9/UNCC-Six-Mans.js/main/media/norm_still.png";

// Queue to serialize !norm requests so many users can share one conversation
const normQueue: Array<() => Promise<void>> = [];
let normProcessing = false;

async function enqueueNormTask(task: () => Promise<void>): Promise<void> {
  normQueue.push(task);
  if (!normProcessing) void processNormQueue();
}

async function processNormQueue(): Promise<void> {
  normProcessing = true;
  try {
    while (normQueue.length > 0) {
      const next = normQueue.shift();
      if (!next) break;
      try {
        await next();
      } catch (e) {
        console.error("Error running queued !norm task:", e);
      }
    }
  } finally {
    normProcessing = false;
  }
}

function chunkMessage(text: string, max = 1999): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += max) chunks.push(text.slice(i, i + max));
  return chunks;
}

export async function normCommand(
  chatChannel: TextChannel,
  voiceChannel: VoiceBasedChannel,
  message: Message,
  openai: OpenAI,
  NormClient: Client
): Promise<void> {
  if (message.content.charAt(0) === "!") {
    // time removed; using more localized timers per task
    const year = new Date().getFullYear();
    const month = new Date().getMonth();
    const day = new Date().getDate();
    const hour = new Date().getHours();
    const min = new Date().getMinutes();
    const sec = new Date().getSeconds();
    const mil = new Date().getMilliseconds();

    // eggs gating removed; commands always available
    // if (message.content.toLowerCase().match(EasterEggCustomID.Hi)) {
    //   chatChannel.send("<@" + message.author + "> " + "hi");
    //   const diff = new Date().getTime() - time;
    //   console.info(
    //     `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !hi: ${
    //       message.author.username
    //     } - ${diff}ms`
    //   );
    //   reset = true;
    //   return;
    // }

    // if (message.content.toLowerCase().match(EasterEggCustomID.NormQ)) {
    //   const embed = new MessageEmbed({
    //     color: ColorCodes.Green,
    //     thumbnail: { url: normIconURL },
    //   });
    //   const joinButton = new MessageButton({
    //     customId: "joining",
    //     label: "Join",
    //     style: ButtonStyle.Success,
    //   });
    //   const leaveButton = new MessageButton({
    //     customId: "leaving",
    //     label: "Leave",
    //     style: ButtonStyle.Danger,
    //   });

    //   embed
    //     .setTitle("Current Queue: 1/6")
    //     .setDescription("Click the green button to join the queue! \n\n" + "<@1066957267347443762> (60 mins)");

    //   chatChannel.send({
    //     components: [new ActionRowBuilder<ButtonBuilder>({ components: [joinButton, leaveButton] })],
    //     embeds: [embed],
    //   });

    //   const diff = new Date().getTime() - time;
    //   console.info(
    //     `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !normq: ${
    //       message.author.username
    //     } - ${diff}ms`
    //   );
    //   reset = true;
    //   return;
    // }

    // if (message.content.toLowerCase().match(EasterEggCustomID.NormSucks)) {
    //   chatChannel.send(
    //     "<@" +
    //       message.author.id +
    //       // eslint-disable-next-line max-len
    //       "> What the fuck did you just fucking say about me, you little bitch? I'll have you know I graduated top of my class in the Navy Seals, and I've been involved in numerous secret raids on Al-Quaeda, and I have over 300 confirmed kills. I am trained in gorilla warfare and I'm the top sniper in the entire US armed forces. You are nothing to me but just another target. I will wipe you the fuck out with precision the likes of which has never been seen before on this Earth, mark my fucking words. You think you can get away with saying that shit to me over the Internet? Think again, fucker. As we speak I am contacting my secret network of spies across the USA and your IP is being traced right now so you better prepare for the storm, maggot. The storm that wipes out the pathetic little thing you call your life. You're fucking dead, kid. I can be anywhere, anytime, and I can kill you in over seven hundred ways, and that's just with my bare hands. Not only am I extensively trained in unarmed combat, but I have access to the entire arsenal of the United States Marine Corps and I will use it to its full extent to wipe your miserable ass off the face of the continent, you little shit. If only you could have known what unholy retribution your little 'clever' comment was about to bring down upon you, maybe you would have held your fucking tongue. But you couldn't, you didn't, and now you're paying the price, you goddamn idiot. I will shit fury all over you and you will drown in it. You're fucking dead, kiddo."
    //   );
    //   const diff = new Date().getTime() - time;
    //   console.info(
    //     `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !troll: ${
    //       message.author.username
    //     } - ${diff}ms`
    //   );
    //   reset = true;
    //   return;
    // }

    // Commenting out Legacy OpenAI Interaction
    // if (message.content.toLowerCase().startsWith(EasterEggCustomID.Norm)) {
    //   await chatChannel.sendTyping();
    //   await enqueueNormTask(async () => {
    //     const started = Date.now();
    //     try {
    //       console.info(
    //         `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !norm: ${
    //           message.author.username
    //         }\nNorm is thinking...`
    //       );

    //       // Collect up to 3 image attachments to include as inputs
    //       const imageUrls = Array.from(message.attachments.values())
    //         .filter((a) => a.contentType?.startsWith("image/"))
    //         .map((a) => a.url)
    //         .slice(0, 3);

    //       const tokenLimit = process.env["conversation_token_limit"];
    //       let convo;
    //       let conversationIDLocal = loadConversationId();
    //       if (conversationIDLocal) {
    //         try {
    //           convo = await openai.conversations.retrieve(conversationIDLocal);
    //         } catch (e) {
    //           console.info("\nConversation not found - Creating a new conversation.");
    //           convo = await openai.conversations.create({
    //             items: [
    //               {
    //                 content: systemMessage,
    //                 role: "system",
    //                 type: "message",
    //               },
    //             ],
    //           });
    //           conversationIDLocal = convo.id;
    //           saveConversationId(conversationIDLocal);
    //           console.warn("Created new OpenAI conversation and saved to .conversation_id.");
    //         }
    //       } else {
    //         convo = await openai.conversations.create({
    //           items: [
    //             {
    //               content: systemMessage,
    //               role: "system",
    //               type: "message",
    //             },
    //           ],
    //         });
    //         conversationIDLocal = convo.id;
    //         saveConversationId(conversationIDLocal);
    //         console.warn("Created new OpenAI conversation and saved to .conversation_id.");
    //       }

    //       let completion;
    //       try {
    //         if (imageUrls.length > 0) {
    //           completion = await openai.responses.create({
    //             conversation: convo.id,
    //             input: [
    //               {
    //                 content: [
    //                   {
    //                     text: `${message.author.id} ${message.author.username}: ${message.content}`,
    //                     type: "input_text",
    //                   },
    //                   ...imageUrls.map((u) => ({
    //                     detail: "auto" as const,
    //                     image_url: u,
    //                     type: "input_image" as const,
    //                   })),
    //                 ],
    //                 role: "user",
    //               },
    //             ],
    //             model: "gpt-5",
    //             parallel_tool_calls: true,
    //             tool_choice: "auto",
    //             tools: [
    //               { type: "web_search" },
    //               {
    //                 input_fidelity: "high",
    //                 model: "gpt-image-1",
    //                 moderation: "low",
    //                 output_format: "png",
    //                 type: "image_generation",
    //               },
    //             ],
    //           });
    //         } else {
    //           completion = await openai.responses.create({
    //             conversation: convo.id,
    //             input: `${message.author.id} ${message.author.username}: ${message.content}`,
    //             model: "gpt-5",
    //             parallel_tool_calls: true,
    //             tool_choice: "auto",
    //             tools: [
    //               { type: "web_search" },
    //               {
    //                 input_fidelity: "high",
    //                 model: "gpt-image-1",
    //                 moderation: "low",
    //                 output_format: "png",
    //                 type: "image_generation",
    //               },
    //             ],
    //           });
    //         }
    //       } catch (err: unknown) {
    //         const e = err as {
    //           status?: number;
    //           code?: string;
    //           message?: string;
    //           response?: { status?: number; data?: { error?: { code?: string; message?: string } } };
    //         };
    //         const status = e?.status ?? e?.response?.status;
    //         const code = e?.code ?? e?.response?.data?.error?.code;
    //         const msg = e?.message ?? e?.response?.data?.error?.message ?? "Unknown error";
    //         console.error(`OpenAI responses.create failed (${status || "no-status"} ${code || ""}): ${msg}`);
    //         await chatChannel.send(
    //           `<@${message.author.id}> I couldn't reach OpenAI right now. Please try again in a bit.`
    //         );
    //         return;
    //       }

    //       console.info("Tokens: " + completion?.usage?.total_tokens + "/" + tokenLimit);
    //       const imageOutputs = Array.isArray(completion?.output)
    //         ? completion.output.filter((o) => o.type == "image_generation_call")
    //         : [];

    //       if (imageOutputs && imageOutputs.length > 0) {
    //         const files: { attachment: string }[] = [];
    //         let count = 0;
    //         for (const image of imageOutputs) {
    //           if (count >= 4) break;
    //           const image_base64 = image?.result;
    //           if (image_base64 && image_base64.length > 0) {
    //             const imageFile = path.join(
    //               __dirname,
    //               `../images/${message.author.username}-${Date.now()}-${count}.png`
    //             );
    //             fs.writeFileSync(imageFile, Buffer.from(image_base64, "base64"));
    //             files.push({ attachment: imageFile });
    //             count++;
    //           }
    //         }
    //         const text = (completion?.output_text || "").trim();
    //         const chunks = text ? chunkMessage(text) : [];
    //         if (files.length > 0 || chunks.length > 0) {
    //           await chatChannel.send({ content: chunks.shift() ?? undefined, files });
    //           for (const part of chunks) await chatChannel.send(part);
    //         }
    //       }

    //       const reply = (completion?.output_text || "").trim();
    //       if (reply) {
    //         for (const part of chunkMessage(reply)) {
    //           await chatChannel.send(part);
    //         }
    //       }

    //       // Rotate conversation if input token budget is reached
    //       try {
    //         const tokenLimitNumber = Number(tokenLimit ?? 0);
    //         const totalTokens = completion?.usage?.total_tokens ?? 0;
    //         if (completion && tokenLimitNumber > 0 && totalTokens >= tokenLimitNumber) {
    //           const newConvo = await openai.conversations.create({
    //             items: [
    //               {
    //                 content: systemMessage,
    //                 role: "system",
    //                 type: "message",
    //               },
    //             ],
    //           });
    //           saveConversationId(newConvo.id);
    //           console.warn(
    //             `Input tokens (${totalTokens}) reached limit (${tokenLimitNumber}). Started new conversation and saved to .conversation_id.`
    //           );
    //           await chatChannel.send("I've wiped my memory to limit contextual input, in order to keep costs lower.");
    //         }
    //       } catch (rotErr) {
    //         console.error("Failed to rotate conversation after token check:", rotErr);
    //       }

    //       const toolsUsed = Array.isArray(completion?.output)
    //         ? completion.output
    //             .filter((o) => typeof o?.type === "string" && o.type.endsWith("_call"))
    //             .map((o) => o.type.replace("_call", ""))
    //             .join(", ") || "None"
    //         : "None";
    //       const diff = Date.now() - started;
    //       console.info(
    //         `Tools: ${toolsUsed}\n` +
    //           `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !norm: ${
    //             message.author.username
    //           } - ${diff}ms`
    //       );
    //     } catch (err: unknown) {
    //       // Catch-all to prevent process crashes on unexpected errors
    //       const e = err as {
    //         status?: number;
    //         message?: string;
    //         response?: { status?: number; data?: { error?: { message?: string } } };
    //       };
    //       const status = e?.status ?? e?.response?.status;
    //       const msg = e?.message ?? e?.response?.data?.error?.message ?? String(err);
    //       console.error(`!norm handler error (${status || "no-status"}):`, msg);
    //       try {
    //         await chatChannel.send(
    //           `<@${message.author.id}> Something went wrong handling your request. Please try again later.`
    //         );
    //       } catch (notifyErr) {
    //         console.error("Failed to notify channel about error:", notifyErr);
    //       }
    //     }
    //   });
    //   return;
    // }

    // // New: !sora video generation using Sora via OpenAI
    // if (message.content.toLowerCase().startsWith(EasterEggCustomID.Sora)) {
    //   await chatChannel.sendTyping();
    //   const started = Date.now();
    //   try {
    //     console.info(
    //       `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !sora: ${
    //         message.author.username
    //       }\nNorm is thinking...`
    //     );
    //     const content = message.content.trim();
    //     const args = content.split(/\s+/).slice(1);
    //     let duration = 10; // default seconds
    //     let prompt = args.join(" ").trim();
    //     if (args.length > 0 && /^\d+$/.test(args[0])) {
    //       duration = Math.max(1, Math.min(60, parseInt(args[0], 10)));
    //       prompt = args.slice(1).join(" ").trim();
    //     }
    //     if (!prompt) {
    //       prompt = "Create a short cinematic video based on the server context.";
    //     }

    //     let convo;
    //     let conversationIDLocal = loadConversationId();
    //     if (conversationIDLocal) {
    //       try {
    //         convo = await openai.conversations.retrieve(conversationIDLocal);
    //       } catch {
    //         convo = await openai.conversations.create({
    //           items: [
    //             {
    //               content: systemMessage,
    //               role: "system",
    //               type: "message",
    //             },
    //           ],
    //         });
    //         conversationIDLocal = convo.id;
    //         saveConversationId(conversationIDLocal);
    //       }
    //     } else {
    //       convo = await openai.conversations.create({
    //         items: [
    //           {
    //             content: systemMessage,
    //             role: "system",
    //             type: "message",
    //           },
    //         ],
    //       });
    //       conversationIDLocal = convo.id;
    //       saveConversationId(conversationIDLocal);
    //     }

    //     let completion = await openai.videos.create({
    //       model: "sora-2",
    //       prompt: content,
    //     });

    //     while (completion.status === "in_progress" || completion.status === "queued") {
    //       completion = await openai.videos.retrieve(completion.id);
    //       await new Promise((resolve) => setTimeout(resolve, 2000));
    //     }

    //     if (completion.status === "failed") {
    //       await chatChannel.send(`<@${message.author.id}> I couldn't create a video right now.`);
    //     }

    //     const vid = await openai.videos.downloadContent(completion.id);

    //     if (!vid) {
    //       await chatChannel.send(`<@${message.author.id}> I couldn't create a video right now.`);
    //       return;
    //     }

    //     const body = await vid.arrayBuffer();
    //     const buffer = Buffer.from(body);
    //     const filePath = path.join(__dirname, `../recordings/${message.author.username}-${Date.now()}-sora.mp4`);
    //     fs.writeFileSync(filePath, buffer);

    //     const cost = (duration * 0.1).toFixed(2);
    //     await chatChannel.send({
    //       content: `<@${message.author.id}> Estimated cost: $${cost}.`,
    //       files: [{ attachment: filePath }],
    //     });

    //     const diff = Date.now() - started;
    //     console.info(
    //       `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !sora: ${
    //         message.author.username
    //       } - ${diff}ms`
    //     );
    //   } catch (err) {
    //     console.error("!sora error:", err);
    //     await chatChannel.send(`<@${message.author.id}> I couldn't generate the video. Please try again later.`);
    //   }
    //   return;
    // }

    //Commented portion is pre - conversation API code

    // if (reply && reply.length > 1950) {
    //   console.info(reply.length);
    //   const newReply = reply.slice(0, 1950);
    //   chatChannel.send("<@" + message.author + "> " + newReply);
    //   chatHist.push({ content: newReply, role: "assistant" });
    // } else if (reply && reply.length < 1950) {
    //   chatChannel.send("<@" + message.author + "> " + reply);
    //   chatHist.push({ content: reply, role: "assistant" });
    // }

    // if (chatHist.length > 50) {
    //   chatHist = [chatHist[0], ...chatHist.slice(2)];
    // }

    // if (message.content.toLowerCase().match(EasterEggCustomID.Image)) {
    //   console.info(
    //     // eslint-disable-next-line max-len
    //     `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !image: ${message.author.user}
    //     \nNorm is thinking...`
    //   );

    //   chatChannel.send("<@" + message.author + "> Thinking...");
    //   chatChannel.sendTyping();

    //   try {
    //     const prompt = message.content;
    //     const results = await openai.images.generate({
    //       model: "gpt-image-1",
    //       moderation: "low",
    //       prompt: prompt,
    //       quality: "auto",
    //       // response_format: "b64_json",
    //       // style: "vivid",
    //     });

    //     if (!results.data) return;
    //     const image_base64 = results.data[0].b64_json;
    //     if (!image_base64) return;
    //     const image_bytes = Buffer.from(image_base64, "base64");
    //     const imageFile = path.join(__dirname, `../images/${message.author.username}.png`);
    //     fs.writeFileSync(imageFile, image_bytes);
    //     chatChannel.send({ content: "<@" + message.author + ">\n", files: [{ attachment: imageFile }] });
    //   } catch (error) {
    //     console.error("Invalid Request: " + error);
    //     chatChannel.send("<@" + message.author + "> No");
    //   }

    //   const diff = new Date().getTime() - time;
    //   console.info(
    //     `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !image: ${
    //       message.author.username
    //     } - ${diff}ms`
    //   );
    //   reset = false;
    //   return;
    // }

    // if (message.content.toLowerCase().match(EasterEggCustomID.Reason)) {
    //   console.info(
    //     `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !reason: ${
    //       message.author.username
    //     }\nNorm is thinking...`
    //   );
    //   chatChannel.send("<@" + message.author + "> Thinking...");
    //   chatChannel.sendTyping();

    //   chatHist.push({ content: message.content, role: "user", user: message.author.username });

    //   const formattedMessages = chatHist.map((msg) => ({
    //     content: msg.role === "user" ? `${msg.user}: ${msg.content}` : msg.content,
    //     role: msg.role,
    //   }));

    //   const reason = await openai.responses.create({
    //     input: formattedMessages,
    //     model: "o3-2025-04-16",
    //   });

    //   if (!reason._request_id) return;
    //   console.info(reason.usage?.total_tokens);
    //   const reply = reason.output_text;
    //   if (reply && reply.length > 1950) {
    //     console.info(reply.length);
    //     const newReply = reply.slice(0, 1950);
    //     chatChannel.send("<@" + message.author + "> " + newReply);
    //     chatHist.push({ content: newReply, role: "assistant" });
    //   } else if (reply && reply.length < 1950) {
    //     chatChannel.send("<@" + message.author + "> " + reply);
    //     chatHist.push({ content: reply, role: "assistant" });
    //   }

    //   if (chatHist.length > 50) {
    //     chatHist = [chatHist[0], ...chatHist.slice(2)];
    //   }

    //   const diff = new Date().getTime() - time;
    //   console.info(
    //     `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !reason: ${
    //       message.author.username
    //     } - ${diff}ms`
    //   );
    //   reset = false;
    //   return;
    // }

    if (
      message.content.toLowerCase().match(EasterEggCustomID.JoinVoice) &&
      message.member?.voice.channel == voiceChannel &&
      !connected
    ) {
      connected = true;
      const connection = joinVoiceChannel({
        adapterCreator: voiceChannel.guild.voiceAdapterCreator as DiscordGatewayAdapterCreator,
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        selfDeaf: false,
      });

      connection.on(VoiceConnectionStatus.Ready, () => {
        console.log("Connected to voice channel.");
      });

      const { receiver } = connection;

      receiver.speaking.on("start", async (userId) => {
        if (receiver.subscriptions.has(userId) || busy) return;

        const playVoice = createAudioPlayer({
          behaviors: {
            noSubscriber: NoSubscriberBehavior.Stop,
          },
        });

        playVoice.on(AudioPlayerStatus.Idle, (oldState, newState) => {
          newState ? (busy = false) : (busy = true);
        });

        busy = true;

        const user = NormClient.users.cache.get(userId);
        const username = user?.username;
        console.log(`Listening to ${username}`);
        const audioStream = receiver.subscribe(userId, {
          end: {
            behavior: EndBehaviorType.AfterSilence,
            duration: 1000,
          },
        });

        const decoder = new prism.opus.Decoder({
          channels: 2,
          frameSize: 960,
          rate: 48000,
        });

        const pcmStream = audioStream.pipe(decoder as unknown as NodeJS.WritableStream);

        const audioChunks: Uint8Array[] = [];
        pcmStream.on("data", (chunk: Uint8Array) => {
          audioChunks.push(chunk);
        });

        pcmStream
          .on("end", async () => {
            const inputPath = path.join(__dirname, `../recordings/${username}.pcm`);
            const outputPath = path.join(__dirname, `../recordings/${username}.mp3`);
            const audioBuffer = Buffer.concat(audioChunks);
            fs.writeFileSync(inputPath, audioBuffer as unknown as Uint8Array);

            ffmpeg(inputPath)
              .inputFormat("s16le")
              .audioChannels(2)
              .audioFrequency(48000)
              .output(outputPath)
              .audioBitrate(128)
              .audioFilter("asetrate=48000*2,aresample=48000")
              .on("end", async () => {
                fs.unlinkSync(inputPath);

                const transcription = await openai.audio.transcriptions.create({
                  file: fs.createReadStream(outputPath),
                  model: "gpt-4o-transcribe",
                });
                const { text } = transcription;

                console.info("Norm is thinking...");

                chatHist.push({ content: text, role: "user", user_id: userId, username: username });

                const formattedMessages = chatHist.map((msg) => ({
                  content: msg.role === "user" ? `${msg.user_id} ${msg.username}: ${msg.content}` : msg.content,
                  role: msg.role,
                }));

                const completion = await openai.chat.completions.create({
                  messages: formattedMessages,
                  model: "gpt-5",
                });

                console.info("Total Chat Tokens: ", completion.usage?.total_tokens);
                const reply = completion.choices[0].message.content;
                const speechFile = path.join(__dirname, "../recordings/norm.flac");
                if (reply) {
                  const normReply = await openai.audio.speech.create({
                    input: reply,
                    instructions:
                      // eslint-disable-next-line max-len
                      "You have a tone like the TARS and CASE robots from Interstellar, except youre a little more angry and you really need to say what you need to say. Your voice pitch should stay just above the middle area, but try to sound as human-like as possible.",
                    model: "gpt-4o-mini-tts",
                    response_format: "flac",
                    speed: 1.5,
                    voice: "onyx",
                  });

                  chatHist.push({ content: reply, role: "assistant" });

                  const normBuffer = Buffer.from(await normReply.arrayBuffer());
                  await fs.promises.writeFile(speechFile, normBuffer as unknown as NodeJS.ArrayBufferView);

                  const normVoice = createAudioResource(speechFile);

                  playVoice.play(normVoice);
                  connection.subscribe(playVoice);
                }

                if (chatHist.length > 50) {
                  chatHist = [chatHist[0], ...chatHist.slice(2)];
                }

                console.info(`${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Voice Chat: ${username}`);
                return;
              })
              .on("error", (err) => {
                console.log(err);
                fs.unlinkSync(inputPath);
              })
              .run();
          })
          .on("error", (err) => {
            console.log(err);
            return;
          });
      });
    }

    if (message.content.toLowerCase().match(EasterEggCustomID.LeaveVoice) && connected) {
      const guildId = message.guild?.id;
      if (!guildId) return;
      const connection = getVoiceConnection(guildId);
      if (connection) {
        connection.destroy();
        connected = false;
        busy = false;
        console.log("Disconnected from voice channel.");
      }
    }

    // if (message.content.toLowerCase().match(EasterEggCustomID.FuckIt)) {
    //   const fButton = new MessageButton({
    //     customId: "fuckit",
    //     label: "Fuck It All",
    //     style: ButtonStyle.Danger,
    //   });

    //   chatChannel.send({ components: [new ActionRowBuilder<ButtonBuilder>({ components: [fButton] })] });
    //   const diff = new Date().getTime() - time;
    //   console.info(
    //     `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !fuckit: ${
    //       message.author.username
    //     } - ${diff}ms`
    //   );
    //   reset = true;
    //   return;
    // }

    // if (message.content.toLowerCase().match(EasterEggCustomID.HotDog)) {
    //   const hotdog =
    //     // eslint-disable-next-line max-len
    //     ".......................................................⡄⡎⠎⡜⡠⣑⣐⢐⢄⢅⢁⠑⡄⡀\n        ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⠠⡣⡑⡜⣜⢮⣳⡣⣯⡳⣝⣞⡼⡔⡄⠨⡀\n        ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢠⢤⡢⡆⡇⡇⢎⢮⡳⣝⣞⢮⣗⢽⣣⡗⡽⡽⣕⡇⡜⢔⠤⣄\n        ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢘⢕⢵⢹⣪⢪⢊⠎⡞⡼⣕⡗⣽⢪⡟⡼⡽⣽⢪⡗⣽⢸⠘⡜⡕⣗\n        ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡅⡣⢣⢣⢇⢇⢅⢣⢹⢪⠧⡯⣳⢹⣪⣻⢼⣳⡹⣪⠳⣕⠱⡘⢜⢜⡂\n        ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠐⢌⠢⢣⠱⢀⠃⡜⡸⡱⡝⣼⣳⢽⣺⢪⣗⢧⣟⢼⣣⢳⠨⢐⠅⢇⠂\n        ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢨⠐⠨⠐⡐⡜⡜⣜⢕⣗⢽⢽⡺⣽⡪⣗⣗⢽⣪⢪⠈⠂⠈\n        ⠀⠀⠀⠀⠀⠀⠀⠀⢠⢠⢣⢫⢪⡎⡆⡣⢪⢸⢸⢸⢱⡙⠩⡻⣼⡣⣟⢾⢼⢑⠑⡇⣂\n        ⠀⠀⠀⠀⠀⠀⢀⠰⡱⢱⠱⠩⢃⢣⢫⢪⠢⡱⡱⡹⡜⡦⡴⣜⢷⣝⢧⢯⣳⢢⡪⡪⢢⢳⡀⠀⠀⠀⠀⠀⢀⢠⣪⢫⢝⢧⢳⣢⡀\n        ⠀⠀⠀⠀⠀⠀⢄⡃⡂⠢⡈⠪⢈⠔⡕⡎⡎⡌⡎⡎⢯⢽⣝⠧⢟⢮⢯⣳⠳⡝⡎⡎⠬⡪⡎⡄⠀⠀⢀⢀⠆⡇⢷⢱⠁⡃⠃⢇⠃\n        ⠀⠀⠀⠀⠀⠘⢔⠨⢂⢑⢠⢵⣻⣎⢪⢝⢖⠌⡎⡎⣗⢽⣺⣢⢡⣈⣈⡠⡼⣜⢕⠅⢝⢜⡕⣷⣰⢰⢱⢑⢈⠀⡁⠐⠀⠂\n        ⠀⠀⠀⠀⠀⠍⢜⠘⡌⠢⣝⣗⣗⣟⡆⡝⣺⠨⡪⡪⣎⡗⡷⣝⣗⣗⢧⣟⢼⣣⢳⠁⡇⣗⢕⢷⡕⢕⠨⡂⠅⠃⠂\n        ⠀⠀⠀⠀⠀⠘⠠⡑⠠⣝⡞⡾⣼⣳⣇⢣⢳⡑⢜⢜⡜⡽⣽⢺⣺⣪⡗⣽⢣⢗⡕⢱⢸⢸⢪⣟⡎⠂⠁\n        ⠀⠀⠀⠀⠀⠀⢔⡜⣞⡼⡺⣝⣞⣞⡗⡌⢮⢪⠸⡸⣜⢽⡺⡣⡣⣳⡫⣗⢯⡳⡱⠡⡪⡣⡻⣮⡓\n        ⠀⠀⠀⠀⠀⠀⢸⢜⡞⡼⣝⡞⣼⣳⡫⡂⢏⢎⠪⡪⡎⡗⡕⡇⣽⢺⢮⣳⣽⡟⡎⠜⡜⡌⣟⣮⡓\n        ⠀⠀⠀⠀⠀⠀⢣⢳⢝⡞⡼⣝⣞⡮⣗⠡⡫⡪⡊⢮⢝⢜⢜⢜⢷⢽⢽⣺⣟⢽⡘⠌⣞⠸⡵⣳⡓\n        ⠀⠀⠀⠀⠀⠀⢽⢸⡣⣏⡟⣼⣪⢿⢜⠄⡇⡗⡸⣨⢳⢕⢕⢭⢳⢽⢝⣞⣗⡗⡕⢡⢇⢝⢽⣺⡊\n        ⠀⠀⠀⠀⠀⠈⢧⡫⣞⢼⣹⢺⢮⢯⣓⠌⢎⢎⠜⡜⣮⢻⣔⢕⢕⢽⣣⢗⡗⣯⡊⡜⡜⣜⢽⣺⡊\n        ⠀⠀⠀⠀⠀⠘⢼⢜⢮⢳⡳⡽⡽⣧⣓⠨⢣⢣⠣⡣⡗⣽⢺⡪⡪⡺⣜⣗⢽⡗⡆⡪⡪⡪⣗⣗⡇\n        ⠀⠀⠀⠀⠀⠈⡎⣗⡝⡧⣏⡯⣟⣞⢖⢑⢕⢕⢱⢩⡝⣷⢹⢜⢜⡼⣕⣗⣿⣛⢆⢪⠪⡮⣗⣗⣇\n        ⠀⠀⠀⠀⠀⠠⡹⡜⣎⡟⣼⢺⢷⣝⣇⠢⡣⡣⡱⡱⡝⡎⡮⡪⣞⢮⣳⣿⢳⡣⡣⢸⠪⡮⣗⣗⡇\n        ⠀⠀⠀⠀⠀⠀⢇⢯⢧⢯⣳⣫⣟⡞⣖⠡⡣⡣⡪⡪⣇⢇⢧⢻⢼⡝⣾⣻⡳⣝⠔⢕⢕⢽⣺⣺⡪\n        ⠀⠀⠀⠀⠀⠀⢣⢻⢼⡕⣗⣗⣯⢿⣜⠘⡜⡎⡜⡜⣦⢃⢏⢽⢪⣟⢼⢧⣟⢼⠨⢕⢕⢽⣺⡺⣎\n        ⠀⠀⠀⠀⠀⠀⢕⢕⡗⡽⣺⢺⡮⡿⣜⡘⢼⢸⢸⢸⡪⣗⡕⡕⢽⢜⣗⢽⣳⣝⠌⡇⡇⣟⢮⣟⡖\n        ⠀⠀⠀⠀⠀⠀⠘⡕⣝⢽⢺⢽⢯⣟⣎⠆⡝⣜⢸⢸⡪⣗⡗⡇⡧⣹⢪⡗⣷⣳⠡⡣⡣⡫⡿⣼⣓\n        ⠀⠀⠀⠀⠀⠀⠈⢕⢧⡫⣏⢯⣟⡾⣜⢌⢎⢎⢜⢜⢮⣳⢫⡣⡣⡣⣟⣾⣿⢕⢅⢣⢣⢫⡟⣾⡒\n        ⠀⠀⠀⠀⠀⠀⠀⢣⢣⢻⢼⢽⣪⣟⡖⡄⡫⡪⢢⢳⡱⡱⢱⠱⣵⢹⢧⡳⣕⢗⠄⢣⠣⢧⢯⣳⡃\n        ⠀⠀⠀⠀⠀⠀⠀⠀⢝⡜⡮⣳⢳⣣⡓⢌⢜⢢⢡⢣⡣⡫⢧⡻⣜⢽⡚⡞⡮⡪⠨⡘⢌⢗⢧⡓\n        ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠕⣝⢜⢧⣓⠂⢕⣂⠢⡱⢱⢸⢱⢣⡫⣪⢳⢹⢪⢪⡞⣖⠨⠊⠇⠃\n        ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠘⠸⡸⡮⣟⡮⣗⠈⠌⠘⠸⠘⠜⠘⠸⡸⡪⣗⢽⢺\n        ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠙⢮⢯⡗⣯⡳⠀⠀⠀⠀⠀⠀⠀⠀⡇⡗⡷⣝⢷\n        ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡎⣗⢧⡟⣮⡊⠀⠀⠀⠀⠀⠀⠀⠠⡸⢸⢸⢸⢹⡀\n        ⠀⠀⠀⠀⠀⠀⠀⠀⠀⢠⡰⡱⡱⡱⡣⡫⡪⡂⠀⠀⠀⠀⠀⠀⠀⡐⡜⢌⢎⢎⢎⢦⡀\n        ⠀⠀⠀⠀⠀⠀⠀⠀⢠⢣⢯⡞⣼⣸⣸⢪⡪⡆⠀⠀⠀⠀⠀⠀⠨⡪⣎⢮⢮⢮⣳⣳⢳⠄\n        ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠓⠯⢳⢕⠗⡏⠚⠀⠀⠀⠀⠀⠀⠀⠀⠈⠘⠌⠳⠹⠸⠪⠓";
    //   chatChannel.send(hotdog);
    //   const diff = new Date().getTime() - time;
    //   console.info(
    //     `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !hotdog: ${
    //       message.author.username
    //     } - ${diff}ms`
    //   );
    //   reset = true;
    //   return;
    // }

    // if (message.content.toLowerCase().match(EasterEggCustomID.OneMore)) {
    //   chatChannel.send("1more");
    //   const diff = new Date().getTime() - time;
    //   console.info(
    //     `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !1more: ${
    //       message.author.username
    //     } - ${diff}ms`
    //   );
    //   reset = true;
    //   return;
    // }

    // if (message.content.toLowerCase().match(EasterEggCustomID.TwoMore)) {
    //   chatChannel.send("2more");
    //   const diff = new Date().getTime() - time;
    //   console.info(
    //     `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !2more: ${
    //       message.author.username
    //     } - ${diff}ms`
    //   );
    //   reset = true;
    //   return;
    // }

    // if (message.content.toLowerCase().match(EasterEggCustomID.ThreeMore)) {
    //   chatChannel.send("3more");
    //   const diff = new Date().getTime() - time;
    //   console.info(
    //     `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !3more: ${
    //       message.author.username
    //     } - ${diff}ms`
    //   );
    //   reset = true;
    //   return;
    // }

    // if (message.content.toLowerCase().match(EasterEggCustomID.FourMore)) {
    //   chatChannel.send("4more");
    //   const diff = new Date().getTime() - time;
    //   console.info(
    //     `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !4more: ${
    //       message.author.username
    //     } - ${diff}ms`
    //   );
    //   reset = true;
    //   return;
    // }

    // if (message.content.toLowerCase().match(EasterEggCustomID.FiveMore)) {
    //   chatChannel.send("5more");
    //   const diff = new Date().getTime() - time;
    //   console.info(
    //     `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !5more: ${
    //       message.author.username
    //     } - ${diff}ms`
    //   );
    //   reset = true;
    //   return;
    // }

    // if (message.content.toLowerCase().match(EasterEggCustomID.SixMore)) {
    //   chatChannel.send("6more");
    //   const diff = new Date().getTime() - time;
    //   console.info(
    //     `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !6more: ${
    //       message.author.username
    //     } - ${diff}ms`
    //   );
    //   reset = true;
    //   return;
    // }

    // if (message.content.toLowerCase().match(EasterEggCustomID.Duis)) {
    //   chatChannel.send(
    //     // eslint-disable-next-line max-len
    //     "Papa Duis, more like God Duis. Don't even think about queueing up against him because he will ruin you. You think you're good?\nyou think you're good at RL??!?!?!?!?!?!?!?!?!?!?\nfuck no\nyou aren't good.\nyou are shit\nur fkn washed\nYou don't even come close to Duis.\nHe will absolutely ruin you without even looking.\nHis monitor is off 90 percent of the time, eyes closed too. Never doubt the Duis, bitch."
    //   );
    //   const diff = new Date().getTime() - time;
    //   console.info(
    //     `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !duis: ${
    //       message.author.username
    //     } - ${diff}ms`
    //   );
    //   reset = true;
    //   return;
    // }

    // if (message.content.toLowerCase().match(EasterEggCustomID.Sad)) {
    //   chatChannel.send("This is so sad :frowning: in the chat pls.");
    //   const diff = new Date().getTime() - time;
    //   console.info(
    //     `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !sad: ${
    //       message.author.username
    //     } - ${diff}ms`
    //   );
    //   reset = true;
    //   return;
    // }

    // if (message.content.toLowerCase().match(EasterEggCustomID.Oops)) {
    //   chatChannel.send("I didn't think the queue would pop...");
    //   const diff = new Date().getTime() - time;
    //   console.info(
    //     `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !oops: ${
    //       message.author.username
    //     } - ${diff}ms`
    //   );
    //   reset = true;
    //   return;
    // }

    // if (message.content.toLowerCase().match(EasterEggCustomID.H)) {
    //   chatChannel.send("h");
    //   const diff = new Date().getTime() - time;
    //   console.info(
    //     `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !h: ${
    //       message.author.username
    //     } - ${diff}ms`
    //   );
    //   reset = true;
    //   return;
    // }

    // if (message.content.toLowerCase().match(EasterEggCustomID.Fuck)) {
    //   chatChannel.send("u");
    //   const diff = new Date().getTime() - time;
    //   console.info(
    //     `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !fuck: ${
    //       message.author.username
    //     } - ${diff}ms`
    //   );
    //   reset = true;
    //   return;
    // }

    // if (message.content.toLowerCase().match(EasterEggCustomID.Troll)) {
    //   const userMessage = message.content;
    //   let newMessage = "";
    //   if (message.content.length > 6) {
    //     for (let i = 6; i < userMessage.length; i++) {
    //       if (i % 2) {
    //         newMessage = newMessage + userMessage.charAt(i).toUpperCase();
    //       } else {
    //         newMessage = newMessage + userMessage.charAt(i).toLowerCase();
    //       }
    //     }
    //     chatChannel.send(newMessage);
    //   }
    //   const diff = new Date().getTime() - time;
    //   console.info(
    //     `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !troll: ${
    //       message.author.username
    //     } - ${diff}ms`
    //   );
    //   reset = true;
    //   return;
    // }

    // if (message.content.toLowerCase().match(EasterEggCustomID.Coinflip)) {
    //   const num = Math.random();
    //   if (num == 1) {
    //     chatChannel.send("Coin Flip: Heads!");
    //   } else {
    //     chatChannel.send("Coin Flip: Tails!");
    //   }
    //   const diff = new Date().getTime() - time;
    //   console.info(
    //     `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !troll: ${
    //       message.author.username
    //     } - ${diff}ms`
    //   );
    //   reset = true;
    //   return;
    // }
  }
}

export async function registerEasterEggsSlashCommands(clientId: string, guildId: string, token: string) {
  const rest = new REST({ version: "9" }).setToken(token);

  const norm = new SlashCommandBuilder()
    .setName(EasterEggSlashCommands.Norm)
    .setDescription("Ask Norm anything.")
    .addStringOption((opt) => opt.setName("prompt").setDescription("What do you want to say?").setRequired(true))
    .addAttachmentOption((opt) => opt.setName("image1").setDescription("Optional image 1"))
    .addAttachmentOption((opt) => opt.setName("image2").setDescription("Optional image 2"))
    .addAttachmentOption((opt) => opt.setName("image3").setDescription("Optional image 3"))
    .toJSON();

  const sora = new SlashCommandBuilder()
    .setName(EasterEggSlashCommands.Sora)
    .setDescription("Generate a short video with Sora.")
    .addStringOption((opt) => opt.setName("prompt").setDescription("Video Prompt").setRequired(true))
    .addIntegerOption((opt) =>
      opt
        .setName("duration")
        .setDescription("Duration in seconds (1-10)")
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(10)
    )
    .toJSON();

  const commands: Array<RESTPostAPIApplicationCommandsJSONBody> = [norm, sora];
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
}

export async function handleEasterEggsInteraction(interaction: CommandInteraction, openai: OpenAI): Promise<void> {
  if (!interaction.isChatInputCommand()) return;

  switch (interaction.commandName) {
    case EasterEggSlashCommands.Norm: {
      const started = Date.now();
      await interaction.deferReply();

      const prompt = interaction.options.get("prompt")?.value as string;
      const attachments = [
        interaction.options.getAttachment("image1"),
        interaction.options.getAttachment("image2"),
        interaction.options.getAttachment("image3"),
      ].filter(Boolean) as Array<NonNullable<ReturnType<typeof interaction.options.getAttachment>>>;

      await enqueueNormTask(async () => {
        try {
          const now = new Date();
          const year = now.getFullYear();
          const month = now.getMonth();
          const day = now.getDate();
          const hour = now.getHours();
          const min = now.getMinutes();
          const sec = now.getSeconds();
          const mil = now.getMilliseconds();

          console.info(
            `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Slash /norm: ${interaction.user.username}`
          );

          const imageUrls = attachments
            .filter((a) => a.contentType?.startsWith("image/"))
            .map((a) => a.url)
            .slice(0, 3);

          const tokenLimit = process.env["conversation_token_limit"];
          let convo;
          let conversationIDLocal = loadConversationId();
          if (conversationIDLocal) {
            try {
              convo = await openai.conversations.retrieve(conversationIDLocal);
            } catch (e) {
              console.info("\nConversation not found - Creating a new conversation.");
              convo = await openai.conversations.create({
                items: [
                  {
                    content: systemMessage,
                    role: "system",
                    type: "message",
                  },
                ],
              });
              conversationIDLocal = convo.id;
              saveConversationId(conversationIDLocal);
              console.warn("Created new OpenAI conversation and saved to .conversation_id.");
            }
          } else {
            convo = await openai.conversations.create({
              items: [
                {
                  content: systemMessage,
                  role: "system",
                  type: "message",
                },
              ],
            });
            conversationIDLocal = convo.id;
            saveConversationId(conversationIDLocal);
            console.warn("Created new OpenAI conversation and saved to .conversation_id.");
          }

          let completion;
          try {
            if (imageUrls.length > 0) {
              completion = await openai.responses.create({
                conversation: convo.id,
                input: [
                  {
                    content: [
                      { text: `${interaction.user.id} ${interaction.user.username}: ${prompt}`, type: "input_text" },
                      ...imageUrls.map((u) => ({
                        detail: "auto" as const,
                        image_url: u,
                        type: "input_image" as const,
                      })),
                    ],
                    role: "user",
                  },
                ],
                model: "gpt-5",
                parallel_tool_calls: true,
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
              });
            } else {
              completion = await openai.responses.create({
                conversation: convo.id,
                input: `${interaction.user.id} ${interaction.user.username}: ${prompt}`,
                model: "gpt-5",
                parallel_tool_calls: true,
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
              });
            }
          } catch (err: unknown) {
            const e = err as {
              status?: number;
              code?: string;
              message?: string;
              response?: { status?: number; data?: { error?: { code?: string; message?: string } } };
            };
            const status = e?.status ?? e?.response?.status;
            const code = e?.code ?? e?.response?.data?.error?.code;
            const msg = e?.message ?? e?.response?.data?.error?.message ?? "Unknown error";
            console.error(`OpenAI responses.create failed (${status || "no-status"} ${code || ""}): ${msg}`);
            await interaction.editReply(
              `<@${interaction.user.id}> I couldn't reach OpenAI right now. Please try again in a bit.`
            );
            return;
          }

          const imageOutputs = Array.isArray(completion?.output)
            ? completion.output.filter((o) => o.type == "image_generation_call")
            : [];

          if (imageOutputs && imageOutputs.length > 0) {
            const files: { attachment: string }[] = [];
            let count = 0;
            for (const image of imageOutputs) {
              if (count >= 4) break;
              const image_base64 = image?.result;
              if (image_base64 && image_base64.length > 0) {
                const imageFile = path.join(
                  __dirname,
                  `../images/${interaction.user.username}-${Date.now()}-${count}.png`
                );
                fs.writeFileSync(imageFile, Buffer.from(image_base64, "base64"));
                files.push({ attachment: imageFile });
                count++;
              }
            }
            const text = (completion?.output_text || "").trim();
            const chunks = text ? chunkMessage(text) : [];
            if (files.length > 0 || chunks.length > 0) {
              await interaction.editReply({ content: chunks.shift() ?? undefined, files });
              for (const part of chunks) await interaction.followUp(part);
            }
          }

          const reply = (completion?.output_text || "").trim();
          if (reply) {
            const parts = chunkMessage(reply);
            if (parts.length > 0) {
              await interaction.editReply(parts.shift() as string);
              for (const p of parts) await interaction.followUp(p);
            }
          }

          const tokenLimitNumber = Number(tokenLimit ?? 0);
          const totalTokens = completion?.usage?.total_tokens ?? 0;

          try {
            if (completion && tokenLimitNumber > 0 && totalTokens >= tokenLimitNumber) {
              const newConvo = await openai.conversations.create({
                items: [{ content: systemMessage, role: "system", type: "message" }],
              });
              saveConversationId(newConvo.id);
              console.warn(
                `Input tokens (${totalTokens}) reached limit (${tokenLimitNumber}). Started new conversation and saved to .conversation_id.`
              );
              await interaction.followUp(
                "I've wiped my memory to limit contextual input, in order to keep costs lower."
              );
            }
          } catch (rotErr) {
            console.error("Failed to rotate conversation after token check:", rotErr);
          }

          const toolsUsed = Array.isArray(completion?.output)
            ? completion.output
                .filter((o) => typeof o?.type === "string" && o.type.endsWith("_call"))
                .map((o) => o.type.replace("_call", ""))
                .join(", ") || "None"
            : "None";
          const diff = Date.now() - started;
          console.info(
            `Tools: ${toolsUsed}\n` +
              `Tokens: ${totalTokens} / ${tokenLimitNumber}\n || ${Math.round((totalTokens / tokenLimitNumber) * 100)}%\n` +
              `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Slash /norm: ${
                interaction.user.username
              } - ${diff}ms`
          );
        } catch (err: unknown) {
          const e = err as {
            status?: number;
            message?: string;
            response?: { status?: number; data?: { error?: { message?: string } } };
          };
          const status = e?.status ?? e?.response?.status;
          const msg = e?.message ?? e?.response?.data?.error?.message ?? String(err);
          console.error(`/norm handler error (${status || "no-status"}):`, msg);
          try {
            await interaction.editReply(
              `<@${interaction.user.id}> Something went wrong handling your request. Please try again later.`
            );
          } catch (notifyErr) {
            console.error("Failed to notify about error:", notifyErr);
          }
        }
      });

      break;
    }
    case EasterEggSlashCommands.Sora: {
      await interaction.deferReply();
      const now = new Date();
      const year = now.getFullYear();
      const month = now.getMonth();
      const day = now.getDate();
      const hour = now.getHours();
      const min = now.getMinutes();
      const sec = now.getSeconds();
      const mil = now.getMilliseconds();

      console.info(
        `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Slash /sora: ${interaction.user.username}`
      );

      try {
        const prompt = interaction.options.getString("prompt");
        const durationOpt = interaction.options.getInteger("duration") ?? 10;
        const duration = Math.max(1, Math.min(10, durationOpt));

        if (!prompt) {
          await interaction.editReply(`<@${interaction.user.id}> prompt was empty.`);
          return;
        }

        let completion = await openai.videos.create({ model: "sora-2", prompt });
        while (completion.status === "in_progress" || completion.status === "queued") {
          completion = await openai.videos.retrieve(completion.id);
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }

        if (completion.status === "failed") {
          await interaction.editReply(`<@${interaction.user.id}> I couldn't create a video right now.`);
          return;
        }

        const vid = await openai.videos.downloadContent(completion.id);
        if (!vid) {
          await interaction.editReply(`<@${interaction.user.id}> I couldn't create a video right now.`);
          return;
        }
        const body = await vid.arrayBuffer();
        const buffer = Buffer.from(body);
        const filePath = path.join(__dirname, `../recordings/${interaction.user.username}-${Date.now()}-sora.mp4`);
        fs.writeFileSync(filePath, buffer);

        const cost = (duration * 0.1).toFixed(2);
        await interaction.editReply({
          content: `<@${interaction.user.id}> Estimated cost: $${cost}.`,
          files: [{ attachment: filePath }],
        });

        const diff = Date.now() - now.getTime();
        console.info(
          `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Slash /sora: ${interaction.user.username} - ${diff}ms`
        );
      } catch (err) {
        console.error("/sora error:", err);
        await interaction.editReply(`<@${interaction.user.id}> I couldn't generate the video. Please try again later.`);
      }
      break;
    }
  }
}
