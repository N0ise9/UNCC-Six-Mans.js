export function generateRandomId(): string {
  let chars = "";

  for (let i = 0; i < 6; i++) {
    // 48 - 57 = 0 - 9
    const randomNumber = Math.random() * (57 - 48) + 48;
    // 65 - 90 = A - Z
    const randomLetter = Math.random() * (90 - 65) + 65;
    const randomChar = Math.random() < 0.5 ? randomNumber : randomLetter;

    chars += String.fromCharCode(randomChar);

    // add a dash halfway through
    if (i == 2) chars += "-";
  }

  return chars;
}

export const enum ColorCodes {
  Green = 5763719,
  Blue = 3447003,
  Orange = 15105570,
  DarkRed = 10038562,
}

export function getEnvVariable(token: string): string {
  const envVariable = process.env[token];

  if (!envVariable) {
    throw new Error(`No environment variable named ${token}.`);
  }

  return envVariable;
}

export async function waitForAllPromises<Item, AsyncResponse>(
  items: Array<Item> | ReadonlyArray<Item>,
  asyncFunc: (item: Item) => Promise<AsyncResponse>
): Promise<Array<AsyncResponse>> {
  const promises = [];
  for (const item of items) {
    promises.push(asyncFunc(item));
  }
  return await Promise.all(promises);
}

/**
 * Helper function that splits an array of items into two different arrays based on some condition.
 * @param arr The array of values to split
 * @param splitFn Function to determine which array the object should be added to
 * @returns An array containing two arrays where the first contains objects where the splitFn evaluated to
 * true and the second containing all objects that evaluated to false.
 */
export function splitArray<T>(arr: Array<T>, splitFn: (e: T) => boolean): T[][] {
  const a1: Array<T> = [];
  const a2: Array<T> = [];

  for (const e of arr) {
    if (splitFn(e)) {
      a1.push(e);
    } else {
      a2.push(e);
    }
  }

  return [a1, a2];
}
