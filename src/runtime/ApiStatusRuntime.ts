import { BaseMessageOptions, EmbedBuilder, Message, TextChannel } from "discord.js";
import { IncidentInfo, fetchAllStatuses, ServiceStatus, summarizeIssues } from "../services/ApiStatusService";
import { DiscordWorkScheduler } from "./DiscordWorkScheduler";
import { reconcileTrackedMessages } from "./reconcileTrackedMessages";

type StatusCategory = {
  name: string;
  services: ServiceStatus[];
};

type RegisteredChannel = {
  channel: TextChannel;
  messages: Message[];
};

const SUMMARY_MARKER = "NormJS Status Summary";
const INCIDENT_MARKER = "NormJS Status Incident";
const MAX_EMBED_TOTAL_LENGTH = 6000;
const MAX_EMBED_DESCRIPTION_LENGTH = 4096;
const MAX_EMBED_FIELD_NAME_LENGTH = 256;
const MAX_EMBED_FIELD_VALUE_LENGTH = 1024;
const MAX_EMBED_FIELDS = 25;
const SUMMARY_COLOR = 0x60a5fa;

export class ApiStatusRuntime {
  private readonly registrations = new Map<string, RegisteredChannel>();
  private refreshInFlight: Promise<void> | null = null;
  private refreshQueued = false;
  private disposed = false;
  private latestPayloads: BaseMessageOptions[] | null = null;
  private latestSnapshotAt = 0;
  private pollTimer: NodeJS.Timeout | null = null;
  private hasIssues = false;

  constructor(
    private readonly scheduler: DiscordWorkScheduler,
    private readonly issuePollMs = 5 * 60 * 1000,
    private readonly stablePollMs = 30 * 60 * 1000,
    private readonly snapshotFreshMs = 60 * 1000
  ) {}

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.refreshQueued = false;
    await this.refreshInFlight;
    this.registrations.clear();
  }

  async registerGuild(guildId: string, channel: TextChannel): Promise<void> {
    const registration = this.registrations.get(guildId);
    if (registration) {
      registration.channel = channel;
      if (!registration.messages.every((message) => message.channelId === channel.id)) {
        registration.messages = await this.discoverManagedMessages(channel);
      }
    } else {
      this.registrations.set(guildId, {
        channel,
        messages: await this.discoverManagedMessages(channel),
      });
    }

    if (this.hasFreshSnapshot()) {
      await this.publishRegistration(guildId, this.registrations.get(guildId)!);
      this.scheduleNextRefresh();
      return;
    }

    await this.requestRefresh();
  }

  unregisterGuild(guildId: string): void {
    this.registrations.delete(guildId);
    if (this.registrations.size === 0 && this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async discoverManagedMessages(channel: TextChannel): Promise<Message[]> {
    const currentUserId = channel.client.user?.id;
    if (!currentUserId) {
      return [];
    }

    const messages = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    if (!messages) {
      return [];
    }

    return messages
      .filter((message) => {
        const footerText = message.embeds[0]?.footer?.text ?? "";
        return (
          message.author.id === currentUserId &&
          (footerText.startsWith(SUMMARY_MARKER) || footerText.startsWith(INCIDENT_MARKER))
        );
      })
      .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
      .map((message) => message);
  }

  private scheduleNextRefresh(): void {
    if (this.disposed || this.registrations.size === 0) {
      return;
    }

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }

    const nextPollMs = this.hasIssues ? this.issuePollMs : this.stablePollMs;
    this.pollTimer = setTimeout(() => {
      void this.requestRefresh();
    }, nextPollMs);
  }

  private async requestRefresh(): Promise<void> {
    if (this.disposed || this.registrations.size === 0) {
      return;
    }

    if (this.refreshInFlight) {
      this.refreshQueued = true;
      return this.refreshInFlight;
    }

    this.refreshInFlight = this.refreshAllGuilds()
      .catch((error) => {
        console.error("[ApiStatusRuntime] Failed to refresh API status snapshot:", error);
      })
      .finally(() => {
        this.refreshInFlight = null;
      });

    await this.refreshInFlight;

    if (this.refreshQueued && !this.disposed) {
      this.refreshQueued = false;
      await this.requestRefresh();
      return;
    }

    this.scheduleNextRefresh();
  }

  private async refreshAllGuilds(): Promise<void> {
    const { categories } = await fetchAllStatuses();
    const displayCategories = prepareCategoriesForDisplay(categories);
    const payloads = buildStatusPayloads(displayCategories);
    this.hasIssues = summarizeIssues(displayCategories).issues > 0;
    this.latestPayloads = payloads;
    this.latestSnapshotAt = Date.now();

    for (const [guildId, registration] of this.registrations.entries()) {
      await this.publishRegistration(guildId, registration);
    }
  }

  private hasFreshSnapshot(): boolean {
    return this.latestPayloads !== null && Date.now() - this.latestSnapshotAt <= this.snapshotFreshMs;
  }

  private async publishRegistration(guildId: string, registration: RegisteredChannel): Promise<void> {
    if (!this.latestPayloads) {
      return;
    }

    try {
      registration.messages = await reconcileTrackedMessages({
        channel: registration.channel,
        labelPrefix: `api-status:${guildId}`,
        payloads: this.latestPayloads,
        priority: "low",
        scheduler: this.scheduler,
        trackedMessages: registration.messages,
      });
    } catch (error) {
      console.error(`[ApiStatusRuntime] Failed to publish API status for guild ${guildId}:`, error);
    }
  }
}

