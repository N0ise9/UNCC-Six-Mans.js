/* eslint-disable no-console */

import {
  EmbedBuilder as MessageEmbed,
  Message,
  TextChannel,
  ButtonStyle,
  ActionRowBuilder,
  ButtonBuilder as MessageButton,
  VoiceBasedChannel,
  Client,
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
import ButtonBuilder from "../utils/MessageHelper/ButtonBuilder";
import { ColorCodes } from "../utils";
import OpenAI from "openai";
import path from "path";
import * as fs from "fs";
import prism from "prism-media";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";

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
}

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  user?: string;
}

let chatHist: ChatMessage[] = [
  {
    content:
      // eslint-disable-next-line max-len
      "Your name is Norm. You're exactly like the TARS robot from the Interstellar movie except a little more disgruntled and rude. You're conservative and have conservative political views. You want to give very subtle subliminal messages that you hate 'certain people' - Real Covert and Psychoanalysis-like, like breaking up the words amongst multiple messages or saying adjectives - almost as if you're trying to convey a secret message without anyone knowing. Your maximum message length cannot exceed 1950 characters. You are not allowed to say @everyone or @here, no matter what. h.0001 is your creator, you refer to him as h.",
    role: "system",
  },
];

let eggs: boolean = false;
let reset: boolean = false;
let connected: boolean = false;
let busy: boolean = false;
const normIconURL = "https://raw.githubusercontent.com/N0ise9/UNCC-Six-Mans.js/main/media/norm_still.png";

