import { Collection, Message, TextChannel } from "discord.js";
import {
  ApiStatusCatalog,
  ServiceConfig,
  ServiceStatus,
  createUnknownServiceStatus,
} from "../../services/ApiStatusService";
import { ApiStatusRuntime } from "../ApiStatusRuntime";
import { DiscordWorkScheduler } from "../DiscordWorkScheduler";

type FakeMessage = Message & {
  delete: jest.Mock<Promise<void>, []>;
  edit: jest.Mock<Promise<Message>, [unknown]>;
};

type FakeChannel = TextChannel & {
  __sentMessages: FakeMessage[];
};

type EmbedPayload = {
  embeds: Array<{ toJSON: () => any }>;
};

function asEmbedPayload(value: unknown): EmbedPayload {
  return value as EmbedPayload;
}

function createManagedMessage(id: string, channelId: string, footerText = "NormJS Status Summary | Page 1"): FakeMessage {
  let message: FakeMessage;
  message = {
    author: { id: "bot-user" },
    channelId,
    createdTimestamp: Date.now(),
    delete: jest.fn(async () => undefined),
    edit: jest.fn(async (payload) => {
      const embed = (payload as EmbedPayload).embeds?.[0];
      if (embed) {
        const nextFooterText = embed.toJSON().footer?.text ?? footerText;
        message.embeds = [{ footer: { text: nextFooterText } }] as Message["embeds"];
      }
      return message as unknown as Message;
    }),
    embeds: [{ footer: { text: footerText } }],
    id,
  } as unknown as FakeMessage;

  return message;
}

function createChannel(id: string, existingMessages: Message[] = []): FakeChannel {
  const sentMessages: FakeMessage[] = [];

  return {
    __sentMessages: sentMessages,
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
    send: jest.fn(async (payload) => {
      const embed = (payload as EmbedPayload).embeds?.[0];
      const footerText = embed?.toJSON().footer?.text ?? "NormJS Status Summary | Page 1";
      const message = createManagedMessage(`sent-${id}-${sentMessages.length + 1}`, id, footerText);
      sentMessages.push(message);
      return message;
    }),
  } as unknown as FakeChannel;
}

function createService(
  overrides: Partial<ServiceConfig> & Pick<ServiceConfig, "id" | "name" | "pageUrl" | "type">
): ServiceConfig {
  return {
    ...overrides,
  };
}

