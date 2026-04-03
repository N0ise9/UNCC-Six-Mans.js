import { PrismaClient, createPrismaClient } from "../../../prisma";
import { Event } from "../types";
import * as faker from "faker";
import { EventRepository } from "../EventRepository";

let prisma: PrismaClient;
let eventRepository: EventRepository;

beforeEach(async () => {
  jest.clearAllMocks();
  eventRepository = new EventRepository(prisma);
});

beforeAll(async () => {
  prisma = createPrismaClient(process.env["DATABASE_URL"]);
  await prisma.$connect();
  await prisma.event.deleteMany();
});

afterEach(async () => {
  await prisma.event.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("EventRepository tests", () => {
  // run first to avoid cache
  it("throws if there's no current event", async () => {
    await prisma.event.create({
      data: {
        name: "Not Current Season",
        endDate: faker.date.past(),
      },
    });

    await expect(eventRepository.getCurrentEvent()).rejects.toThrow();
  });

  it("returns the correct current event", async () => {
    await prisma.event.createMany({
      data: [
        {
          name: "Actual Current Season",
          endDate: null,
        },
        {
          name: "Not Current Season",
          endDate: faker.date.past(),
        },
      ],
    });

    const actual = await eventRepository.getCurrentEvent();
    expect(actual).toEqual<Event>({
      id: expect.any(Number),
      name: "Actual Current Season",
      endDate: null,
      mmrMult: 1.0,
      startDate: expect.any(Date),
    });
  });
});