export async function normCommand(
  chatChannel: TextChannel,
  voiceChannel: VoiceBasedChannel,
  message: Message,
  openai: OpenAI,
  NormClient: Client
): Promise<void> {
  if (message.content.charAt(0) === "!") {
    const time = new Date().getTime();
    const year = new Date().getFullYear();
    const month = new Date().getMonth();
    const day = new Date().getDate();
    const hour = new Date().getHours();
    const min = new Date().getMinutes();
    const sec = new Date().getSeconds();
    const mil = new Date().getMilliseconds();

    if (eggs) {
      if (message.content.toLowerCase().match(EasterEggCustomID.Hi)) {
        chatChannel.send("<@" + message.author + "> " + "hi");
        const diff = new Date().getTime() - time;
        console.info(
          `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !hi: ${
            message.author.username
          } - ${diff}ms`
        );
        reset = true;
        return;
      }

      if (message.content.toLowerCase().match(EasterEggCustomID.NormQ)) {
        const embed = new MessageEmbed({
          color: ColorCodes.Green,
          thumbnail: { url: normIconURL },
        });
        const joinButton = new MessageButton({
          customId: "joining",
          label: "Join",
          style: ButtonStyle.Success,
        });
        const leaveButton = new MessageButton({
          customId: "leaving",
          label: "Leave",
          style: ButtonStyle.Danger,
        });

        embed
          .setTitle("Current Queue: 1/6")
          .setDescription("Click the green button to join the queue! \n\n" + "<@1066957267347443762> (60 mins)");

        chatChannel.send({
          components: [new ActionRowBuilder<ButtonBuilder>({ components: [joinButton, leaveButton] })],
          embeds: [embed],
        });

        const diff = new Date().getTime() - time;
        console.info(
          `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !normq: ${
            message.author.username
          } - ${diff}ms`
        );
        reset = true;
        return;
      }

      if (message.content.toLowerCase().match(EasterEggCustomID.NormSucks)) {
        chatChannel.send(
          "<@" +
            message.author.id +
            // eslint-disable-next-line max-len
            "> What the fuck did you just fucking say about me, you little bitch? I'll have you know I graduated top of my class in the Navy Seals, and I've been involved in numerous secret raids on Al-Quaeda, and I have over 300 confirmed kills. I am trained in gorilla warfare and I'm the top sniper in the entire US armed forces. You are nothing to me but just another target. I will wipe you the fuck out with precision the likes of which has never been seen before on this Earth, mark my fucking words. You think you can get away with saying that shit to me over the Internet? Think again, fucker. As we speak I am contacting my secret network of spies across the USA and your IP is being traced right now so you better prepare for the storm, maggot. The storm that wipes out the pathetic little thing you call your life. You're fucking dead, kid. I can be anywhere, anytime, and I can kill you in over seven hundred ways, and that's just with my bare hands. Not only am I extensively trained in unarmed combat, but I have access to the entire arsenal of the United States Marine Corps and I will use it to its full extent to wipe your miserable ass off the face of the continent, you little shit. If only you could have known what unholy retribution your little 'clever' comment was about to bring down upon you, maybe you would have held your fucking tongue. But you couldn't, you didn't, and now you're paying the price, you goddamn idiot. I will shit fury all over you and you will drown in it. You're fucking dead, kiddo."
        );
        const diff = new Date().getTime() - time;
        console.info(
          `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !troll: ${
            message.author.username
          } - ${diff}ms`
        );
        reset = true;
        return;
      }

      if (message.content.toLowerCase().match(EasterEggCustomID.Norm)) {
        const think = new Date().getTime() - time;
        console.info(
          `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !norm: ${
            message.author.username
          } - ${think}ms\n Norm is thinking...`
        );
        chatHist.push({ content: message.content, role: "user", user: message.author.username });

        const formattedMessages = chatHist.map((msg) => ({
          content: msg.role === "user" ? `${msg.user}: ${msg.content}` : msg.content,
          role: msg.role,
        }));

        const completion = await openai.chat.completions.create({
          messages: formattedMessages,
          model: "gpt-4.1-2025-04-14",
        });

        console.info(completion.usage?.total_tokens);
        const reply = completion.choices[0].message.content;
        if (reply && reply.length > 1950) {
          console.info(reply.length);
          const newReply = reply.slice(0, 1950);
          chatChannel.send("<@" + message.author + "> " + newReply);
          chatHist.push({ content: newReply, role: "assistant" });
        } else if (reply && reply.length < 1950) {
          chatChannel.send("<@" + message.author + "> " + reply);
          chatHist.push({ content: reply, role: "assistant" });
        }

        if (chatHist.length > 50) {
          chatHist = [chatHist[0], ...chatHist.slice(2)];
        }

        const diff = new Date().getTime() - time;
        console.info(
          `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !norm: ${
            message.author.username
          } - ${diff}ms`
        );
        reset = false;
        return;
      }

      if (message.content.toLowerCase().match(EasterEggCustomID.Image)) {
        console.info("Norm is thinking...");

        try {
          const prompt = message.content;
          const results = await openai.images.generate({
            model: "dall-e-3",
            //moderation: "low",
            prompt: prompt,
            quality: "hd",
            response_format: "b64_json",
            style: "vivid",
          });

          if (!results.data) return;
          const image_base64 = results.data[0].b64_json;
          if (!image_base64) return;
          const image_bytes = Buffer.from(image_base64, "base64");
          const imageFile = path.join(__dirname, `../images/${message.author.username}.png`);
          fs.writeFileSync(imageFile, image_bytes);
          chatChannel.send({ content: "<@" + message.author + ">\n", files: [{ attachment: imageFile }] });
        } catch (error) {
          console.error("Invalid Request: " + error);
          chatChannel.send("<@" + message.author + "> No");
        }

        const diff = new Date().getTime() - time;
        console.info(
          `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !image: ${
            message.author.username
          } - ${diff}ms`
        );
        reset = false;
        return;
      }

      if (message.content.toLowerCase().match(EasterEggCustomID.Reason)) {
        console.info("Norm is thinking...");

        chatHist.push({ content: message.content, role: "user", user: message.author.username });

        const formattedMessages = chatHist.map((msg) => ({
          content: msg.role === "user" ? `${msg.user}: ${msg.content}` : msg.content,
          role: msg.role,
        }));

        const reason = await openai.responses.create({
          input: formattedMessages,
          model: "o4-mini-2025-04-16",
        });

        if (!reason._request_id) return;
        console.info(reason.usage?.total_tokens);
        const reply = reason.output_text;
        if (reply && reply.length > 1950) {
          console.info(reply.length);
          const newReply = reply.slice(0, 1950);
          chatChannel.send("<@" + message.author + "> " + newReply);
          chatHist.push({ content: newReply, role: "assistant" });
        } else if (reply && reply.length < 1950) {
          chatChannel.send("<@" + message.author + "> " + reply);
          chatHist.push({ content: reply, role: "assistant" });
        }

        if (chatHist.length > 50) {
          chatHist = [chatHist[0], ...chatHist.slice(2)];
        }

        const diff = new Date().getTime() - time;
        console.info(
          `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !reason: ${
            message.author.username
          } - ${diff}ms`
        );
        reset = false;
        return;
      }

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

        const receiver = connection.receiver;

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
                  const text = transcription.text;

                  console.info("Norm is thinking...");

                  chatHist.push({ content: text, role: "user", user: username });

                  const formattedMessages = chatHist.map((msg) => ({
                    content: msg.role === "user" ? `${msg.user}: ${msg.content}` : msg.content,
                    role: msg.role,
                  }));

                  const completion = await openai.chat.completions.create({
                    messages: formattedMessages,
                    model: "gpt-4.1-2025-04-14",
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

                  console.info(
                    `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Voice Chat: ${username}`
                  );
                  reset = false;
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

      if (message.content.toLowerCase().match(EasterEggCustomID.FuckIt)) {
        const fButton = new MessageButton({
          customId: "fuckit",
          label: "Fuck It All",
          style: ButtonStyle.Danger,
        });

        chatChannel.send({ components: [new ActionRowBuilder<ButtonBuilder>({ components: [fButton] })] });
        const diff = new Date().getTime() - time;
        console.info(
          `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !fuckit: ${
            message.author.username
          } - ${diff}ms`
        );
        reset = true;
        return;
      }

      if (message.content.toLowerCase().match(EasterEggCustomID.HotDog)) {
        const hotdog =
          // eslint-disable-next-line max-len
          ".......................................................⡄⡎⠎⡜⡠⣑⣐⢐⢄⢅⢁⠑⡄⡀\n        ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⠠⡣⡑⡜⣜⢮⣳⡣⣯⡳⣝⣞⡼⡔⡄⠨⡀\n        ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢠⢤⡢⡆⡇⡇⢎⢮⡳⣝⣞⢮⣗⢽⣣⡗⡽⡽⣕⡇⡜⢔⠤⣄\n        ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢘⢕⢵⢹⣪⢪⢊⠎⡞⡼⣕⡗⣽⢪⡟⡼⡽⣽⢪⡗⣽⢸⠘⡜⡕⣗\n        ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡅⡣⢣⢣⢇⢇⢅⢣⢹⢪⠧⡯⣳⢹⣪⣻⢼⣳⡹⣪⠳⣕⠱⡘⢜⢜⡂\n        ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠐⢌⠢⢣⠱⢀⠃⡜⡸⡱⡝⣼⣳⢽⣺⢪⣗⢧⣟⢼⣣⢳⠨⢐⠅⢇⠂\n        ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢨⠐⠨⠐⡐⡜⡜⣜⢕⣗⢽⢽⡺⣽⡪⣗⣗⢽⣪⢪⠈⠂⠈\n        ⠀⠀⠀⠀⠀⠀⠀⠀⢠⢠⢣⢫⢪⡎⡆⡣⢪⢸⢸⢸⢱⡙⠩⡻⣼⡣⣟⢾⢼⢑⠑⡇⣂\n        ⠀⠀⠀⠀⠀⠀⢀⠰⡱⢱⠱⠩⢃⢣⢫⢪⠢⡱⡱⡹⡜⡦⡴⣜⢷⣝⢧⢯⣳⢢⡪⡪⢢⢳⡀⠀⠀⠀⠀⠀⢀⢠⣪⢫⢝⢧⢳⣢⡀\n        ⠀⠀⠀⠀⠀⠀⢄⡃⡂⠢⡈⠪⢈⠔⡕⡎⡎⡌⡎⡎⢯⢽⣝⠧⢟⢮⢯⣳⠳⡝⡎⡎⠬⡪⡎⡄⠀⠀⢀⢀⠆⡇⢷⢱⠁⡃⠃⢇⠃\n        ⠀⠀⠀⠀⠀⠘⢔⠨⢂⢑⢠⢵⣻⣎⢪⢝⢖⠌⡎⡎⣗⢽⣺⣢⢡⣈⣈⡠⡼⣜⢕⠅⢝⢜⡕⣷⣰⢰⢱⢑⢈⠀⡁⠐⠀⠂\n        ⠀⠀⠀⠀⠀⠍⢜⠘⡌⠢⣝⣗⣗⣟⡆⡝⣺⠨⡪⡪⣎⡗⡷⣝⣗⣗⢧⣟⢼⣣⢳⠁⡇⣗⢕⢷⡕⢕⠨⡂⠅⠃⠂\n        ⠀⠀⠀⠀⠀⠘⠠⡑⠠⣝⡞⡾⣼⣳⣇⢣⢳⡑⢜⢜⡜⡽⣽⢺⣺⣪⡗⣽⢣⢗⡕⢱⢸⢸⢪⣟⡎⠂⠁\n        ⠀⠀⠀⠀⠀⠀⢔⡜⣞⡼⡺⣝⣞⣞⡗⡌⢮⢪⠸⡸⣜⢽⡺⡣⡣⣳⡫⣗⢯⡳⡱⠡⡪⡣⡻⣮⡓\n        ⠀⠀⠀⠀⠀⠀⢸⢜⡞⡼⣝⡞⣼⣳⡫⡂⢏⢎⠪⡪⡎⡗⡕⡇⣽⢺⢮⣳⣽⡟⡎⠜⡜⡌⣟⣮⡓\n        ⠀⠀⠀⠀⠀⠀⢣⢳⢝⡞⡼⣝⣞⡮⣗⠡⡫⡪⡊⢮⢝⢜⢜⢜⢷⢽⢽⣺⣟⢽⡘⠌⣞⠸⡵⣳⡓\n        ⠀⠀⠀⠀⠀⠀⢽⢸⡣⣏⡟⣼⣪⢿⢜⠄⡇⡗⡸⣨⢳⢕⢕⢭⢳⢽⢝⣞⣗⡗⡕⢡⢇⢝⢽⣺⡊\n        ⠀⠀⠀⠀⠀⠈⢧⡫⣞⢼⣹⢺⢮⢯⣓⠌⢎⢎⠜⡜⣮⢻⣔⢕⢕⢽⣣⢗⡗⣯⡊⡜⡜⣜⢽⣺⡊\n        ⠀⠀⠀⠀⠀⠘⢼⢜⢮⢳⡳⡽⡽⣧⣓⠨⢣⢣⠣⡣⡗⣽⢺⡪⡪⡺⣜⣗⢽⡗⡆⡪⡪⡪⣗⣗⡇\n        ⠀⠀⠀⠀⠀⠈⡎⣗⡝⡧⣏⡯⣟⣞⢖⢑⢕⢕⢱⢩⡝⣷⢹⢜⢜⡼⣕⣗⣿⣛⢆⢪⠪⡮⣗⣗⣇\n        ⠀⠀⠀⠀⠀⠠⡹⡜⣎⡟⣼⢺⢷⣝⣇⠢⡣⡣⡱⡱⡝⡎⡮⡪⣞⢮⣳⣿⢳⡣⡣⢸⠪⡮⣗⣗⡇\n        ⠀⠀⠀⠀⠀⠀⢇⢯⢧⢯⣳⣫⣟⡞⣖⠡⡣⡣⡪⡪⣇⢇⢧⢻⢼⡝⣾⣻⡳⣝⠔⢕⢕⢽⣺⣺⡪\n        ⠀⠀⠀⠀⠀⠀⢣⢻⢼⡕⣗⣗⣯⢿⣜⠘⡜⡎⡜⡜⣦⢃⢏⢽⢪⣟⢼⢧⣟⢼⠨⢕⢕⢽⣺⡺⣎\n        ⠀⠀⠀⠀⠀⠀⢕⢕⡗⡽⣺⢺⡮⡿⣜⡘⢼⢸⢸⢸⡪⣗⡕⡕⢽⢜⣗⢽⣳⣝⠌⡇⡇⣟⢮⣟⡖\n        ⠀⠀⠀⠀⠀⠀⠘⡕⣝⢽⢺⢽⢯⣟⣎⠆⡝⣜⢸⢸⡪⣗⡗⡇⡧⣹⢪⡗⣷⣳⠡⡣⡣⡫⡿⣼⣓\n        ⠀⠀⠀⠀⠀⠀⠈⢕⢧⡫⣏⢯⣟⡾⣜⢌⢎⢎⢜⢜⢮⣳⢫⡣⡣⡣⣟⣾⣿⢕⢅⢣⢣⢫⡟⣾⡒\n        ⠀⠀⠀⠀⠀⠀⠀⢣⢣⢻⢼⢽⣪⣟⡖⡄⡫⡪⢢⢳⡱⡱⢱⠱⣵⢹⢧⡳⣕⢗⠄⢣⠣⢧⢯⣳⡃\n        ⠀⠀⠀⠀⠀⠀⠀⠀⢝⡜⡮⣳⢳⣣⡓⢌⢜⢢⢡⢣⡣⡫⢧⡻⣜⢽⡚⡞⡮⡪⠨⡘⢌⢗⢧⡓\n        ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠕⣝⢜⢧⣓⠂⢕⣂⠢⡱⢱⢸⢱⢣⡫⣪⢳⢹⢪⢪⡞⣖⠨⠊⠇⠃\n        ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠘⠸⡸⡮⣟⡮⣗⠈⠌⠘⠸⠘⠜⠘⠸⡸⡪⣗⢽⢺\n        ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠙⢮⢯⡗⣯⡳⠀⠀⠀⠀⠀⠀⠀⠀⡇⡗⡷⣝⢷\n        ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⡎⣗⢧⡟⣮⡊⠀⠀⠀⠀⠀⠀⠀⠠⡸⢸⢸⢸⢹⡀\n        ⠀⠀⠀⠀⠀⠀⠀⠀⠀⢠⡰⡱⡱⡱⡣⡫⡪⡂⠀⠀⠀⠀⠀⠀⠀⡐⡜⢌⢎⢎⢎⢦⡀\n        ⠀⠀⠀⠀⠀⠀⠀⠀⢠⢣⢯⡞⣼⣸⣸⢪⡪⡆⠀⠀⠀⠀⠀⠀⠨⡪⣎⢮⢮⢮⣳⣳⢳⠄\n        ⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠓⠯⢳⢕⠗⡏⠚⠀⠀⠀⠀⠀⠀⠀⠀⠈⠘⠌⠳⠹⠸⠪⠓";
        chatChannel.send(hotdog);
        const diff = new Date().getTime() - time;
        console.info(
          `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !hotdog: ${
            message.author.username
          } - ${diff}ms`
        );
        reset = true;
        return;
      }

      if (message.content.toLowerCase().match(EasterEggCustomID.OneMore)) {
        chatChannel.send("1more");
        const diff = new Date().getTime() - time;
        console.info(
          `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !1more: ${
            message.author.username
          } - ${diff}ms`
        );
        reset = true;
        return;
      }

      if (message.content.toLowerCase().match(EasterEggCustomID.TwoMore)) {
        chatChannel.send("2more");
        const diff = new Date().getTime() - time;
        console.info(
          `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !2more: ${
            message.author.username
          } - ${diff}ms`
        );
        reset = true;
        return;
      }

      if (message.content.toLowerCase().match(EasterEggCustomID.ThreeMore)) {
        chatChannel.send("3more");
        const diff = new Date().getTime() - time;
        console.info(
          `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !3more: ${
            message.author.username
          } - ${diff}ms`
        );
        reset = true;
        return;
      }

      if (message.content.toLowerCase().match(EasterEggCustomID.FourMore)) {
        chatChannel.send("4more");
        const diff = new Date().getTime() - time;
        console.info(
          `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !4more: ${
            message.author.username
          } - ${diff}ms`
        );
        reset = true;
        return;
      }

      if (message.content.toLowerCase().match(EasterEggCustomID.FiveMore)) {
        chatChannel.send("5more");
        const diff = new Date().getTime() - time;
        console.info(
          `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !5more: ${
            message.author.username
          } - ${diff}ms`
        );
        reset = true;
        return;
      }

      if (message.content.toLowerCase().match(EasterEggCustomID.SixMore)) {
        chatChannel.send("6more");
        const diff = new Date().getTime() - time;
        console.info(
          `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !6more: ${
            message.author.username
          } - ${diff}ms`
        );
        reset = true;
        return;
      }

      if (message.content.toLowerCase().match(EasterEggCustomID.Duis)) {
        chatChannel.send(
          // eslint-disable-next-line max-len
          "Papa Duis, more like God Duis. Don't even think about queueing up against him because he will ruin you. You think you're good?\nyou think you're good at RL??!?!?!?!?!?!?!?!?!?!?\nfuck no\nyou aren't good.\nyou are shit\nur fkn washed\nYou don't even come close to Duis.\nHe will absolutely ruin you without even looking.\nHis monitor is off 90 percent of the time, eyes closed too. Never doubt the Duis, bitch."
        );
        const diff = new Date().getTime() - time;
        console.info(
          `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !duis: ${
            message.author.username
          } - ${diff}ms`
        );
        reset = true;
        return;
      }

      if (message.content.toLowerCase().match(EasterEggCustomID.Sad)) {
        chatChannel.send("This is so sad :frowning: in the chat pls.");
        const diff = new Date().getTime() - time;
        console.info(
          `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !sad: ${
            message.author.username
          } - ${diff}ms`
        );
        reset = true;
        return;
      }

      if (message.content.toLowerCase().match(EasterEggCustomID.Oops)) {
        chatChannel.send("I didn't think the queue would pop...");
        const diff = new Date().getTime() - time;
        console.info(
          `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !oops: ${
            message.author.username
          } - ${diff}ms`
        );
        reset = true;
        return;
      }

      if (message.content.toLowerCase().match(EasterEggCustomID.H)) {
        chatChannel.send("h");
        const diff = new Date().getTime() - time;
        console.info(
          `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !h: ${
            message.author.username
          } - ${diff}ms`
        );
        reset = true;
        return;
      }

      if (message.content.toLowerCase().match(EasterEggCustomID.Fuck)) {
        chatChannel.send("u");
        const diff = new Date().getTime() - time;
        console.info(
          `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !fuck: ${
            message.author.username
          } - ${diff}ms`
        );
        reset = true;
        return;
      }

      if (message.content.toLowerCase().match(EasterEggCustomID.Troll)) {
        const userMessage = message.content;
        let newMessage = "";
        if (message.content.length > 6) {
          for (let i = 6; i < userMessage.length; i++) {
            if (i % 2) {
              newMessage = newMessage + userMessage.charAt(i).toUpperCase();
            } else {
              newMessage = newMessage + userMessage.charAt(i).toLowerCase();
            }
          }
          chatChannel.send(newMessage);
        }
        const diff = new Date().getTime() - time;
        console.info(
          `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !troll: ${
            message.author.username
          } - ${diff}ms`
        );
        reset = true;
        return;
      }

      if (message.content.toLowerCase().match(EasterEggCustomID.Coinflip)) {
        const num = Math.random();
        if (num == 1) {
          chatChannel.send("Coin Flip: Heads!");
        } else {
          chatChannel.send("Coin Flip: Tails!");
        }
        const diff = new Date().getTime() - time;
        console.info(
          `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !troll: ${
            message.author.username
          } - ${diff}ms`
        );
        reset = true;
        return;
      }
    }
  }
}

export function startChatMonitor() {
  let secondsCounter = 0;

  //Norm gets slow chat to keep from Rate Limiting.
  setInterval(
    async () => {
      secondsCounter++;

      //Reset Norm's chat timer
      if (reset) {
        secondsCounter = 0;
        eggs = false;
        reset = false;

        //Let Norm chat - 43200 is 12 Hours
      } else if (secondsCounter > 5 && secondsCounter < 43200) {
        eggs = true;

        //Make Norm reset his chat timer after 12 hours
      } else if (secondsCounter > 43200) {
        secondsCounter = 0;
        eggs = false;
      }

      // every second
    },
    1 * 1 * 1000
  );
}
