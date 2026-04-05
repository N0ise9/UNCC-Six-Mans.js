import { BaseMessageOptions, EmbedBuilder, Message, TextChannel } from "discord.js";
import {
  ApiStatusCatalog,
  IncidentInfo,
  ServiceConfig,
  ServiceStatus,
  StatusLevel,
  checkSingleService,
  createUnknownServiceStatus,
  getApiStatusCatalog,
  summarizeIssues,
} from "../services/ApiStatusService";
import { DiscordWorkScheduler } from "./DiscordWorkScheduler";
import { reconcileKeyedTrackedMessages } from "./reconcileTrackedMessages";

type StatusCategory = {
  name: string;
  services: ServiceStatus[];
};

type KeyedStatusPayload = {
  key: string;
  payload: BaseMessageOptions;
};

type KeyedTrackedMessage = {
  key: string;
  message: Message;
};

type RegisteredChannel = {
  channel: TextChannel;
  messages: KeyedTrackedMessage[];
};

type PollBranch = "aws" | "general";
type PollKind = "hot" | "normal" | "retry";

type PollRecord = {
  branch: PollBranch;
  categoryName: string;
  consecutiveFailures: number;
  displayed: ServiceStatus;
  lastGood: ServiceStatus | null;
  nextHotAt: number | null;
  nextNormalAt: number;
  nextRetryAt: number | null;
  service: ServiceConfig;
};

type PollCandidate = {
  dueAt: number;
  kind: PollKind;
  record: PollRecord;
};

type ApiStatusRuntimeOptions = {
  awsSweepMs?: number;
  catalog?: ApiStatusCatalog;
  checkService?: (service: ServiceConfig) => Promise<ServiceStatus>;
  generalSweepMs?: number;
  hotPollMs?: number;
  hotSpreadMs?: number;
  now?: () => number;
  publishDebounceMs?: number;
  retryMs?: number;
};

const SUMMARY_MARKER = "NormJS Status Summary";
const INCIDENT_MARKER = "NormJS Status Incident";
const MAX_EMBED_TOTAL_LENGTH = 6000;
const MAX_EMBED_DESCRIPTION_LENGTH = 4096;
const MAX_EMBED_TITLE_LENGTH = 256;
const MAX_EMBED_FIELD_NAME_LENGTH = 256;
const MAX_EMBED_FIELD_VALUE_LENGTH = 1024;
const MAX_EMBED_FIELDS = 25;
const SUMMARY_COLOR = 0x60a5fa;

export class ApiStatusRuntime {
  private readonly registrations = new Map<string, RegisteredChannel>();
  private readonly catalog: ApiStatusCatalog;
  private readonly checkService: (service: ServiceConfig) => Promise<ServiceStatus>;
  private readonly now: () => number;
  private readonly awsSweepMs: number;
  private readonly generalSweepMs: number;
  private readonly retryMs: number;
  private readonly hotPollMs: number;
  private readonly hotSpreadMs: number;
  private readonly publishDebounceMs: number;
  private readonly generalRecords: PollRecord[];
  private readonly awsRecords: PollRecord[];
  private readonly recordsById = new Map<string, PollRecord>();
  private disposed = false;
  private latestPayloads: KeyedStatusPayload[] | null = null;
  private latestSnapshotAt = 0;
  private pollInFlight = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private publishTimer: NodeJS.Timeout | null = null;

