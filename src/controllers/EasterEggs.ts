/* eslint-disable no-console */

import { Message } from "discord.js";

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

let eggs: boolean = false;
let reset: boolean = false;

export async function normCommand(message: Message): Promise<void> {
  if (message.content.charAt(0) === "!") {
    if (eggs) {
      //execute easter egg
      reset = true;
    }
    return;
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
