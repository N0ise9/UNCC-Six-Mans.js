import { Collection, Message, TextChannel } from "discord.js";
import { fetchAllStatuses, summarizeIssues } from "../../services/ApiStatusService";
import { ApiStatusRuntime } from "../ApiStatusRuntime";
import { DiscordWorkScheduler } from "../DiscordWorkScheduler";

jest.mock("../../services/ApiStatusService", () => {
  return {
    fetchAllStatuses: jest.fn(),
    summarizeIssues: jest.fn((categories: Array<{ services: Array<{ status: string }> }>) => {
      let critical = 0;
      let issues = 0;
      let operational = 0;

      for (const category of categories) {
        for (const service of category.services) {
          if (service.status === "operational") operational += 1;
          else if (service.status === "major_outage") {
            critical += 1;
            issues += 1;
          } else if (service.status !== "unknown") {
            issues += 1;
          }
        }
      }

      return {
        critical,
        issues,
        operational,
      };
    }),
  };
});

const mockedFetchAllStatuses = fetchAllStatuses as jest.MockedFunction<typeof fetchAllStatuses>;
const mockedSummarizeIssues = summarizeIssues as jest.MockedFunction<typeof summarizeIssues>;

type FakeMessage = Message & {
  delete: jest.Mock<Promise<void>, []>;
  edit: jest.Mock<Promise<Message>, [unknown]>;
};

function createManagedMessage(id: string, channelId: string, footerText = "NormJS Status Summary | Page 1"): FakeMessage {
  let message: FakeMessage;
  message = {
    author: { id: "bot-user" },
    channelId,
    createdTimestamp: Date.now(),
    delete: jest.fn(async () => undefined),
    edit: jest.fn(async () => message as unknown as Message),
    embeds: [{ footer: { text: footerText } }],
    id,
  } as unknown as FakeMessage;

  return message;
}

function createChannel(id: string, existingMessages: Message[] = []): TextChannel {
  const sentMessages: FakeMessage[] = [];

  return {
    client: { user: { id: "bot-user" } },
    id,
    messages: {
      fetch: jest.fn(async () => {
        const collection = new Collection<string, Message>();
        for (const message of existingMessages) {
          collection.set(message.id, message);
        }
        return collection;
      }),
    },
    send: jest.fn(async () => {
      const message = createManagedMessage(`sent-${id}-${sentMessages.length + 1}`, id);
      sentMessages.push(message);
      return message;
    }),
  } as unknown as TextChannel;
}

function estimateEmbedLength(embed: { toJSON?: () => any } | any): number {
  const json = typeof embed?.toJSON === "function" ? embed.toJSON() : embed;
  const titleLength = json.title?.length ?? 0;
  const descriptionLength = json.description?.length ?? 0;
  const footerLength = json.footer?.text?.length ?? 0;
  const fieldLength = Array.isArray(json.fields)
    ? json.fields.reduce(
        (total: number, field: { name?: string; value?: string }) =>
          total + (field.name?.length ?? 0) + (field.value?.length ?? 0),
        0
      )
    : 0;

  return titleLength + descriptionLength + footerLength + fieldLength;
}

describe("ApiStatusRuntime", () => {
  beforeEach(() => {
    mockedFetchAllStatuses.mockReset();
    mockedSummarizeIssues.mockClear();
    mockedFetchAllStatuses.mockResolvedValue({
      categories: [
        {
          name: "Developer Tools",
          services: [
            {
              id: "openai",
              incidents: [],
              lastChecked: new Date("2026-01-01T00:00:00.000Z"),
              name: "OpenAI",
              pageUrl: "https://status.openai.com/",
              status: "operational",
            },
          ],
        },
      ],
    });
  });

  it("fans out one shared status snapshot to multiple guild channels", async () => {
    const runtime = new ApiStatusRuntime(new DiscordWorkScheduler(1, 0), 60_000, 60_000);
    const firstChannel = createChannel("channel-1");
    const secondChannel = createChannel("channel-2");

    try {
      await runtime.registerGuild("guild-1", firstChannel);
      await runtime.registerGuild("guild-2", secondChannel);

      expect(mockedFetchAllStatuses).toHaveBeenCalledTimes(1);
      expect(firstChannel.send).toHaveBeenCalledTimes(1);
      expect(secondChannel.send).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.dispose();
    }
  });

  it("reuses bot-owned managed status messages instead of reposting", async () => {
    const runtime = new ApiStatusRuntime(new DiscordWorkScheduler(1, 0), 60_000, 60_000);
    const existingMessage = createManagedMessage("existing-summary", "channel-1");
    const channel = createChannel("channel-1", [existingMessage]);

    try {
      await runtime.registerGuild("guild-1", channel);

      expect(channel.send).not.toHaveBeenCalled();
      expect(existingMessage.edit).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.dispose();
    }
  });

  it("splits oversized summary pages so every embed stays within Discord's 6000 character limit", async () => {
    mockedFetchAllStatuses.mockResolvedValue({
      categories: [
        {
          name: "Huge Category",
          services: Array.from({ length: 120 }, (_, index) => ({
            description: `Service ${index} `.repeat(12),
            id: `service-${index}`,
            incidents: [],
            lastChecked: new Date("2026-01-01T00:00:00.000Z"),
            name: `Service ${index}`,
            pageUrl: `https://example.com/${index}`,
            status: "degraded_performance" as const,
          })),
        },
      ],
    });

    const runtime = new ApiStatusRuntime(new DiscordWorkScheduler(1, 0), 60_000, 60_000);
    const channel = createChannel("channel-1");

    try {
      await runtime.registerGuild("guild-1", channel);

      const sentEmbeds = (channel.send as jest.Mock).mock.calls.map((call) => call[0].embeds[0]);
      expect(sentEmbeds.length).toBeGreaterThan(1);
      for (const embed of sentEmbeds) {
        expect(estimateEmbedLength(embed)).toBeLessThanOrEqual(6000);
      }
    } finally {
      await runtime.dispose();
    }
  });

  it("splits oversized incident updates so every incident embed stays within Discord's 6000 character limit", async () => {
    mockedFetchAllStatuses.mockResolvedValue({
      categories: [
        {
          name: "Developer Tools",
          services: [
            {
              description: "Partial outage affecting a large portion of the platform.",
              id: "openai",
              incidents: [
                {
                  id: "incident-1",
                  incident_updates: Array.from({ length: 5 }, (_, index) => ({
                    body: `Update ${index} ` + "x".repeat(1200),
                    created_at: new Date("2026-01-01T00:00:00.000Z").toISOString(),
                  })),
                  name: "Major platform incident",
                  shortlink: "https://status.example.com/incidents/1",
                },
              ],
              lastChecked: new Date("2026-01-01T00:00:00.000Z"),
              name: "OpenAI",
              pageUrl: "https://status.openai.com/",
              status: "major_outage" as const,
            },
          ],
        },
      ],
    });

    const runtime = new ApiStatusRuntime(new DiscordWorkScheduler(1, 0), 60_000, 60_000);
    const channel = createChannel("channel-1");

    try {
      await runtime.registerGuild("guild-1", channel);

      const sentEmbeds = (channel.send as jest.Mock).mock.calls.map((call) => call[0].embeds[0]);
      expect(sentEmbeds.length).toBeGreaterThan(1);
      for (const embed of sentEmbeds) {
        expect(estimateEmbedLength(embed)).toBeLessThanOrEqual(6000);
      }
    } finally {
      await runtime.dispose();
    }
  });
});