function buildStatusPayloads(categories: StatusCategory[]): BaseMessageOptions[] {
  return [...buildSummaryPayloads(categories), ...buildIncidentPayloads(categories)];
}

function buildSummaryPayloads(categories: StatusCategory[]): BaseMessageOptions[] {
  const summary = summarizeIssues(categories);
  const pages: EmbedBuilder[] = [];
  let page = createSummaryEmbed(summary, 1);
  let fieldCount = 0;
  let embedLength = calculateSummaryBaseLength(summary, 1);
  let pageNumber = 1;

  const pushPage = () => {
    pages.push(page);
    pageNumber += 1;
    page = createSummaryEmbed(summary, pageNumber);
    fieldCount = 0;
    embedLength = calculateSummaryBaseLength(summary, pageNumber);
  };

  for (const category of categories) {
    const lines = category.services.map((service) => formatServiceLine(service));
    const chunks = splitFieldLines(lines, MAX_EMBED_FIELD_VALUE_LENGTH);

    for (const [index, chunk] of chunks.entries()) {
      const fieldName = truncate(
        index === 0 ? category.name : `${category.name} (cont. ${index})`,
        MAX_EMBED_FIELD_NAME_LENGTH
      );
      const fieldValue = chunk.join("\n");
      const fieldLength = fieldName.length + fieldValue.length;

      if (
        fieldCount >= MAX_EMBED_FIELDS ||
        (fieldCount > 0 && embedLength + fieldLength > MAX_EMBED_TOTAL_LENGTH)
      ) {
        pushPage();
      }

      page.addFields({
        inline: false,
        name: fieldName,
        value: fieldValue,
      });
      fieldCount += 1;
      embedLength += fieldLength;
    }
  }

  pages.push(page);
  return pages.map((embed) => ({ embeds: [embed] }));
}

function buildIncidentPayloads(categories: StatusCategory[]): BaseMessageOptions[] {
  const incidentEmbeds: BaseMessageOptions[] = [];

  for (const category of categories) {
    for (const service of category.services) {
      if (!service.incidents || service.incidents.length === 0) {
        continue;
      }

      const latestIncident = service.incidents[0];
      const updates = (latestIncident.incident_updates ?? [])
        .slice(0, 5)
        .map(
          (update) =>
            `- <t:${Math.floor(new Date(update.created_at).getTime() / 1000)}:R> ${truncate(update.body, 850)}`
        );

      incidentEmbeds.push(
        ...buildIncidentEmbeds({
          incidentName: latestIncident.name,
          incidentUrl: latestIncident.shortlink ?? service.pageUrl,
          service,
          updateLines: updates,
        }).map((embed) => ({ embeds: [embed] }))
      );
    }
  }

  return incidentEmbeds;
}

