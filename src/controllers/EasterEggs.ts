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

// const eggCommands: string[] = [
//   "twan",
//   "sad",
//   "smh",
//   "duis",
//   "normq",
//   "teams",
//   "8ball",
//   "fuck",
//   "help",
//   "oops",
//   "h",
//   ":(",
//   "uncc",
//   "norm",
//   "asknorm",
//   "eight_ball",
//   "eightball",
//   "8-ball",
//   "f",
//   "frick",
//   "furry",
//   "don",
//   "daffy",
//   "giddy",
//   "nodought",
//   "coolio",
//   "oops",
//   "flip",
// ];

const enum EasterEggCustomID {
  Hi = "!hi",
  Norm = "!norm",
  NormQ = "!normq",
  FuckIt = "!fuckit",
}

let eggs: boolean = false;
let reset: boolean = false;
const normIconURL = "https://raw.githubusercontent.com/N0ise9/UNCC-Six-Mans.js/main/media/norm_still.png";

export async function normCommand(chatChannel: TextChannel, message: Message): Promise<void> {
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
          .setDescription("Click the green button to join the queue! \n\n" + "<@994106480477351946> (60 mins)");

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

      if (message.content.toLowerCase().match(EasterEggCustomID.Norm)) {
        const possibleReponse = [
          "hi",
          "That is a resounding no.",
          "It is not looking likely.",
          "Too hard to tell.",
          "It is quite possible.",
          "Definitely.",
          "Ask papa Duis",
          "As I see it, yes.",
          "Ask again later... I'm busy.",
          "Better not tell you now...",
          "I can't seem to predict now.",
          "Concentrate, then ask again.",
          "Don't count on it.",
          "It is decidedly so.",
          "Most likely.",
          "My reply is no.",
          "No.",
          "no",
          "My sources are telling me no.",
          "The outlook isn't looking so good.",
          "Reply hazy, try again.",
          "All signs point to yes.",
          "Very doubtful.",
          "Yes.",
          "Yes, definitely.",
          "You can count on it.",
          "shut up",
          "Some questions are best left unanswered...",
          "Absolutely not!",
          "h",
          "Why is it that everyone wants to ask me questions that I have absolutely no idea the answer to???",
          "I'm thinking.",
        ];
        const normResponse = possibleReponse[Math.floor(Math.random() * possibleReponse.length)];
        chatChannel.send("<@" + message.author + "> " + normResponse);
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