  constructor(private readonly scheduler: DiscordWorkScheduler, options: ApiStatusRuntimeOptions = {}) {
    this.catalog = options.catalog ?? getApiStatusCatalog();
    this.checkService = options.checkService ?? checkSingleService;
    this.now = options.now ?? Date.now;
    this.awsSweepMs = options.awsSweepMs ?? 15 * 60 * 1000;
    this.generalSweepMs = options.generalSweepMs ?? 15 * 60 * 1000;
    this.retryMs = options.retryMs ?? 2 * 60 * 1000;
    this.hotPollMs = options.hotPollMs ?? 5 * 60 * 1000;
    this.hotSpreadMs = options.hotSpreadMs ?? 60 * 1000;
    this.publishDebounceMs = options.publishDebounceMs ?? 1_000;

    const now = this.now();
    this.generalRecords = initializePollRecords(this.catalog.generalServices, "general", this.generalSweepMs, now);
    this.awsRecords = initializePollRecords(
      this.catalog.awsRoot ? [this.catalog.awsRoot, ...this.catalog.awsChildren] : [],
      "aws",
      this.awsSweepMs,
      now
    );

    for (const record of [...this.generalRecords, ...this.awsRecords]) {
      this.recordsById.set(record.service.id, record);
    }

    this.refreshLatestPayloads();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.publishTimer) {
      clearTimeout(this.publishTimer);
      this.publishTimer = null;
    }
    while (this.pollInFlight) {
      await delay(10);
    }
    this.registrations.clear();
  }

  async registerGuild(guildId: string, channel: TextChannel): Promise<void> {
    const registration = this.registrations.get(guildId);
    if (registration) {
      registration.channel = channel;
      if (!registration.messages.every((trackedMessage) => trackedMessage.message.channelId === channel.id)) {
        const existingMessages = await this.fetchManagedStatusMessages(channel);
        await this.deleteManagedStatusMessages(existingMessages, guildId);
        registration.messages = [];
      }
    } else {
      const existingMessages = await this.fetchManagedStatusMessages(channel);
      await this.deleteManagedStatusMessages(existingMessages, guildId);
      this.registrations.set(guildId, {
        channel,
        messages: [],
      });
    }

    await this.publishRegistration(guildId, this.registrations.get(guildId)!);
    this.scheduleNextPoll();
  }

  unregisterGuild(guildId: string): void {
    this.registrations.delete(guildId);
    if (this.registrations.size === 0) {
      if (this.pollTimer) {
        clearTimeout(this.pollTimer);
        this.pollTimer = null;
      }
      if (this.publishTimer) {
        clearTimeout(this.publishTimer);
        this.publishTimer = null;
      }
    }
  }

  private async fetchManagedStatusMessages(channel: TextChannel): Promise<Message[]> {
    const currentUserId = channel.client.user?.id;
    if (!currentUserId) {
      return [];
    }

    const managedMessages: Message[] = [];
    let beforeMessageId: string | undefined;

    while (true) {
      const messages = await channel.messages.fetch({ before: beforeMessageId, limit: 100 }).catch(() => null);
      if (!messages || messages.size === 0) {
        break;
      }

      const pageMessages = messages
        .filter((message) => {
          const footerText = message.embeds[0]?.footer?.text ?? "";
          return (
            message.author.id === currentUserId &&
            (footerText.includes(SUMMARY_MARKER) || footerText.includes(INCIDENT_MARKER))
          );
        })
        .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
        .map((message) => message);

      managedMessages.push(...pageMessages);

      if (messages.size < 100) {
        break;
      }

      beforeMessageId = messages.last()?.id;
      if (!beforeMessageId) {
        break;
      }
    }

    return managedMessages;
  }

  private async deleteManagedStatusMessages(messages: Message[], guildId: string): Promise<void> {
    for (const message of messages) {
      try {
        await this.scheduler.enqueue(async () => await message.delete().catch(() => undefined), {
          coalesce: "replace",
          dedupeKey: `message-delete:${message.id}`,
          label: `api-status:${guildId}:startup-delete:${message.id}`,
          priority: "low",
        });
      } catch (error) {
        console.warn(`[ApiStatusRuntime] Failed to delete stale API status message ${message.id}:`, error);
      }
    }
  }

  private scheduleNextPoll(): void {
    if (this.disposed || this.registrations.size === 0 || this.pollInFlight) {
      return;
    }

    const candidate = this.pickNextPollCandidate();
    if (!candidate) {
      return;
    }

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }

    const delayMs = Math.max(0, candidate.dueAt - this.now());
    this.pollTimer = setTimeout(() => {
      void this.runNextPoll();
    }, delayMs);
  }

  private pickNextPollCandidate(): PollCandidate | null {
    let best: PollCandidate | null = null;

    for (const record of this.recordsById.values()) {
      const candidates = [
        record.nextRetryAt === null ? null : { dueAt: record.nextRetryAt, kind: "retry" as const, record },
        record.nextHotAt === null ? null : { dueAt: record.nextHotAt, kind: "hot" as const, record },
        { dueAt: record.nextNormalAt, kind: "normal" as const, record },
      ];

      for (const candidate of candidates) {
        if (!candidate) {
          continue;
        }

        if (
          !best ||
          candidate.dueAt < best.dueAt ||
          (candidate.dueAt === best.dueAt && pollPriority(candidate.kind) < pollPriority(best.kind))
        ) {
          best = candidate;
        }
      }
    }

    return best;
  }

  private async runNextPoll(): Promise<void> {
    if (this.disposed || this.registrations.size === 0) {
      return;
    }

    const candidate = this.pickNextPollCandidate();
    if (!candidate) {
      return;
    }

    this.pollInFlight = true;
    try {
      await this.pollRecord(candidate);
    } catch (error) {
      console.error("[ApiStatusRuntime] Failed to poll API status snapshot:", error);
    } finally {
      this.pollInFlight = false;
      this.scheduleNextPoll();
    }
  }

  private async pollRecord(candidate: PollCandidate): Promise<void> {
    const now = this.now();
    const previousVisible =
      candidate.record.branch === "aws" ? this.getAwsDisplayStatus() : cloneServiceStatus(candidate.record.displayed);

    let result: ServiceStatus;
    try {
      result = await this.checkService(candidate.record.service);
    } catch (error) {
      console.warn(`[ApiStatusRuntime] Service poll failed for ${candidate.record.service.id}:`, error);
      result = createFailureStatus(candidate.record.service, now);
    }

    this.applyPollResult(candidate.record, candidate.kind, result, now);

    const nextVisible = candidate.record.branch === "aws" ? this.getAwsDisplayStatus() : candidate.record.displayed;
    if (!areServiceStatusesEquivalent(previousVisible, nextVisible)) {
      this.schedulePublish();
    }
  }

  private applyPollResult(record: PollRecord, kind: PollKind, result: ServiceStatus, checkedAt: number): void {
    record.nextNormalAt = checkedAt + this.getBranchSweepMs(record.branch);
    if (kind === "retry") {
      record.nextRetryAt = null;
    }
    if (kind === "hot") {
      record.nextHotAt = null;
    }

    if (isFailedCheck(result)) {
      this.applyFailedPollResult(record, checkedAt);
    } else {
      this.applySuccessfulPollResult(record, result, checkedAt);
    }

    if (record.branch === "aws") {
      this.syncAwsHotLane(checkedAt);
    }
  }

  private applyFailedPollResult(record: PollRecord, checkedAt: number): void {
    if (record.lastGood && record.consecutiveFailures === 0) {
      record.consecutiveFailures = 1;
      record.nextRetryAt = checkedAt + this.retryMs;
      record.nextHotAt = null;
      return;
    }

    record.consecutiveFailures = Math.min(record.consecutiveFailures + 1, 2);
    record.displayed = createFailureStatus(record.service, checkedAt);
    record.nextRetryAt = null;
    record.nextHotAt = null;
  }

  private applySuccessfulPollResult(record: PollRecord, result: ServiceStatus, checkedAt: number): void {
    record.consecutiveFailures = 0;
    record.displayed = result;
    record.lastGood = result;
    record.nextRetryAt = null;

    if (record.branch === "general") {
      record.nextHotAt = shouldHotPoll(result.status)
        ? checkedAt + this.hotPollMs + getHotOffsetMs(record.service.id, this.hotSpreadMs)
        : null;
    }
  }

  private syncAwsHotLane(checkedAt: number): void {
    const awsDisplayStatus = this.getAwsDisplayStatus();
    const shouldHotPollAws = shouldHotPoll(awsDisplayStatus.status);

    for (const record of this.awsRecords) {
      if (record.nextRetryAt !== null) {
        record.nextHotAt = null;
        continue;
      }

      record.nextHotAt = shouldHotPollAws
        ? checkedAt + this.hotPollMs + getHotOffsetMs(record.service.id, this.hotSpreadMs)
        : null;
    }
  }

  private schedulePublish(): void {
    if (this.disposed || this.registrations.size === 0 || this.publishTimer) {
      return;
    }

    this.publishTimer = setTimeout(() => {
      void this.publishAllGuilds();
    }, this.publishDebounceMs);
  }

  private async publishAllGuilds(): Promise<void> {
    this.publishTimer = null;
    this.refreshLatestPayloads();

    for (const [guildId, registration] of this.registrations.entries()) {
      await this.publishRegistration(guildId, registration);
    }
  }

  private refreshLatestPayloads(): void {
    const snapshotAt = this.now();
    this.latestPayloads = buildStatusPayloads(this.buildDisplayCategories(), snapshotAt);
    this.latestSnapshotAt = snapshotAt;
  }

  private buildDisplayCategories(): StatusCategory[] {
    const awsDisplayStatus = this.getAwsDisplayStatus();

    return this.catalog.displayCategories.map((category) => ({
      name: category.name,
      services: category.services
        .map((service) => {
          if (service.id === this.catalog.awsRoot?.service.id) {
            return awsDisplayStatus;
          }

          return this.recordsById.get(service.id)?.displayed ?? createUnknownServiceStatus(service);
        })
        .filter((service): service is ServiceStatus => service !== null),
    }));
  }

  private getAwsDisplayStatus(): ServiceStatus {
    if (!this.catalog.awsRoot) {
      return createUnknownServiceStatus(
        {
          id: "aws",
          isGroupRoot: true,
          name: "AWS",
          pageUrl: "https://health.aws.amazon.com/health/status",
          type: "generic",
        },
        "AWS status is not configured."
      );
    }

    const rootRecord = this.recordsById.get(this.catalog.awsRoot.service.id);
    const rootStatus = rootRecord?.displayed ?? createUnknownServiceStatus(this.catalog.awsRoot.service);
    const childStatuses = this.catalog.awsChildren
      .map((entry) => this.recordsById.get(entry.service.id)?.displayed ?? null)
      .filter((service): service is ServiceStatus => service !== null);

    return childStatuses.length > 0 ? aggregateGroupedService(rootStatus, childStatuses) : rootStatus;
  }

  private getBranchSweepMs(branch: PollBranch): number {
    return branch === "aws" ? this.awsSweepMs : this.generalSweepMs;
  }

  private async publishRegistration(guildId: string, registration: RegisteredChannel): Promise<void> {
    if (!this.latestPayloads) {
      return;
    }

    try {
      registration.messages = await reconcileKeyedTrackedMessages({
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

function initializePollRecords(
  entries: Array<{ categoryName: string; service: ServiceConfig }>,
  branch: PollBranch,
  sweepMs: number,
  startedAt: number
): PollRecord[] {
  const spacingMs = entries.length > 0 ? Math.max(1, Math.floor(sweepMs / entries.length)) : sweepMs;

  return entries.map((entry, index) => ({
    branch,
    categoryName: entry.categoryName,
    consecutiveFailures: 0,
    displayed: createUnknownServiceStatus(entry.service),
    lastGood: null,
    nextHotAt: null,
    nextNormalAt: startedAt + spacingMs * index,
    nextRetryAt: null,
    service: entry.service,
  }));
}

function pollPriority(kind: PollKind): number {
  switch (kind) {
    case "retry":
      return 0;
    case "hot":
      return 1;
    case "normal":
      return 2;
  }
}

function isFailedCheck(serviceStatus: ServiceStatus): boolean {
  return serviceStatus.status === "unknown";
}

function shouldHotPoll(status: StatusLevel): boolean {
  return status !== "operational" && status !== "unknown";
}

function createFailureStatus(service: ServiceConfig, checkedAt: number): ServiceStatus {
  return {
    ...createUnknownServiceStatus(service, "Unreachable"),
    lastChecked: new Date(checkedAt),
  };
}

function cloneServiceStatus(service: ServiceStatus): ServiceStatus {
  return {
    ...service,
    incidents: service.incidents?.map((incident) => ({
      ...incident,
      incident_updates: incident.incident_updates?.map((update) => ({ ...update })),
    })),
    lastChecked: new Date(service.lastChecked),
  };
}

function areServiceStatusesEquivalent(left: ServiceStatus, right: ServiceStatus): boolean {
  return (
    left.id === right.id &&
    left.status === right.status &&
    (left.description ?? "") === (right.description ?? "") &&
    stringifyIncidents(left.incidents ?? []) === stringifyIncidents(right.incidents ?? [])
  );
}

function stringifyIncidents(incidents: IncidentInfo[]): string {
  return JSON.stringify(
    incidents.map((incident) => ({
      created_at: incident.created_at ?? "",
      id: incident.id,
      impact: incident.impact ?? "",
      incident_updates: (incident.incident_updates ?? []).map((update) => ({
        body: update.body,
        created_at: update.created_at,
      })),
      name: incident.name,
      shortlink: incident.shortlink ?? "",
      status: incident.status ?? "",
    }))
  );
}

function getHotOffsetMs(serviceId: string, spreadMs: number): number {
  return stableHash(serviceId) % Math.max(spreadMs, 1);
}

function stableHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function buildStatusPayloads(categories: StatusCategory[], snapshotAt: number): KeyedStatusPayload[] {
  return [...buildSummaryPayloads(categories, snapshotAt), ...buildIncidentPayloads(categories)];
}

function buildSummaryPayloads(categories: StatusCategory[], snapshotAt: number): KeyedStatusPayload[] {
  const summary = summarizeIssues(categories);
  const pages: EmbedBuilder[] = [];
  let page = createSummaryEmbed(summary, 1, snapshotAt);
  let fieldCount = 0;
  let embedLength = calculateSummaryBaseLength(summary, 1, snapshotAt);
  let pageNumber = 1;

  const pushPage = () => {
    pages.push(page);
    pageNumber += 1;
    page = createSummaryEmbed(summary, pageNumber, snapshotAt);
    fieldCount = 0;
    embedLength = calculateSummaryBaseLength(summary, pageNumber, snapshotAt);
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

      if (fieldCount >= MAX_EMBED_FIELDS || (fieldCount > 0 && embedLength + fieldLength > MAX_EMBED_TOTAL_LENGTH)) {
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
  return pages.map((embed, index) => ({
    key: `summary:page:${index + 1}`,
    payload: { embeds: [embed] },
  }));
}

function buildIncidentPayloads(categories: StatusCategory[]): KeyedStatusPayload[] {
  const incidentEmbeds: KeyedStatusPayload[] = [];

  for (const category of categories) {
    for (const service of category.services) {
      const incident = selectCanonicalIncident(service);
      if (!incident) {
        continue;
      }

      incidentEmbeds.push({
        key: `incident:service:${service.id}`,
        payload: {
          embeds: [
            buildIncidentEmbed({
              incident,
              service,
            }),
          ],
        },
      });
    }
  }

  return incidentEmbeds;
}

function createSummaryEmbed(
  summary: ReturnType<typeof summarizeIssues>,
  pageNumber: number,
  snapshotAt: number
): EmbedBuilder {
  const description = buildSummaryDescription(summary, snapshotAt);
  return new EmbedBuilder()
    .setColor(SUMMARY_COLOR)
    .setDescription(description)
    .setFooter({ text: `${SUMMARY_MARKER} | key=summary:page:${pageNumber} | Page ${pageNumber}` })
    .setTitle(`API and Platform Status (Page ${pageNumber})`);
}

function buildSummaryDescription(summary: ReturnType<typeof summarizeIssues>, snapshotAt: number): string {
  const header =
    `Last updated: <t:${Math.floor(snapshotAt / 1000)}:R>\n` +
    `Operational: ${summary.operational} | Issues: ${summary.issues}`;

  return truncate(
    `${header}${summary.critical > 0 ? ` | Critical: ${summary.critical}` : ""}`,
    MAX_EMBED_DESCRIPTION_LENGTH
  );
}

function calculateSummaryBaseLength(
  summary: ReturnType<typeof summarizeIssues>,
  pageNumber: number,
  snapshotAt: number
): number {
  const title = `API and Platform Status (Page ${pageNumber})`;
  const footer = `${SUMMARY_MARKER} | key=summary:page:${pageNumber} | Page ${pageNumber}`;
  return title.length + buildSummaryDescription(summary, snapshotAt).length + footer.length;
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

function buildIncidentEmbed({
  incident,
  service,
}: {
  incident: IncidentInfo;
  service: ServiceStatus;
}): EmbedBuilder {
  const description = truncate(service.description || service.status, 500);
  const title = truncate(`Incident - ${service.name}`, MAX_EMBED_TITLE_LENGTH);
  const incidentUrl = incident.shortlink ?? service.pageUrl;
  const embed = createIncidentEmbed({
    description,
    incidentUrl,
    service,
    title,
  });
  const incidentName = truncate(incident.name, MAX_EMBED_FIELD_NAME_LENGTH);
  const statusPageValue = `[Status Page](${incidentUrl})`;
  const updateFieldValue = buildIncidentUpdateFieldValue(incident);
  const updatesFieldName = getIncidentUpdatesFieldName(incident);
  const statusPageFieldLength = incidentName.length + statusPageValue.length;
  const updatesFieldLength = updatesFieldName.length + updateFieldValue.length;
  const totalLength =
    calculateIncidentBaseLength({
      description,
      lastChecked: service.lastChecked,
      serviceId: service.id,
      serviceTitle: title,
      status: service.status,
    }) +
    statusPageFieldLength +
    updatesFieldLength;

  embed.addFields({
    inline: false,
    name: incidentName,
    value: statusPageValue,
  });

  embed.addFields({
    inline: false,
    name: updatesFieldName,
    value:
      totalLength <= MAX_EMBED_TOTAL_LENGTH
        ? updateFieldValue
        : truncate(updateFieldValue, MAX_EMBED_FIELD_VALUE_LENGTH),
  });

  return embed;
}

function selectCanonicalIncident(service: ServiceStatus): IncidentInfo | null {
  const incidents = service.incidents ?? [];
  if (incidents.length === 0) {
    return null;
  }

  return [...incidents].sort(compareIncidentPriority)[0] ?? null;
}

function compareIncidentPriority(left: IncidentInfo, right: IncidentInfo): number {
  const statusDelta = incidentActivityRank(right) - incidentActivityRank(left);
  if (statusDelta !== 0) {
    return statusDelta;
  }

  const severityDelta = statusSeverityFromIncidentImpact(right) - statusSeverityFromIncidentImpact(left);
  if (severityDelta !== 0) {
    return severityDelta;
  }

  return incidentLatestTimestamp(right) - incidentLatestTimestamp(left);
}

function incidentActivityRank(incident: IncidentInfo): number {
  const status = (incident.status ?? "").toLowerCase();
  if (/resolved|completed|postmortem/.test(status)) {
    return 0;
  }

  if (/scheduled/.test(status)) {
    return 1;
  }

  return 2;
}

function statusSeverityFromIncidentImpact(incident: IncidentInfo): number {
  return statusSeverity(mapIncidentImpactToStatusLevel(incident));
}

function mapIncidentImpactToStatusLevel(incident: IncidentInfo): ServiceStatus["status"] {
  const impact = (incident.impact ?? "").toLowerCase();
  if (/critical|major_outage/.test(impact)) {
    return "major_outage";
  }
  if (/major|partial_outage/.test(impact)) {
    return "partial_outage";
  }
  if (/minor|degraded_performance/.test(impact)) {
    return "degraded_performance";
  }
  if (/maintenance|under_maintenance/.test(impact)) {
    return "under_maintenance";
  }

  const status = (incident.status ?? "").toLowerCase();
  if (/major|critical/.test(status)) {
    return "major_outage";
  }
  if (/maintenance|scheduled|in_progress/.test(status)) {
    return "under_maintenance";
  }

  return "operational";
}

function incidentLatestTimestamp(incident: IncidentInfo): number {
  const updateTimes = (incident.incident_updates ?? [])
    .map((update) => Date.parse(update.created_at))
    .filter((time) => !Number.isNaN(time));
  const createdAt = incident.created_at ? Date.parse(incident.created_at) : NaN;

  return Math.max(...updateTimes, Number.isNaN(createdAt) ? 0 : createdAt);
}

function getIncidentUpdatesFieldName(incident: IncidentInfo): string {
  const updateCount = Math.min((incident.incident_updates ?? []).length, 3);
  return updateCount > 0 ? `Updates${(incident.incident_updates ?? []).length > 3 ? " (latest 3)" : ""}` : "Updates";
}

function buildIncidentUpdateFieldValue(incident: IncidentInfo): string {
  const updates = (incident.incident_updates ?? []).slice(0, 3);
  if (updates.length === 0) {
    return "No additional incident updates were provided.";
  }

  const lines = updates.map(
    (update) =>
      `- <t:${Math.floor(new Date(update.created_at).getTime() / 1000)}:R> ${truncate(update.body, 240)}`
  );
  const overflowCount = (incident.incident_updates ?? []).length - updates.length;
  if (overflowCount > 0) {
    lines.push(`+${overflowCount} older updates on the status page`);
  }

  return truncate(lines.join("\n"), MAX_EMBED_FIELD_VALUE_LENGTH);
}

function createIncidentEmbed({
  description,
  incidentUrl,
  service,
  title,
}: {
  description: string;
  incidentUrl: string;
  service: ServiceStatus;
  title: string;
}): EmbedBuilder {
  const footerText = `${INCIDENT_MARKER} | key=incident:service:${service.id}`;
  const summaryLine = description || humanizeStatus(service.status);
  const relativeTimestamp = `<t:${Math.floor(service.lastChecked.getTime() / 1000)}:R>`;

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
  lastChecked,
  serviceId,
  serviceTitle,
  status,
}: {
  description: string;
  lastChecked: Date;
  serviceId: string;
  serviceTitle: string;
  status: ServiceStatus["status"];
}): number {
  const footerText = `${INCIDENT_MARKER} | key=incident:service:${serviceId}`;
  const relativeTimestamp = `<t:${Math.floor(lastChecked.getTime() / 1000)}:R>`;
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
      return "\u2705";
    case "degraded_performance":
      return "\u{1F7E1}";
    case "partial_outage":
      return "\u{1F7E0}";
    case "major_outage":
      return "\u{1F534}";
    case "under_maintenance":
      return "\u{1F6E0}\uFE0F";
    default:
      return "\u26AA";
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

function aggregateGroupedService(root: ServiceStatus, children: ServiceStatus[]): ServiceStatus {
  const members = [root, ...children];
  const worstMember = members.reduce((currentWorst, member) =>
    compareStatusSeverity(member.status, currentWorst.status) > 0 ? member : currentWorst
  );
  const status = worstMember.status;
  const lastChecked = new Date(Math.max(...members.map((member) => new Date(member.lastChecked).getTime())));
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