function createSummaryEmbed(summary: ReturnType<typeof summarizeIssues>, pageNumber: number): EmbedBuilder {
  const description = buildSummaryDescription(summary);
  return new EmbedBuilder()
    .setColor(SUMMARY_COLOR)
    .setDescription(description)
    .setFooter({ text: `${SUMMARY_MARKER} | Page ${pageNumber}` })
    .setTitle(`API and Platform Status (Page ${pageNumber})`);
}

function buildSummaryDescription(summary: ReturnType<typeof summarizeIssues>): string {
  const header =
    `Last updated: <t:${Math.floor(Date.now() / 1000)}:R>\n` +
    `Operational: ${summary.operational} | Issues: ${summary.issues}`;

  return truncate(
    `${header}${summary.critical > 0 ? ` | Critical: ${summary.critical}` : ""}`,
    MAX_EMBED_DESCRIPTION_LENGTH
  );
}

function calculateSummaryBaseLength(summary: ReturnType<typeof summarizeIssues>, pageNumber: number): number {
  const title = `API and Platform Status (Page ${pageNumber})`;
  const footer = `${SUMMARY_MARKER} | Page ${pageNumber}`;
  return title.length + buildSummaryDescription(summary).length + footer.length;
}

function splitFieldLines(lines: string[], maxLength: number): string[][] {
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentLength = 0;

  for (const line of lines) {
    const safeLine = truncate(line, maxLength - 5);
    const lineLength = safeLine.length + 1;

    if (currentLength + lineLength > maxLength && current.length > 0) {
      chunks.push(current);
      current = [];
      currentLength = 0;
    }

    current.push(safeLine);
    currentLength += lineLength;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

function buildIncidentEmbeds({
  incidentName,
  incidentUrl,
  service,
  updateLines,
}: {
  incidentName: string;
  incidentUrl: string;
  service: ServiceStatus;
  updateLines: string[];
}): EmbedBuilder[] {
  const description = truncate(service.description || service.status, 500);
  const title = truncate(`Incident - ${service.name}`, MAX_EMBED_FIELD_NAME_LENGTH);
  const updateChunks = splitFieldLines(
    updateLines.length > 0 ? updateLines : ["No additional incident updates were provided."],
    MAX_EMBED_FIELD_VALUE_LENGTH
  );
  const latestIncidentAt =
    service.incidents?.find((incident) => incident.created_at)?.created_at ?? service.lastChecked.toISOString();
  const statusPageValue = `[Status Page](${incidentUrl})`;
  const statusPageFieldLength = incidentName.length + statusPageValue.length;

  const embeds: EmbedBuilder[] = [];
  let pageNumber = 1;
  let embed = createIncidentEmbed({
    description,
    incidentUrl,
    latestIncidentAt,
    pageNumber,
    service,
    title,
  });
  let fieldCount = 0;
  let embedLength = calculateIncidentBaseLength({
    description,
    latestIncidentAt,
    pageNumber,
    serviceTitle: title,
    status: service.status,
  }) + statusPageFieldLength;

  embed.addFields({
    inline: false,
    name: truncate(incidentName, MAX_EMBED_FIELD_NAME_LENGTH),
    value: statusPageValue,
  });

  const pushEmbed = () => {
    embeds.push(embed);
    pageNumber += 1;
    embed = createIncidentEmbed({
      description,
      incidentUrl,
      latestIncidentAt,
      pageNumber,
      service,
      title,
    });
    fieldCount = 0;
    embedLength = calculateIncidentBaseLength({
      description,
      latestIncidentAt,
      pageNumber,
      serviceTitle: title,
      status: service.status,
    }) + statusPageFieldLength;
    embed.addFields({
      inline: false,
      name: truncate(incidentName, MAX_EMBED_FIELD_NAME_LENGTH),
      value: statusPageValue,
    });
  };

  for (const [index, chunk] of updateChunks.entries()) {
    const fieldName = truncate(
      updateChunks.length > 1 ? `Updates (${index + 1}/${updateChunks.length})` : "Updates",
      MAX_EMBED_FIELD_NAME_LENGTH
    );
    const fieldValue = chunk.join("\n");
    const fieldLength = fieldName.length + fieldValue.length;

    if (
      fieldCount >= MAX_EMBED_FIELDS ||
      (fieldCount > 0 && embedLength + fieldLength > MAX_EMBED_TOTAL_LENGTH)
    ) {
      pushEmbed();
    }

    embed.addFields({
      inline: false,
      name: fieldName,
      value: fieldValue,
    });
    fieldCount += 1;
    embedLength += fieldLength;
  }

  embeds.push(embed);
  return embeds;
}

function createIncidentEmbed({
  description,
  latestIncidentAt,
  incidentUrl,
  pageNumber,
  service,
  title,
}: {
  description: string;
  latestIncidentAt: string | undefined;
  incidentUrl: string;
  pageNumber: number;
  service: ServiceStatus;
  title: string;
}): EmbedBuilder {
  const footerText = pageNumber > 1 ? `${INCIDENT_MARKER} | Page ${pageNumber}` : INCIDENT_MARKER;
  const summaryLine = description || humanizeStatus(service.status);
  const relativeTimestamp =
    latestIncidentAt && !Number.isNaN(Date.parse(latestIncidentAt))
      ? `<t:${Math.floor(Date.parse(latestIncidentAt) / 1000)}:R>`
      : `<t:${Math.floor(service.lastChecked.getTime() / 1000)}:R>`;

  return new EmbedBuilder()
    .setColor(statusColor(service.status))
    .setDescription(`${statusEmoji(service.status)} ${summaryLine}\nLast updated: ${relativeTimestamp}`)
    .setFooter({ text: footerText })
    .setTitle(title)
    .setTimestamp(service.lastChecked)
    .setURL(incidentUrl);
}

function calculateIncidentBaseLength({
  description,
  latestIncidentAt,
  pageNumber,
  serviceTitle,
  status,
}: {
  description: string;
  latestIncidentAt: string | undefined;
  pageNumber: number;
  serviceTitle: string;
  status: ServiceStatus["status"];
}): number {
  const footerText = pageNumber > 1 ? `${INCIDENT_MARKER} | Page ${pageNumber}` : INCIDENT_MARKER;
  const relativeTimestamp =
    latestIncidentAt && !Number.isNaN(Date.parse(latestIncidentAt))
      ? `<t:${Math.floor(Date.parse(latestIncidentAt) / 1000)}:R>`
      : `<t:${Math.floor(Date.now() / 1000)}:R>`;
  const incidentSummary =
    `${statusEmoji(status)} ${description || humanizeStatus(status)}\n` + `Last updated: ${relativeTimestamp}`;
  return serviceTitle.length + incidentSummary.length + footerText.length;
}

function formatServiceLine(service: ServiceStatus): string {
  const description = truncate(formatSummaryServiceDescription(service), 140);
  const suffix = description ? ` - ${description}` : "";
  return `${statusEmoji(service.status)} ${service.name}${suffix}`;
}

function statusColor(status: ServiceStatus["status"]): number {
  switch (status) {
    case "major_outage":
      return 0xb91c1c;
    case "partial_outage":
    case "degraded_performance":
    case "under_maintenance":
      return 0xea580c;
    case "operational":
      return 0x16a34a;
    default:
      return 0x2563eb;
  }
}

function statusEmoji(status: ServiceStatus["status"]): string {
  switch (status) {
    case "operational":
      return "✅";
    case "degraded_performance":
      return "🟡";
    case "partial_outage":
      return "🟠";
    case "major_outage":
      return "🔴";
    case "under_maintenance":
      return "🛠️";
    default:
      return "⚪";
  }
}

function formatSummaryServiceDescription(service: ServiceStatus): string {
  const description = (service.description ?? "").trim();

  if (!description) {
    return service.status === "operational" ? "" : humanizeStatus(service.status);
  }

  return description;
}

function humanizeStatus(status: ServiceStatus["status"]): string {
  switch (status) {
    case "operational":
      return "All Systems Operational";
    case "degraded_performance":
      return "Partially Degraded Service";
    case "partial_outage":
      return "Partial Outage";
    case "major_outage":
      return "Major Outage";
    case "under_maintenance":
      return "Maintenance in progress";
    default:
      return "Status unavailable";
  }
}

function prepareCategoriesForDisplay(categories: StatusCategory[]): StatusCategory[] {
  return categories.map((category) => ({
    name: category.name,
    services: collapseGroupedServices(category.services),
  }));
}

function collapseGroupedServices(services: ServiceStatus[]): ServiceStatus[] {
  const childrenByGroupId = new Map<string, ServiceStatus[]>();
  for (const service of services) {
    if (!service.groupId) {
      continue;
    }

    const groupChildren = childrenByGroupId.get(service.groupId) ?? [];
    groupChildren.push(service);
    childrenByGroupId.set(service.groupId, groupChildren);
  }

  const collapsed: ServiceStatus[] = [];
  for (const service of services) {
    if (service.groupId) {
      continue;
    }

    if (!service.isGroupRoot) {
      collapsed.push(service);
      continue;
    }

    const groupChildren = childrenByGroupId.get(service.id) ?? [];
    collapsed.push(groupChildren.length > 0 ? aggregateGroupedService(service, groupChildren) : service);
  }

  return collapsed;
}

function aggregateGroupedService(root: ServiceStatus, children: ServiceStatus[]): ServiceStatus {
  const members = [root, ...children];
  const worstMember = members.reduce((currentWorst, member) =>
    compareStatusSeverity(member.status, currentWorst.status) > 0 ? member : currentWorst
  );
  const status = worstMember.status;
  const lastChecked = new Date(
    Math.max(...members.map((member) => new Date(member.lastChecked).getTime()))
  );
  const incidents = flattenGroupedIncidents(root, members);

  return {
    ...root,
    description: buildGroupedDescription(root, worstMember, status),
    incidents,
    lastChecked,
    status,
  };
}

function compareStatusSeverity(left: ServiceStatus["status"], right: ServiceStatus["status"]): number {
  return statusSeverity(left) - statusSeverity(right);
}

function statusSeverity(status: ServiceStatus["status"]): number {
  switch (status) {
    case "major_outage":
      return 5;
    case "partial_outage":
      return 4;
    case "degraded_performance":
      return 3;
    case "under_maintenance":
      return 2;
    case "operational":
      return 1;
    default:
      return 0;
  }
}

function buildGroupedDescription(
  root: ServiceStatus,
  worstMember: ServiceStatus,
  status: ServiceStatus["status"]
): string {
  if (status === "operational") {
    return "";
  }

  const worstDescription = (worstMember.description ?? "").trim();
  const detail = worstDescription || humanizeStatus(status);
  if (worstMember.id === root.id) {
    return detail;
  }

  return `${getGroupedChildLabel(root, worstMember)} - ${detail}`;
}

function flattenGroupedIncidents(root: ServiceStatus, members: ServiceStatus[]): IncidentInfo[] {
  return members
    .flatMap((member) => {
      const incidents = member.incidents ?? [];
      if (member.id === root.id) {
        return incidents;
      }

      return incidents.map((incident) => ({
        ...incident,
        name: `${getGroupedChildLabel(root, member)} - ${incident.name}`,
      }));
    })
    .sort((left, right) => {
      const leftTime = Date.parse(left.created_at ?? "");
      const rightTime = Date.parse(right.created_at ?? "");
      return (Number.isNaN(rightTime) ? 0 : rightTime) - (Number.isNaN(leftTime) ? 0 : leftTime);
    });
}

function getGroupedChildLabel(root: ServiceStatus, member: ServiceStatus): string {
  const prefix = `${root.name} `;
  if (member.name.startsWith(prefix)) {
    return member.name.slice(prefix.length);
  }

  return member.name;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}