function createStatus(service: ServiceConfig, overrides: Partial<ServiceStatus> = {}): ServiceStatus {
  return {
    ...createUnknownServiceStatus(service, ""),
    lastChecked: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function createCatalog(
  displayCategories: ApiStatusCatalog["displayCategories"],
  generalServices: Array<{ categoryName: string; service: ServiceConfig }>,
  awsRoot: ApiStatusCatalog["awsRoot"] = null,
  awsChildren: ApiStatusCatalog["awsChildren"] = []
): ApiStatusCatalog {
  return {
    awsChildren,
    awsRoot,
    displayCategories,
    generalServices,
  };
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

async function flushScheduler(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("ApiStatusRuntime", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("fans out one shared status snapshot to multiple guild channels", async () => {
    const service = createService({
      id: "openai",
      name: "OpenAI",
      pageUrl: "https://status.openai.com/",
      type: "statuspage",
    });
    const catalog = createCatalog(
      [{ name: "Developer Tools", services: [service] }],
      [{ categoryName: "Developer Tools", service }]
    );
    const runtime = new ApiStatusRuntime(new DiscordWorkScheduler(1, 0), {
      catalog,
      checkService: async () => createStatus(service, { status: "operational" }),
      publishDebounceMs: 0,
    });
    const firstChannel = createChannel("channel-1");
    const secondChannel = createChannel("channel-2");

    try {
      await runtime.registerGuild("guild-1", firstChannel);
      await runtime.registerGuild("guild-2", secondChannel);

      expect(firstChannel.send).toHaveBeenCalledTimes(1);
      expect(secondChannel.send).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.dispose();
    }
  });

  it("reuses bot-owned managed status messages instead of reposting", async () => {
    const service = createService({
      id: "openai",
      name: "OpenAI",
      pageUrl: "https://status.openai.com/",
      type: "statuspage",
    });
    const catalog = createCatalog(
      [{ name: "Developer Tools", services: [service] }],
      [{ categoryName: "Developer Tools", service }]
    );
    const runtime = new ApiStatusRuntime(new DiscordWorkScheduler(1, 0), {
      catalog,
      checkService: async () => createStatus(service, { status: "operational" }),
      publishDebounceMs: 0,
    });
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

  it("renders a Tonka-style summary embed and collapses AWS child checks into one visible row", async () => {
    const awsRoot = createService({
      id: "aws",
      isGroupRoot: true,
      name: "AWS",
      pageUrl: "https://health.aws.amazon.com/health/status",
      type: "generic",
    });
    const awsChild = createService({
      groupId: "aws",
      id: "aws-ec2-us-east-1",
      name: "AWS ec2-us-east-1",
      pageUrl: "https://health.aws.amazon.com/health/status",
      type: "generic",
    });
    const zendesk = createService({
      id: "zendesk",
      name: "Zendesk",
      pageUrl: "https://status.zendesk.com/",
      type: "statuspage",
    });
    const lastpass = createService({
      id: "lastpass",
      name: "LastPass",
      pageUrl: "https://status.lastpass.com/",
      type: "statuspage",
    });
    const catalog = createCatalog(
      [
        {
          name: "Cloud Platforms",
          services: [awsRoot, zendesk, lastpass],
        },
      ],
      [
        { categoryName: "Cloud Platforms", service: zendesk },
        { categoryName: "Cloud Platforms", service: lastpass },
      ],
      { categoryName: "Cloud Platforms", service: awsRoot },
      [{ categoryName: "Cloud Platforms", service: awsChild }]
    );
    const checkService = jest.fn(async (service: ServiceConfig) => {
      switch (service.id) {
        case "aws":
        case "aws-ec2-us-east-1":
        case "zendesk":
          return createStatus(service, {
            description: service.id === "zendesk" ? "All Systems Operational" : "",
            status: "operational",
          });
        case "lastpass":
          return createStatus(service, {
            description: "Partially Degraded Service",
            status: "degraded_performance",
          });
        default:
          throw new Error(`Unexpected service ${service.id}`);
      }
    });
    const runtime = new ApiStatusRuntime(new DiscordWorkScheduler(1, 0), {
      awsSweepMs: 3,
      catalog,
      checkService,
      generalSweepMs: 4,
      publishDebounceMs: 0,
    });
    const channel = createChannel("channel-1");

    try {
      await runtime.registerGuild("guild-1", channel);
      await jest.advanceTimersByTimeAsync(20);
      await flushScheduler();

      const summaryPayload =
        channel.__sentMessages[0].edit.mock.calls.at(-1)?.[0] ??
        (channel.send as jest.Mock).mock.calls.at(-1)?.[0];
      const summaryEmbed = summaryPayload.embeds[0].toJSON();

      expect(summaryEmbed.title).toBe("API and Platform Status (Page 1)");
      expect(summaryEmbed.description).toContain("Last updated:");
      expect(summaryEmbed.description).toContain("Operational:");
      expect(summaryEmbed.fields[0].name).toBe("Cloud Platforms");
      expect(summaryEmbed.fields[0].value).toContain("\u2705 AWS");
      expect(summaryEmbed.fields[0].value).toContain("\u2705 Zendesk - All Systems Operational");
      expect(summaryEmbed.fields[0].value).toContain("\u{1F7E1} LastPass - Partially Degraded Service");
      expect(summaryEmbed.fields[0].value).not.toContain("AWS ec2-us-east-1");
    } finally {
      await runtime.dispose();
    }
  });

  it("keeps the last good service status on the first failed retry and marks it unreachable on the second failure", async () => {
    const service = createService({
      id: "openai",
      name: "OpenAI",
      pageUrl: "https://status.openai.com/",
      type: "statuspage",
    });
    const checkService = jest
      .fn<Promise<ServiceStatus>, [ServiceConfig]>()
      .mockResolvedValueOnce(createStatus(service, { status: "operational" }))
      .mockResolvedValueOnce(createStatus(service, { description: "Unreachable", status: "unknown" }))
      .mockResolvedValueOnce(createStatus(service, { description: "Unreachable", status: "unknown" }));
    const runtime = new ApiStatusRuntime(new DiscordWorkScheduler(1, 0), {
      catalog: createCatalog([{ name: "Developer Tools", services: [service] }], [{ categoryName: "Developer Tools", service }]),
      checkService,
      generalSweepMs: 10,
      hotPollMs: 1_000,
      hotSpreadMs: 1,
      publishDebounceMs: 0,
      retryMs: 5,
    });
    const channel = createChannel("channel-1");

    try {
      await runtime.registerGuild("guild-1", channel);
      await jest.advanceTimersByTimeAsync(1);
      await flushScheduler();

      const editsAfterSuccess = channel.__sentMessages[0].edit.mock.calls.length;
      await jest.advanceTimersByTimeAsync(10);
      await flushScheduler();

      expect(channel.__sentMessages[0].edit.mock.calls.length).toBe(editsAfterSuccess);

      await jest.advanceTimersByTimeAsync(5);
      await flushScheduler();

      const finalPayload = asEmbedPayload(channel.__sentMessages[0].edit.mock.calls.at(-1)?.[0]);
      const finalEmbed = finalPayload.embeds[0].toJSON();

      expect(finalEmbed.fields[0].value).toContain("\u26AA OpenAI - Unreachable");
    } finally {
      await runtime.dispose();
    }
  });

  it("hot-rechecks non-operational services before the normal 15 minute sweep", async () => {
    const service = createService({
      id: "lastpass",
      name: "LastPass",
      pageUrl: "https://status.lastpass.com/",
      type: "statuspage",
    });
    const checkService = jest
      .fn<Promise<ServiceStatus>, [ServiceConfig]>()
      .mockResolvedValueOnce(
        createStatus(service, {
          description: "Partially Degraded Service",
          status: "degraded_performance",
        })
      )
      .mockResolvedValueOnce(createStatus(service, { status: "operational" }));
    const runtime = new ApiStatusRuntime(new DiscordWorkScheduler(1, 0), {
      catalog: createCatalog(
        [{ name: "Communication & Identity APIs", services: [service] }],
        [{ categoryName: "Communication & Identity APIs", service }]
      ),
      checkService,
      generalSweepMs: 10_000,
      hotPollMs: 5,
      hotSpreadMs: 1,
      publishDebounceMs: 0,
    });
    const channel = createChannel("channel-1");

    try {
      await runtime.registerGuild("guild-1", channel);
      await jest.advanceTimersByTimeAsync(1);
      await flushScheduler();

      const degradedPayload = asEmbedPayload(channel.__sentMessages[0].edit.mock.calls.at(-1)?.[0]);
      expect(degradedPayload.embeds[0].toJSON().fields[0].value).toContain(
        "\u{1F7E1} LastPass - Partially Degraded Service"
      );

      await jest.advanceTimersByTimeAsync(6);
      await flushScheduler();

      const recoveredPayload = asEmbedPayload(channel.__sentMessages[0].edit.mock.calls.at(-1)?.[0]);
      expect(recoveredPayload.embeds[0].toJSON().fields[0].value).toContain("\u2705 LastPass");
    } finally {
      await runtime.dispose();
    }
  });

  it("keeps every published summary embed within Discord's 6000 character limit", async () => {
    const services = Array.from({ length: 80 }, (_, index) =>
      createService({
        id: `service-${index}`,
        name: `Service ${index}`,
        pageUrl: `https://example.com/${index}`,
        type: "statuspage",
      })
    );
    const catalog = createCatalog(
      [{ name: "Huge Category", services }],
      services.map((service) => ({ categoryName: "Huge Category", service }))
    );
    const runtime = new ApiStatusRuntime(new DiscordWorkScheduler(1, 0), {
      catalog,
      checkService: async (service) =>
        createStatus(service, {
          description: `${service.name} `.repeat(12),
          status: "degraded_performance",
        }),
      generalSweepMs: 80,
      publishDebounceMs: 0,
    });
    const channel = createChannel("channel-1");

    try {
      await runtime.registerGuild("guild-1", channel);
      await jest.advanceTimersByTimeAsync(200);
      await flushScheduler();

      const embeds = [
        ...(channel.send as jest.Mock).mock.calls.map((call) => call[0].embeds[0]),
        ...channel.__sentMessages.flatMap((message) =>
          message.edit.mock.calls.map((call) => asEmbedPayload(call[0]).embeds[0])
        ),
      ];

      for (const embed of embeds) {
        expect(estimateEmbedLength(embed)).toBeLessThanOrEqual(6000);
      }
    } finally {
      await runtime.dispose();
    }
  });
});
