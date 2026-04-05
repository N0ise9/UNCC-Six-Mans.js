import { Collection, Message, TextChannel } from "discord.js";
import {
  ApiStatusCatalog,
  ServiceConfig,
  ServiceStatus,
  createUnknownServiceStatus,
} from "../../services/ApiStatusService";
import { ApiStatusRuntime } from "../ApiStatusRuntime";
import { DiscordWorkScheduler } from "../DiscordWorkScheduler";
import { reconcileKeyedTrackedMessages } from "../reconcileTrackedMessages";

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

function createEmbedPayload(footerText = "NormJS Status Incident", title = "Incident"): EmbedPayload {
  return {
    embeds: [
      {
        toJSON: () => ({
          footer: { text: footerText },
          title,
        }),
      },
    ],
  };
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
      fetch: jest.fn(async (options?: { before?: string; limit?: number }) => {
        const limit = options?.limit ?? 50;
        const sortedMessages = [...existingMessages].sort((left, right) => right.createdTimestamp - left.createdTimestamp);
        let startIndex = 0;
        if (options?.before) {
          const beforeIndex = sortedMessages.findIndex((message) => message.id === options.before);
          startIndex = beforeIndex >= 0 ? beforeIndex + 1 : sortedMessages.length;
        }

        const pageMessages = sortedMessages.slice(startIndex, startIndex + limit);
        const collection = new Collection<string, Message>();
        for (const message of pageMessages) {
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

function createDeferred<T>(): {
  promise: Promise<T>;
  reject: (error?: unknown) => void;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return {
    promise,
    reject,
    resolve,
  };
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

  it("replaces bot-owned managed status messages during startup self-heal", async () => {
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

      expect(existingMessage.delete).toHaveBeenCalledTimes(1);
      expect(channel.send).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.dispose();
    }
  });

  it("self-heals stale API status messages on startup before publishing a clean set", async () => {
    const service = createService({
      id: "openai",
      name: "OpenAI",
      pageUrl: "https://status.openai.com/",
      type: "statuspage",
    });
    const runtime = new ApiStatusRuntime(new DiscordWorkScheduler(1, 0), {
      catalog: createCatalog([{ name: "Developer Tools", services: [service] }], [{ categoryName: "Developer Tools", service }]),
      checkService: async () => createStatus(service, { status: "operational" }),
      publishDebounceMs: 0,
    });
    const staleSummary = createManagedMessage("stale-summary", "channel-1");
    const staleIncident = createManagedMessage("stale-incident", "channel-1", "NormJS Status Incident");
    const channel = createChannel("channel-1", [staleSummary, staleIncident]);

    try {
      await runtime.registerGuild("guild-1", channel);

      expect(staleSummary.delete).toHaveBeenCalledTimes(1);
      expect(staleIncident.delete).toHaveBeenCalledTimes(1);
      expect(channel.send).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.dispose();
    }
  });

  it("cleans up more than 50 pre-existing status messages on startup", async () => {
    const service = createService({
      id: "openai",
      name: "OpenAI",
      pageUrl: "https://status.openai.com/",
      type: "statuspage",
    });
    const runtime = new ApiStatusRuntime(new DiscordWorkScheduler(1, 0), {
      catalog: createCatalog([{ name: "Developer Tools", services: [service] }], [{ categoryName: "Developer Tools", service }]),
      checkService: async () => createStatus(service, { status: "operational" }),
      publishDebounceMs: 0,
    });
    const existingMessages = Array.from({ length: 120 }, (_, index) => {
      const footerText = index % 2 === 0 ? "NormJS Status Summary | Page 1" : "NormJS Status Incident";
      const message = createManagedMessage(`managed-${index}`, "channel-1", footerText);
      message.createdTimestamp = index;
      return message;
    });
    const channel = createChannel("channel-1", existingMessages);

    try {
      await runtime.registerGuild("guild-1", channel);

      expect(channel.messages.fetch).toHaveBeenCalledTimes(2);
      for (const message of existingMessages) {
        expect(message.delete).toHaveBeenCalledTimes(1);
      }
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

  it("keeps one incident card per service and edits it in place across polls", async () => {
    const service = createService({
      id: "elastic",
      name: "Elastic Cloud",
      pageUrl: "https://status.elastic.co/",
      type: "statuspage",
    });
    const firstStatus = createStatus(service, {
      description: "Connectivity disruption for AWS Bahrain (me-south-1)",
      incidents: [
        {
          created_at: "2026-04-04T18:00:00.000Z",
          id: "incident-1",
          incident_updates: [
            {
              body: "Initial update",
              created_at: "2026-04-04T18:00:00.000Z",
            },
          ],
          name: "Connectivity disruption for AWS Bahrain (me-south-1)",
          shortlink: "https://status.elastic.co/incidents/incident-1",
          status: "identified",
        },
      ],
      status: "partial_outage",
    });
    const secondStatus = createStatus(service, {
      description: "Connectivity disruption for AWS Bahrain (me-south-1)",
      incidents: [
        {
          created_at: "2026-04-04T18:00:00.000Z",
          id: "incident-1",
          incident_updates: [
            {
              body: "Follow-up update",
              created_at: "2026-04-04T18:05:00.000Z",
            },
            {
              body: "Initial update",
              created_at: "2026-04-04T18:00:00.000Z",
            },
          ],
          name: "Connectivity disruption for AWS Bahrain (me-south-1)",
          shortlink: "https://status.elastic.co/incidents/incident-1",
          status: "identified",
        },
      ],
      status: "partial_outage",
    });
    const checkService = jest
      .fn<Promise<ServiceStatus>, [ServiceConfig]>()
      .mockResolvedValueOnce(firstStatus)
      .mockResolvedValueOnce(secondStatus);
    const runtime = new ApiStatusRuntime(new DiscordWorkScheduler(1, 0), {
      catalog: createCatalog([{ name: "Monitoring", services: [service] }], [{ categoryName: "Monitoring", service }]),
      checkService,
      generalSweepMs: 10,
      publishDebounceMs: 0,
    });
    const channel = createChannel("channel-1");

    try {
      await runtime.registerGuild("guild-1", channel);
      await jest.advanceTimersByTimeAsync(1);
      await flushScheduler();
      await jest.advanceTimersByTimeAsync(10);
      await flushScheduler();

      const incidentCreates = (channel.send as jest.Mock).mock.calls.filter(
        (call) => call[0].embeds[0].toJSON().title === "Incident - Elastic Cloud"
      );

      expect(incidentCreates).toHaveLength(1);
      expect(channel.__sentMessages[1].edit).toHaveBeenCalled();
    } finally {
      await runtime.dispose();
    }
  });

  it("renders one incident card for noisy services and summarizes older updates", async () => {
    const service = createService({
      id: "ibmsecurity",
      name: "IBM Security",
      pageUrl: "https://statuspage.ibmcloudsecurity.com/",
      type: "statuspage",
    });
    const incidentUpdates = Array.from({ length: 10 }, (_, index) => ({
      body: `Incident update ${index + 1} ${"x".repeat(120)}`,
      created_at: `2026-04-04T1${index}:00:00.000Z`,
    }));
    const runtime = new ApiStatusRuntime(new DiscordWorkScheduler(1, 0), {
      catalog: createCatalog([{ name: "Monitoring", services: [service] }], [{ categoryName: "Monitoring", service }]),
      checkService: async () =>
        createStatus(service, {
          description: "US & EU - Issues with AI Chatbot",
          incidents: [
            {
              created_at: "2026-04-04T10:00:00.000Z",
              id: "incident-ibm-1",
              incident_updates: incidentUpdates,
              name: "US & EU - Issues with AI Chatbot",
              shortlink: "https://statuspage.ibmcloudsecurity.com/incidents/incident-ibm-1",
              status: "investigating",
            },
          ],
          status: "major_outage",
        }),
      generalSweepMs: 10,
      publishDebounceMs: 0,
    });
    const channel = createChannel("channel-1");

    try {
      await runtime.registerGuild("guild-1", channel);
      await jest.advanceTimersByTimeAsync(1);
      await flushScheduler();

      const incidentCreate = (channel.send as jest.Mock).mock.calls.find(
        (call) => call[0].embeds[0].toJSON().title === "Incident - IBM Security"
      );
      const incidentEmbed = incidentCreate?.[0].embeds[0].toJSON();

      expect(incidentEmbed).toBeDefined();
      expect(incidentEmbed.fields).toHaveLength(2);
      expect(incidentEmbed.fields[1].name).toBe("Updates (latest 3)");
      expect(incidentEmbed.fields[1].value).toContain("+7 older updates on the status page");
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

  it("uses Norm's last checked time in incident embeds instead of the provider incident timestamp", async () => {
    const service = createService({
      id: "linode",
      name: "Linode",
      pageUrl: "https://status.linode.com/",
      type: "statuspage",
    });
    const lastChecked = new Date("2026-04-04T21:00:00.000Z");
    const incidentCreatedAt = "2026-01-01T00:00:00.000Z";
    const catalog = createCatalog(
      [{ name: "Hosting & DNS / CDN", services: [service] }],
      [{ categoryName: "Hosting & DNS / CDN", service }]
    );
    const runtime = new ApiStatusRuntime(new DiscordWorkScheduler(1, 0), {
      catalog,
      checkService: async () =>
        createStatus(service, {
          description: "Service Issue - GPU and VPU Booting issues",
          incidents: [
            {
              created_at: incidentCreatedAt,
              id: "incident-1",
              incident_updates: [
                {
                  body: "We are investigating this issue.",
                  created_at: incidentCreatedAt,
                },
              ],
              name: "Service Issue - GPU and VPU Booting issues",
              shortlink: "https://status.linode.com/incidents/incident-1",
              status: "investigating",
            },
          ],
          lastChecked,
          status: "degraded_performance",
        }),
      generalSweepMs: 1,
      publishDebounceMs: 0,
    });
    const channel = createChannel("channel-1");

    try {
      await runtime.registerGuild("guild-1", channel);
      await jest.advanceTimersByTimeAsync(5);
      await flushScheduler();

      const allEmbeds = [
        ...(channel.send as jest.Mock).mock.calls.map((call) => call[0].embeds[0].toJSON()),
        ...channel.__sentMessages.flatMap((message) =>
          message.edit.mock.calls.map((call) => asEmbedPayload(call[0]).embeds[0].toJSON())
        ),
      ];
      const incidentEmbed = allEmbeds.find((embed) => embed.title === "Incident - Linode");

      expect(incidentEmbed).toBeDefined();
      expect(incidentEmbed.description).toContain(
        `Last updated: <t:${Math.floor(lastChecked.getTime() / 1000)}:R>`
      );
      expect(incidentEmbed.description).not.toContain(
        `Last updated: <t:${Math.floor(new Date(incidentCreatedAt).getTime() / 1000)}:R>`
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("deletes duplicate tracked messages that share the same reconciliation key", async () => {
    const scheduler = new DiscordWorkScheduler(1, 0);
    const channel = createChannel("channel-1");
    const firstMessage = createManagedMessage("incident-1", "channel-1", "NormJS Status Incident");
    const duplicateMessage = createManagedMessage("incident-2", "channel-1", "NormJS Status Incident");

    const nextMessages = await reconcileKeyedTrackedMessages({
      channel,
      labelPrefix: "api-status:guild-1",
      payloads: [
        {
          key: "incident:service:elastic",
          payload: createEmbedPayload("NormJS Status Incident", "Incident - Elastic Cloud"),
        },
      ],
      priority: "low",
      scheduler,
      trackedMessages: [
        { key: "incident:service:elastic", message: firstMessage },
        { key: "incident:service:elastic", message: duplicateMessage },
      ],
    });

    expect(firstMessage.edit).toHaveBeenCalledTimes(1);
    expect(duplicateMessage.delete).toHaveBeenCalledTimes(1);
    expect(nextMessages).toHaveLength(1);
    expect(nextMessages[0]?.message).toBe(firstMessage);
  });

  it("serializes overlapping publish passes so one incident key cannot be posted twice", async () => {
    const service = createService({
      id: "elastic",
      name: "Elastic Cloud",
      pageUrl: "https://status.elastic.co/",
      type: "statuspage",
    });
    const firstStatus = createStatus(service, {
      description: "Elastic incident 1",
      incidents: [
        {
          created_at: "2026-04-04T18:00:00.000Z",
          id: "incident-1",
          incident_updates: [],
          name: "Elastic incident 1",
          shortlink: "https://status.elastic.co/incidents/incident-1",
          status: "identified",
        },
      ],
      status: "partial_outage",
    });
    const secondStatus = createStatus(service, {
      description: "Elastic incident 1 updated",
      incidents: [
        {
          created_at: "2026-04-04T18:00:00.000Z",
          id: "incident-1",
          incident_updates: [
            {
              body: "Updated incident body",
              created_at: "2026-04-04T18:05:00.000Z",
            },
          ],
          name: "Elastic incident 1",
          shortlink: "https://status.elastic.co/incidents/incident-1",
          status: "identified",
        },
      ],
      status: "partial_outage",
    });
    const checkService = jest
      .fn<Promise<ServiceStatus>, [ServiceConfig]>()
      .mockResolvedValueOnce(firstStatus)
      .mockResolvedValueOnce(secondStatus);
    const runtime = new ApiStatusRuntime(new DiscordWorkScheduler(1, 0), {
      catalog: createCatalog([{ name: "Monitoring", services: [service] }], [{ categoryName: "Monitoring", service }]),
      checkService,
      generalSweepMs: 5,
      publishDebounceMs: 0,
    });
    const channel = createChannel("channel-1");
    const blockedIncidentSend = createDeferred<Message>();
    let incidentSendReleased = false;
    const originalSend = channel.send as jest.Mock;

    originalSend.mockImplementation(async (payload: unknown) => {
      const embed = asEmbedPayload(payload).embeds?.[0];
      const title = embed?.toJSON().title;

      if (title === "Incident - Elastic Cloud") {
        return await blockedIncidentSend.promise;
      }

      const footerText = embed?.toJSON().footer?.text ?? "NormJS Status Summary | Page 1";
      const message = createManagedMessage(`sent-${channel.id}-${channel.__sentMessages.length + 1}`, channel.id, footerText);
      channel.__sentMessages.push(message);
      return message;
    });

    try {
      await runtime.registerGuild("guild-1", channel);

      await jest.advanceTimersByTimeAsync(1);
      await flushScheduler();
      expect(originalSend).toHaveBeenCalledWith(
        expect.objectContaining({
          embeds: expect.any(Array),
        })
      );

      await jest.advanceTimersByTimeAsync(5);
      await flushScheduler();

      const incidentMessage = createManagedMessage("elastic-incident", "channel-1", "NormJS Status Incident");
      incidentSendReleased = true;
      blockedIncidentSend.resolve(incidentMessage as unknown as Message);
      await flushScheduler();
      await jest.advanceTimersByTimeAsync(0);
      await flushScheduler();

      const incidentCreates = originalSend.mock.calls.filter((call) => {
        const embed = asEmbedPayload(call[0]).embeds?.[0];
        return embed?.toJSON().title === "Incident - Elastic Cloud";
      });

      expect(incidentCreates).toHaveLength(1);
      expect(incidentMessage.edit).toHaveBeenCalledTimes(1);
    } finally {
      if (!incidentSendReleased) {
        incidentSendReleased = true;
        blockedIncidentSend.resolve(createManagedMessage("elastic-cleanup", "channel-1") as unknown as Message);
      }
      await runtime.dispose();
    }
  });
});
