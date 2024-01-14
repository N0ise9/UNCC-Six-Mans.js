/* eslint-disable no-console */

import { Message, TextChannel } from "discord.js";

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
}

let eggs: boolean = false;
let reset: boolean = false;

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
      if (message.content.includes(EasterEggCustomID.Hi)) {
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

      if (message.content.includes(EasterEggCustomID.Norm)) {
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
