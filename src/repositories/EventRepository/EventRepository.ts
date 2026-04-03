import { PrismaClient } from "../../prisma";
import { Event } from "./types";

export class EventRepository {
  #CurrentEventCache: Event | null;

  constructor(private readonly prisma: PrismaClient) {
    this.#CurrentEventCache = null;
  }

  async getCurrentEvent(): Promise<Event> {
    if (this.#CurrentEventCache) {
      return this.#CurrentEventCache;
    }

    const currentEventResult = await this.prisma.event.findFirst({
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
}
