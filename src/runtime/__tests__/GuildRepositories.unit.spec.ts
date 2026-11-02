import { PrismaClient } from "../../prisma";
import { GuildRepositories } from "../GuildRepositories";

describe("GuildRepositories", () => {
  it("creates a default current event when the guild database has none", async () => {
    const prisma = {
      event: {
        create: jest.fn(async ({ data }: { data: { name: string } }) => ({
          endDate: null,
          id: 7,
          mmrMult: { toNumber: () => 1 },
          name: data.name,
          startDate: new Date("2026-04-03T00:00:00.000Z"),
        })),
        findFirst: jest.fn(async () => null),
      },
    } as unknown as PrismaClient;

    const repositories = new GuildRepositories(prisma);
    const result = await repositories.event.ensureCurrentEvent();

    expect(result).toEqual({
      created: true,
      event: {
        endDate: null,
        id: 7,
        mmrMult: 1,
        name: expect.stringMatching(/^Default Event \d+$/),
        startDate: new Date("2026-04-03T00:00:00.000Z"),
      },
    });
    expect(prisma.event.create).toHaveBeenCalledWith({
      data: {
        name: expect.stringMatching(/^Default Event \d+$/),
      },
    });
  });

  it("reuses the current event instead of creating a new one when one already exists", async () => {
    const prisma = {
      event: {
        create: jest.fn(),
        findFirst: jest.fn(async () => ({
          endDate: null,
          id: 3,
          mmrMult: { toNumber: () => 1.5 },
          name: "Spring 2026",
          startDate: new Date("2026-01-01T00:00:00.000Z"),
        })),
      },
    } as unknown as PrismaClient;

    const repositories = new GuildRepositories(prisma);
    const result = await repositories.event.ensureCurrentEvent();

    expect(result).toEqual({
      created: false,
      event: {
        endDate: null,
        id: 3,
        mmrMult: 1.5,
        name: "Spring 2026",
        startDate: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    expect(prisma.event.create).not.toHaveBeenCalled();
  });
});
