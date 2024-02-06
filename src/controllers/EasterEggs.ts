/* eslint-disable no-console */

import {
  EmbedBuilder as MessageEmbed,
  Message,
  TextChannel,
  ButtonStyle,
  ActionRowBuilder,
  ButtonBuilder as MessageButton,
} from "discord.js";
import ButtonBuilder from "../utils/MessageHelper/ButtonBuilder";
import { ColorCodes } from "../utils";
import OpenAI from "openai";
import { ChatCompletionMessageParam } from "openai/resources";

const enum EasterEggCustomID {
  Hi = "!hi",
  Norm = "!norm",
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

const chatHist: Array<ChatCompletionMessageParam> = [
  { content: "Your name is Norm, and you're very funny.", role: "system" },
];
let eggs: boolean = false;
let reset: boolean = false;
const normIconURL = "https://raw.githubusercontent.com/N0ise9/UNCC-Six-Mans.js/main/media/norm_still.png";

export async function normCommand(chatChannel: TextChannel, message: Message, openai: OpenAI): Promise<void> {
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
        chatHist.push({ content: message.content, role: "user" });
        const completion = await openai.chat.completions.create({
          messages: chatHist,
          model: "gpt-3.5-turbo",
        });

        console.info(completion.usage);
        const reply = completion.choices[0].message.content;
        if (reply && reply.length > 1900) {
          console.info(reply.length);
          const newReply = reply.slice(0, 1900);
          chatChannel.send("<@" + message.author + "> " + newReply);
          chatHist.push({ content: newReply, role: "assistant" });
        } else {
          chatChannel.send("<@" + message.author + "> " + reply);
          chatHist.push({ content: reply, role: "assistant" });
        }

        if (chatHist.length > 300) {
          //Shift twice because two messages are added, user - then assistant
          chatHist.shift();
          chatHist.shift();
        }

        const diff = new Date().getTime() - time;
        console.info(
          `${month + 1}/${day}/${year} - ${hour}:${min}:${sec}:::${mil} | Easter Egg !norm: ${
            message.author.username
          } - ${diff}ms`
        );
        reset = true;
        return;
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
