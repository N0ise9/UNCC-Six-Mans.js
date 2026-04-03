import { PrismaClient, createPrismaClient } from "../../prisma";
import { Event } from "./types";

class EventRepository {
  #Prisma: PrismaClient | null;
  #CurrentEventCache: Event | null;

  constructor() {
    this.#Prisma = null;
    this.#CurrentEventCache = null;
  }

  #getPrismaClient(): PrismaClient {
    if (!this.#Prisma) {
      this.#Prisma = createPrismaClient();
    }

    return this.#Prisma;
  }

  async getCurrentEvent(): Promise<Event> {
    if (this.#CurrentEventCache) {
      return this.#CurrentEventCache;
    }

    const currentEventResult = await this.#getPrismaClient().event.findFirst({
      where: {
        endDate: null,
      },
    });

    if (!currentEventResult) {
      throw new Error("No current event. There should always be an active event.");
    }

    const currentEvent: Event = {
      endDate: currentEventResult.endDate,
      id: currentEventResult.id,
      mmrMult: currentEventResult.mmrMult.toNumber(),
      name: currentEventResult.name,
      startDate: currentEventResult.startDate,
    };

    this.#CurrentEventCache = currentEvent;

    return currentEvent;
  }

  async disconnect(): Promise<void> {
    if (!this.#Prisma) {
      return;
    }

    await this.#Prisma.$disconnect();
    this.#Prisma = null;
  }
}

export default new EventRepository();
