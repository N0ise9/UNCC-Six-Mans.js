/* eslint-disable max-len */
/* eslint-disable sort-keys */
import { TextChannel, EmbedBuilder as MessageEmbed, Message } from "discord.js";
import { deleteAllMessagesInTextChannel } from "../utils/discordUtils";
import { ColorCodes } from "../utils/utils";
import {
  fetchAllStatuses,
  summarizeIssues,
  ServiceStatus,
  IncidentInfo,
  Categories,
  checkSingleService,
  ServiceConfig,
  StatusLevel,
  impactToStatusWithState,
} from "../services/ApiStatusService";

type IncidentMessage = {
  messageId: string;
  serviceId: string;
};

let mainStatusMessages: Message[] = [];
const incidentMessages = new Map<string, IncidentMessage>(); // key: serviceId
const incidentPayloads = new Map<string, string>(); // serviceId -> embed signature
// Track last time a service's status page was successfully seen (any non-unknown status)
const lastSeenTimestamps = new Map<string, number>(); // serviceId -> epoch ms
// Track Discord connectivity around embed operations (removed detailed flag usage; retry is selective now)

// --- Logging verbosity control ---
// 0: no logs
// 1: important operational logs only (watchdog, incidents, incident edits, check failures)
// 2: minimal diagnostic logs for service checks and Discord edit calls (plus important)
// 3: full verbose logs (plus minimal + important)
enum LogVerbosity {
  None = 0,
  Important = 1,
  Minimal = 2,
  Verbose = 3,
}
const LOG_VERBOSITY: LogVerbosity = LogVerbosity.Important;
let currentRunId = 0; // populated when startApiStatusReporting is invoked
type UpdateContext = "normal" | "issue" | "heartbeat";
let lastUpdateContext: UpdateContext = "normal";

// Retry queues for failed operations (processed every 2 minutes)
const mainRetryUpsert = new Map<number, MessageEmbed>(); // pageIndex -> embed
const mainRetryDelete = new Set<string>(); // messageId
const incidentRetry = new Set<string>(); // serviceId (for create/edit failures)
const incidentRetryDelete = new Map<string, string>(); // serviceId -> messageId (for delete failures)
let activeReportingStop: (() => void) | null = null;
let activeReportingRunId = 1;

// ---- Sweep / polling metrics (for watchdog) ----
let sweepPlannedTotal = 0; // total candidates at sweep start
let sweepPlannedBatch = 0; // batch size at sweep start
let sweepRemainingChecks = 0; // how many checks remain in this sweep batch
let sweepGen = 0; // sweep generation counter
let sweepWindowTimer: ReturnType<typeof setTimeout> | null = null;
let newSweepScheduled = false;
// AWS sweep metrics (run in parallel with default)
let sweepPlannedTotalAws = 0;
let sweepPlannedBatchAws = 0;
let sweepRemainingChecksAws = 0;
let sweepGenAws = 0;
let sweepWindowTimerAws: ReturnType<typeof setTimeout> | null = null;
let newSweepScheduledAws = false;
let sweepCursorAws = 0;

let checkedSinceWatchdog = 0; // checks completed since last watchdog tick
let okSinceWatchdog = 0; // completed checks that are operational
let issueSinceWatchdog = 0; // completed checks that are non-operational (excluding unknown)
let unknownSinceWatchdog = 0; // completed checks that returned unknown
let checkFailSinceWatchdog = 0; // completed checks that threw

// Optional: last check timestamp (useful to detect total poll stalls)
let lastCheckAt = 0;

// Global Discord task queue to ensure we only post/edit/delete one embed per second
type DiscordTask<T = unknown> = () => Promise<T>;
const discordTaskQueue: DiscordTask[] = [];
let discordQueueProcessing = false;
const processDiscordQueue = async () => {
  if (discordQueueProcessing) return;
  discordQueueProcessing = true;
  while (discordTaskQueue.length) {
    const job = discordTaskQueue.shift();
    if (!job) break;
    try {
      await job();
    } catch {
      // ignore job error here; callers handle via their own try/catch
    }
    // Enforce one embed operation per second
    await sleep(1000);
  }
  discordQueueProcessing = false;
};
function enqueueDiscord<T>(fn: DiscordTask<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    discordTaskQueue.push(async () => {
      try {
        const res = await fn();
        resolve(res as T);
      } catch (e) {
        reject(e as Error);
      }
    });
    void processDiscordQueue();
  });
}

// Small helper to space out Discord API calls and avoid burst rate limits
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Add timeouts to Discord operations so a single hung request cannot stall the queue forever
const DISCORD_OP_TIMEOUT_MS = 20_000; // 20s safety timeout per discord op
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          logWarn(`Discord op timeout after ${ms}ms: ${label}`);
          reject(new Error(`Timeout: ${label}`));
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Queue + timeout wrapper for all Discord API calls that modify messages
function queueDiscord<T>(fn: () => Promise<T>, label: string, timeoutMs = DISCORD_OP_TIMEOUT_MS): Promise<T> {
  return enqueueDiscord(() => withTimeout(fn(), timeoutMs, label));
}

// Lightweight one-line logging helpers (local date and time with milliseconds)
const nowLocalMs = () => {
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const p3 = (n: number) => String(n).padStart(3, "0");
  const yyyy = d.getFullYear();
  const MM = p2(d.getMonth() + 1);
  const DD = p2(d.getDate());
  const hh = p2(d.getHours());
  const mm = p2(d.getMinutes());
  const ss = p2(d.getSeconds());
  const mmm = p3(d.getMilliseconds());
  return `${MM}/${DD}/${yyyy} - ${hh}:${mm}:${ss}.${mmm}`;
};
// Level-1 legacy logs
const logInfo = (msg: string) => {
  if (LOG_VERBOSITY >= LogVerbosity.Verbose) console.info(`[APIStatus ${nowLocalMs()}] ${msg}`);
};
const logWarn = (msg: string) => {
  if (LOG_VERBOSITY >= LogVerbosity.Verbose) console.warn(`[APIStatus ${nowLocalMs()}] ${msg}`);
};
const logImportant = (msg: string) => {
  if (LOG_VERBOSITY >= LogVerbosity.Important) console.info(`[APIStatus ${nowLocalMs()}] ${msg}`);
};
const logImportantWarn = (msg: string) => {
  if (LOG_VERBOSITY >= LogVerbosity.Important) console.warn(`[APIStatus ${nowLocalMs()}] ${msg}`);
};

// Level-2 minimal diagnostics (no timestamps; exact fields requested)
const v2LogCheck = (cadence: UpdateContext, serviceName: string, runId: number) => {
  if (LOG_VERBOSITY >= LogVerbosity.Minimal)
    console.info(`CHECK cadence=${cadence} service=${serviceName} runId=${runId} pid=${process.pid}`);
};
const v2LogDiscordEdit = (cadence: UpdateContext, serviceName: string, runId: number) => {
  if (LOG_VERBOSITY >= LogVerbosity.Minimal)
    console.info(`DISCORD_EDIT cadence=${cadence} service=${serviceName} runId=${runId} pid=${process.pid}`);
};

const embedSignature = (embed: MessageEmbed) => JSON.stringify(embed.toJSON());

function statusEmoji(level: ServiceStatus["status"]): string {
  switch (level) {
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

const DISPLAY_STATUS_RANK: Record<StatusLevel, number> = {
  operational: 0,
  under_maintenance: 1,
  degraded_performance: 2,
  partial_outage: 3,
  major_outage: 4,
  unknown: 5,
};

const INCIDENT_STATUS_RANK: Record<StatusLevel, number> = {
  operational: 0,
  under_maintenance: 1,
  degraded_performance: 2,
  partial_outage: 3,
  major_outage: 4,
  unknown: -1,
};

const isWorseStatus = (candidate: StatusLevel, current: StatusLevel, rank: Record<StatusLevel, number>) =>
  rank[candidate] > rank[current];

const isIssueStatus = (status: StatusLevel) => status !== "operational" && status !== "unknown";

const worstIncidentStatus = (incidents?: IncidentInfo[]): StatusLevel => {
  if (!incidents || incidents.length === 0) return "operational";
  let worst: StatusLevel = "operational";
  for (const inc of incidents) {
    const lvl = impactToStatusWithState(inc.impact, inc.status);
    if (isWorseStatus(lvl, worst, INCIDENT_STATUS_RANK)) worst = lvl;
  }
  return worst;
};

const deriveIncidentStatus = (service: ServiceStatus): StatusLevel => {
  let iconStatus: StatusLevel = service.status;
  if ((service.status === "operational" || service.status === "unknown") && service.incidents?.length) {
    const worst = worstIncidentStatus(service.incidents);
    if (worst !== "operational") iconStatus = worst;
  }
  return iconStatus;
};

const recordCheckResult = (status: ServiceStatus["status"]) => {
  checkedSinceWatchdog++;
  lastCheckAt = Date.now();
  if (status === "operational") okSinceWatchdog++;
  else if (status === "unknown") unknownSinceWatchdog++;
  else issueSinceWatchdog++;
};

const recordCheckFailure = () => {
  checkFailSinceWatchdog++;
  lastCheckAt = Date.now();
};

function overallColor(categories: { services: ServiceStatus[] }[]): number {
  let worst: ServiceStatus["status"] = "operational";
  for (const c of categories) {
    for (const s of c.services) {
      if (isWorseStatus(s.status, worst, DISPLAY_STATUS_RANK)) worst = s.status;
    }
  }
  switch (worst) {
    case "operational":
      return ColorCodes.Green;
    case "degraded_performance":
    case "partial_outage":
    case "under_maintenance":
      return ColorCodes.Orange;
    case "major_outage":
      return ColorCodes.DarkRed;
    default:
      return ColorCodes.Blue;
  }
}

function buildMainEmbeds(categories: { name: string; services: ServiceStatus[] }[]): MessageEmbed[] {
  const pages: MessageEmbed[] = [];
  const { issues, critical, operational } = summarizeIssues(categories);
  const baseTitle = "API and Platform Status";
  const headerDesc = `Last updated: <t:${Math.floor(Date.now() / 1000)}:R>\nOperational: ${operational} • Issues: ${issues}${
    critical ? ` • Critical: ${critical}` : ""
  }`;

  const MAX_FIELD_VALUE = 1024;
  const MAX_FIELDS = 25;
  const TOTAL_CHAR_LIMIT = 6000; // per-embed total char cap

  const safeLine = (s: ServiceStatus) => {
    const iconStatus = deriveIncidentStatus(s);
    // For unknown (unreachable) show last-seen timestamp when available
    if (iconStatus === "unknown") {
      const ts = lastSeenTimestamps.get(s.id);
      const seen = ts ? ` — last seen <t:${Math.floor(ts / 1000)}:R>` : "";
      return `${statusEmoji(iconStatus)} ${s.name}${seen}`;
    }
    const desc = (s.description || "").toString().trim();
    const maxLine = 90;
    const truncated = desc.length > maxLine ? desc.slice(0, maxLine - 1) + "…" : desc;
    const suffix = truncated ? ` — ${truncated}` : "";
    return `${statusEmoji(iconStatus)} ${s.name}${suffix}`;
  };

  let pageIndex = 1;
  let embed = new MessageEmbed({
    color: overallColor(categories),
    title: `${baseTitle} (Page ${pageIndex})`,
    description: headerDesc,
  });
  let usedFields = 0;
  let usedChars = (embed.data.title?.length || 0) + (embed.data.description?.length || 0);

  const startNewPage = () => {
    pages.push(embed);
    pageIndex++;
    embed = new MessageEmbed({
      color: overallColor(categories),
      title: `${baseTitle} (Page ${pageIndex})`,
      description: headerDesc,
    });
    usedFields = 0;
    usedChars = (embed.data.title?.length || 0) + (embed.data.description?.length || 0);
  };

  for (const cat of categories) {
    const lines = cat.services.map(safeLine);
    let chunk: string[] = [];
    let currentLen = 0;
    let part = 1;

    const flush = () => {
      if (chunk.length === 0) return;
      const title = part === 1 ? cat.name : `${cat.name} (cont. ${part - 1})`;
      const value = chunk.join("\n");
      const addChars = title.length + value.length;
      if (usedFields >= MAX_FIELDS || usedChars + addChars > TOTAL_CHAR_LIMIT) {
        startNewPage();
      }
      embed.addFields({ name: title, value, inline: false });
      usedFields++;
      usedChars += addChars;
      chunk = [];
      currentLen = 0;
    };

    for (const ln of lines) {
      const addLen = ln.length + 1; // include newline
      if (currentLen + addLen > MAX_FIELD_VALUE) {
        flush();
        part++;
      }
      chunk.push(ln);
      currentLen += addLen;
    }
    flush();
  }

  pages.push(embed);
  return pages;
}

function buildIncidentEmbed(service: ServiceStatus) {
  const incidents: IncidentInfo[] = service.incidents || [];
  const iconStatus = deriveIncidentStatus(service);

  // Compute a stable "last updated" based on provider timestamps to avoid churn on retries
  const latestUpdateMs = (() => {
    const incs = incidents || [];
    let latest = 0;
    for (const inc of incs) {
      if (inc.created_at) {
        const t = Date.parse(inc.created_at);
        if (!Number.isNaN(t)) latest = Math.max(latest, t);
      }
      for (const u of inc.incident_updates || []) {
        const t = Date.parse(u.created_at);
        if (!Number.isNaN(t)) latest = Math.max(latest, t);
      }
    }
    // Fallback to service.lastChecked if we didn't find any incident timestamps
    if (!latest && service.lastChecked) {
      const t =
        service.lastChecked instanceof Date ? service.lastChecked.getTime() : Date.parse(String(service.lastChecked));
      if (!Number.isNaN(t)) latest = t;
    }
    return latest || Date.now();
  })();

  const embed = new MessageEmbed({
    color: ColorCodes.DarkRed,
    title: `Incident — ${service.name}`,
    url: service.pageUrl,
    description: `${statusEmoji(iconStatus)} ${service.description ?? service.status}\nLast updated: <t:${Math.floor(
      latestUpdateMs / 1000
    )}:R>`,
  });

  if (incidents.length === 0) {
    embed.addFields({ name: "Details", value: "Issue detected without incident details." });
    return embed;
  }

  const active = incidents[0];
  // Build update lines, ensuring no single line can exceed Discord's per-field 1024 char limit
  const rawUpdateLines = (active.incident_updates || []).map(
    (u) => `• [<t:${Math.floor(new Date(u.created_at).getTime() / 1000)}:R>] ${u.body}`
  );

  // Build fields with values <= 1024 chars each
  const MAX_FIELD_VALUE = 1024;
  // Some providers post extremely verbose updates; split any single line that exceeds field value limits
  const expandLongLines = (lines: string[]): string[] => {
    const out: string[] = [];
    // Keep a safety margin so we don't accidentally exceed the limit when joining
    const pieceLen = Math.max(200, MAX_FIELD_VALUE - 10);
    for (const ln of lines) {
      if (ln.length <= MAX_FIELD_VALUE) {
        out.push(ln);
        continue;
      }
      let rest = ln;
      while (rest.length > 0) {
        const take = rest.slice(0, pieceLen);
        const continued = rest.length > pieceLen;
        out.push(continued ? take + "…" : take);
        rest = rest.slice(pieceLen);
      }
    }
    return out;
  };
  const updateLines = expandLongLines(rawUpdateLines);
  const chunks: string[] = [];
  let current = "";
  for (const ln of updateLines) {
    const addLen = ln.length + 1;
    if (current.length + addLen > MAX_FIELD_VALUE) {
      if (current.length > 0) chunks.push(current);
      current = ln;
    } else {
      current = current ? current + "\n" + ln : ln;
    }
  }
  if (current.length > 0) chunks.push(current);

  // Cap number of update fields to avoid field count limit
  const MAX_UPDATE_FIELDS = 10;
  const usedChunks = chunks.slice(0, MAX_UPDATE_FIELDS);

  // Discord field name must be <= 256 chars and non-empty. Sanitize and clamp.
  const rawIncidentTitle = (active.name || "").toString().replace(/\s+/g, " ").trim() || "Incident";
  const incidentTitle = rawIncidentTitle.length > 256 ? rawIncidentTitle.slice(0, 255) + "…" : rawIncidentTitle;
  const linkValue = (active.shortlink ? `[Status Page](${active.shortlink})` : service.pageUrl) || service.pageUrl;
  const safeLinkValue = linkValue.length > 1024 ? linkValue.slice(0, 1023) + "…" : linkValue;
  embed.addFields({ name: incidentTitle, value: safeLinkValue });

  // Respect embed total character limit (~6000)
  const TOTAL_LIMIT = 6000;
  const baseUsed =
    (embed.data.title?.length || 0) + (embed.data.description?.length || 0) + incidentTitle.length + linkValue.length;
  let remaining = TOTAL_LIMIT - baseUsed;
  if (usedChunks.length === 0) {
    const v = "No updates yet.";
    if (remaining > "Updates".length + v.length) embed.addFields({ name: "Updates", value: v });
  } else if (usedChunks.length === 1) {
    const v = usedChunks[0];
    if (remaining > "Updates".length + v.length) embed.addFields({ name: "Updates", value: v });
  } else {
    for (let i = 0; i < usedChunks.length; i++) {
      const name = `Updates (${i + 1}/${usedChunks.length})`;
      const value = usedChunks[i];
      const need = name.length + value.length;
      if (need < remaining) {
        embed.addFields({ name, value });
        remaining -= need;
      } else {
        break;
      }
    }
  }

  return embed;
}

// Returns true if all discord operations succeeded; false if any failed
async function upsertIncidentEmbeds(
  channel: TextChannel,
  categories: { name: string; services: ServiceStatus[] }[]
): Promise<boolean> {
  let allOk = true;
  for (const cat of categories) {
    for (const s of cat.services) {
      // Only create incident embeds when we have concrete incident details to show
      const hasIssue = isIssueStatus(s.status) || (s.incidents?.length || 0) > 0;
      const hasIncidentDetails = Array.isArray(s.incidents) && s.incidents.length > 0;
      const existing = incidentMessages.get(s.id);
      if (hasIssue && hasIncidentDetails) {
        const embed = buildIncidentEmbed(s);
        const signature = embedSignature(embed);
        if (existing) {
          const prior = incidentPayloads.get(s.id);
          if (prior === signature) {
            const cached = channel.messages.cache.get(existing.messageId);
            if (cached) {
              continue;
            }
            try {
              await withTimeout(
                channel.messages.fetch(existing.messageId),
                DISCORD_OP_TIMEOUT_MS,
                `fetch incident msg ${existing.messageId}`
              );
              continue;
            } catch {
              // fall through to recreate below
            }
          }
          // edit existing
          try {
            // prefer cache to reduce API hits
            const cached = channel.messages.cache.get(existing.messageId);
            const msg =
              cached ??
              (await withTimeout(
                channel.messages.fetch(existing.messageId),
                DISCORD_OP_TIMEOUT_MS,
                `fetch incident msg ${existing.messageId}`
              ));
            v2LogDiscordEdit(lastUpdateContext, s.name, currentRunId);
            await queueDiscord(() => msg.edit({ embeds: [embed] }), `edit incident ${existing.messageId}`);
            incidentPayloads.set(s.id, signature);
            // success: clear any pending retry for this service
            incidentRetry.delete(s.id);
            logInfo(`Incident edit: ${s.id} (${s.name}) PID=${process.pid}`);
            logImportant(`Incident edit: ${s.id} (${s.name}) PID=${process.pid}`);
          } catch (e) {
            logWarn(`Incident edit failed: ${s.id} (${s.name}) msg=${existing?.messageId} err=${(e as Error).message}`);
            // enqueue retry for this service
            incidentRetry.add(s.id);
            // also try recreate immediately
            try {
              const newMsg = await queueDiscord(() => channel.send({ embeds: [embed] }), `send incident ${s.id}`);
              incidentMessages.set(s.id, { messageId: newMsg.id, serviceId: s.id });
              incidentPayloads.set(s.id, signature);
              incidentRetry.delete(s.id);
              logInfo(`Incident create (after edit fail): ${s.id} (${s.name}) PID=${process.pid}`);
              logImportant(`Incident post: ${s.id} (${s.name}) PID=${process.pid}`);
            } catch (err) {
              allOk = false;
              logWarn(`Incident recreate failed: ${s.id} (${s.name}) err=${(err as Error).message}`);
              incidentRetry.add(s.id);
            }
          }
        } else {
          try {
            const newMsg = await queueDiscord(() => channel.send({ embeds: [embed] }), `send incident ${s.id}`);
            incidentMessages.set(s.id, { messageId: newMsg.id, serviceId: s.id });
            incidentPayloads.set(s.id, signature);
            incidentRetry.delete(s.id);
            logInfo(`Incident create: ${s.id} (${s.name}) PID=${process.pid}`);
            logImportant(`Incident post: ${s.id} (${s.name}) PID=${process.pid}`);
          } catch (e) {
            allOk = false;
            logWarn(`Incident create failed: ${s.id} (${s.name}) err=${(e as Error).message}`);
            incidentRetry.add(s.id);
          }
        }
      } else if (existing) {
        // resolved — delete the incident embed
        try {
          const cached = channel.messages.cache.get(existing.messageId);
          const msg =
            cached ??
            (await withTimeout(
              channel.messages.fetch(existing.messageId),
              DISCORD_OP_TIMEOUT_MS,
              `fetch (for delete) incident msg ${existing.messageId}`
            ));
          await queueDiscord(() => msg.delete(), `delete incident ${existing.messageId}`);
          incidentRetryDelete.delete(s.id);
          logInfo(`Incident delete: ${s.id} (${s.name}) PID=${process.pid}`);
          logImportant(`Incident removed: ${s.id} (${s.name}) PID=${process.pid}`);
        } catch (e) {
          logWarn(`Incident delete failed: ${s.id} (${s.name}) msg=${existing.messageId} err=${(e as Error).message}`);
          allOk = false;
          incidentRetryDelete.set(s.id, existing.messageId);
        }
        incidentMessages.delete(s.id);
        incidentPayloads.delete(s.id);
      }
    }
  }
  return allOk;
}

// Edit existing page messages when possible; only delete/create when count changes
// Returns true if all discord operations succeeded; false if any failed
async function upsertMainStatusEmbeds(
  channel: TextChannel,
  embeds: MessageEmbed[],
  onEditFailure?: (reason: string) => void
): Promise<boolean> {
  const current = mainStatusMessages;
  const minCount = Math.min(current.length, embeds.length);
  let allOk = true;
  logInfo(`Main upsert: have=${current.length} need=${embeds.length}`);

  // Edit in place for shared range
  for (let i = 0; i < minCount; i++) {
    try {
      await queueDiscord(() => current[i].edit({ embeds: [embeds[i]] }), `edit main page ${i + 1}`);
      mainRetryUpsert.delete(i);
      logInfo(`Main edit: page#${i + 1} PID=${process.pid}`);
    } catch (err) {
      logWarn(`Main edit failed: page#${i + 1} err=${(err as Error).message}`);
      if (onEditFailure) {
        onEditFailure(`Main edit failed page#${i + 1}: ${(err as Error).message}`);
        allOk = false;
        return false;
      }
      try {
        const sent = await queueDiscord(() => channel.send({ embeds: [embeds[i]] }), `send main page ${i + 1}`);
        current[i] = sent;
        mainRetryUpsert.delete(i);
        logInfo(`Main create (after edit fail): page#${i + 1} PID=${process.pid}`);
      } catch (e) {
        logWarn(`Main create failed: page#${i + 1} err=${(e as Error).message}`);
        allOk = false;
        mainRetryUpsert.set(i, embeds[i]);
      }
    }
  }

  // If there are extra old pages, delete them
  if (current.length > embeds.length) {
    for (let i = embeds.length; i < current.length; i++) {
      try {
        await queueDiscord(() => current[i].delete(), `delete main page ${i + 1}`);
        mainRetryDelete.delete(current[i].id);
        logInfo(`Main delete: page#${i + 1} PID=${process.pid}`);
      } catch (e) {
        logWarn(`Main delete failed: page#${i + 1} err=${(e as Error).message}`);
        allOk = false;
        mainRetryDelete.add(current[i].id);
      }
    }
    mainStatusMessages = current.slice(0, embeds.length);
  }

  // If we need more pages, send them
  if (embeds.length > current.length) {
    for (let i = current.length; i < embeds.length; i++) {
      try {
        const sent = await queueDiscord(() => channel.send({ embeds: [embeds[i]] }), `send main page ${i + 1}`);
        mainStatusMessages.push(sent);
        mainRetryUpsert.delete(i);
        logInfo(`Main create: page#${i + 1} PID=${process.pid}`);
      } catch (e) {
        logWarn(`Main create failed: page#${i + 1} err=${(e as Error).message}`);
        allOk = false;
        mainRetryUpsert.set(i, embeds[i]);
      }
    }
  }
  return allOk;
}

export async function startApiStatusReporting(channel: TextChannel) {
  // If already running, stop previous polling sweep before starting a new one when this is called.
  if (activeReportingStop) {
    logInfo("[APIStatus] Received new start request; Restarting polling sweep...");
    activeReportingStop();
    activeReportingStop = null;
  }
  const runId = activeReportingRunId;
  currentRunId = runId;
  logInfo(`[APIStatus] Starting.. RunID=${runId} PID=${process.pid}`);

  // State for adaptive, staggered polling
  let lastHadIssues = false;
  const statusCache = new Map<string, ServiceStatus>(); // serviceId -> last known status
  const issueServices = new Set<string>(); // active issue services (non-operational; unknown excluded)
  const issuePollTimeouts = new Map<string, ReturnType<typeof setTimeout>>(); // per-cycle scheduled polls
  let issueCycleTimer: ReturnType<typeof setInterval> | null = null;
  let issueCycleAlignTimeout: ReturnType<typeof setTimeout> | null = null;
  let nonIssueTimeouts: Array<ReturnType<typeof setTimeout>> = []; // scheduled one-offs over 30 minutes (default sweep)
  let nonIssueTimeoutsAws: Array<ReturnType<typeof setTimeout>> = []; // AWS sweep
  // Heartbeat to ensure embeds refresh periodically; interval adapts based on whether issues exist
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatAlignTimeout: ReturnType<typeof setTimeout> | null = null;
  let heartbeatMsCurrent: number | null = null;
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  let nextSweepTimer: ReturnType<typeof setTimeout> | null = null;
  let nextSweepTimerAws: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const isStale = () => stopped || runId !== activeReportingRunId;
  // Coalesced update control
  let updateInFlight = false;
  let pendingForce: boolean | null = null;
  let pendingUpdate = false; // NEW: remembers non-force updates that happened during inFlight
  let updateSoonTimer: ReturnType<typeof setTimeout> | null = null;
  let updateSoonForce = false;
  // Retry processor timer (2 minutes)
  let retryTimer: ReturnType<typeof setInterval> | null = null;
  let sweepCursor = 0;
  const FIVE_MIN = 5 * 60 * 1000;
  const POLL_AHEAD_MS = 45 * 1000; // start polls ~45s before the 5m embed tick
  const POLL_SPREAD_MS = 30 * 1000; // spread issue polls across 30s (leaving 15s before heartbeat)
  const MAX_CHECKS_PER_SWEEP = 1000; // # to check per sweep window (aid to avoid throttling)
  const HARD_RESTART_DELAY_MS = 15 * 1000; // pause before forced restart after fatal Discord edit failure
  let hardRestartPending = false;
  let hardRestartTimer: ReturnType<typeof setTimeout> | null = null;

  const resetDiscordTracking = () => {
    mainStatusMessages = [];
    incidentMessages.clear();
    incidentPayloads.clear();
    mainRetryUpsert.clear();
    mainRetryDelete.clear();
    incidentRetry.clear();
    incidentRetryDelete.clear();
  };

  const requestHardRestart = (reason: string) => {
    if (hardRestartPending) return;
    hardRestartPending = true;
    logWarn(`Hard restart requested: ${reason}`);
    stopApiStatusReporting();
    if (hardRestartTimer) {
      clearTimeout(hardRestartTimer);
      hardRestartTimer = null;
    }
    hardRestartTimer = setTimeout(async () => {
      hardRestartTimer = null;
      try {
        resetDiscordTracking();
        await startApiStatusReporting(channel);
      } catch (e) {
        logWarn(`Hard restart failed: ${(e as Error).message}`);
      }
    }, HARD_RESTART_DELAY_MS);
  };

  const startRetryProcessor = () => {
    if (retryTimer) return;
    retryTimer = setInterval(
      async () => {
        if (isStale()) return;
        try {
          // Process incident retries one-by-one so we respect the global 1/sec queue
          for (const sid of Array.from(incidentRetry)) {
            // Find the latest display status for this service
            const cats = categoriesFromCache();
            let svc: ServiceStatus | undefined;
            for (const c of cats) {
              const found = c.services.find((s) => s.id === sid);
              if (found) {
                svc = found;
                break;
              }
            }
            if (!svc) {
              // No longer present; drop from retry
              incidentRetry.delete(sid);
              continue;
            }
            const ok = await upsertIncidentEmbeds(channel, [{ name: "Retry", services: [svc] }]).catch(() => false);
            if (ok) incidentRetry.delete(sid);
          }

          // Process incident delete retries
          for (const [sid, msgId] of Array.from(incidentRetryDelete.entries())) {
            try {
              const cached = channel.messages.cache.get(msgId);
              const msg =
                cached ??
                (await withTimeout(
                  channel.messages.fetch(msgId),
                  DISCORD_OP_TIMEOUT_MS,
                  `fetch (retry delete) incident msg ${msgId}`
                ));
              await queueDiscord(() => msg.delete(), `retry delete incident ${msgId}`);
              incidentRetryDelete.delete(sid);
              // Also ensure local mapping is cleared
              incidentMessages.delete(sid);
            } catch (e) {
              // keep for next round
            }
          }

          // Process main page upserts
          for (const [idx, emb] of Array.from(mainRetryUpsert.entries())) {
            try {
              if (idx < mainStatusMessages.length) {
                await queueDiscord(
                  () => mainStatusMessages[idx].edit({ embeds: [emb] }),
                  `retry edit main page ${idx + 1}`
                );
              } else {
                const sent = await queueDiscord(
                  () => channel.send({ embeds: [emb] }),
                  `retry send main page ${idx + 1}`
                );
                // Ensure the array is extended appropriately
                mainStatusMessages[idx] = sent;
              }
              mainRetryUpsert.delete(idx);
            } catch (e) {
              // keep for next round
            }
          }

          // Process main deletions
          for (const msgId of Array.from(mainRetryDelete)) {
            try {
              const cached = channel.messages.cache.get(msgId);
              const msg =
                cached ??
                (await withTimeout(
                  channel.messages.fetch(msgId),
                  DISCORD_OP_TIMEOUT_MS,
                  `fetch (retry delete) main msg ${msgId}`
                ));
              await queueDiscord(() => msg.delete(), `retry delete main msg ${msgId}`);
              // Remove from local tracking array if present
              const pos = mainStatusMessages.findIndex((m) => m.id === msgId);
              if (pos !== -1) mainStatusMessages.splice(pos, 1);
              mainRetryDelete.delete(msgId);
            } catch (e) {
              // keep for next round
            }
          }
        } catch (e) {
          logWarn(`Retry processor error: ${(e as Error).message}`);
        }
      },
      2 * 60 * 1000
    );
  };

  const serviceIndex: Map<string, ServiceConfig> = new Map(Categories.flatMap((c) => c.services).map((s) => [s.id, s]));

  const getServiceConfig = (id: string): ServiceConfig | undefined => serviceIndex.get(id);

  const getCachedOrDefault = (cfg: ServiceConfig): ServiceStatus => {
    const existing = statusCache.get(cfg.id);
    if (existing) return existing;
    return {
      id: cfg.id,
      name: cfg.name,
      pageUrl: cfg.pageUrl,
      status: "unknown",
      description: "",
      lastChecked: new Date(0),
      incidents: [],
    };
  };

  const aggregateGroupStatus = (
    rootCfg: ServiceConfig,
    rootStatus: ServiceStatus,
    children: ServiceStatus[]
  ): ServiceStatus => {
    if (!children.length) return rootStatus;

    let topStatus: StatusLevel = "operational";
    let latestChecked = rootStatus.lastChecked ?? new Date(0);
    const incidents: IncidentInfo[] = [];

    for (const child of children) {
      // pick worst status among children
      if (isWorseStatus(child.status, topStatus, INCIDENT_STATUS_RANK)) topStatus = child.status;
      if (child.lastChecked && child.lastChecked > latestChecked) {
        latestChecked = child.lastChecked;
      }
      if (child.incidents && child.incidents.length) {
        incidents.push(...child.incidents);
      }
    }

    // newest first; guard against undefined or malformed timestamps
    incidents.sort((a, b) => {
      const ta = a.created_at ? new Date(a.created_at).getTime() || 0 : 0;
      const tb = b.created_at ? new Date(b.created_at).getTime() || 0 : 0;
      return tb - ta;
    });

    const description =
      incidents.length && topStatus !== "operational"
        ? topStatus === "under_maintenance"
          ? "Maintenance in progress"
          : "Issues detected"
        : "";

    return {
      id: rootCfg.id,
      name: rootCfg.name,
      pageUrl: rootCfg.pageUrl,
      status: topStatus,
      description,
      lastChecked: latestChecked || new Date(),
      incidents,
    };
  };

  const categoriesFromCache = (): { name: string; services: ServiceStatus[] }[] => {
    return Categories.map((cat) => {
      const allStatuses = cat.services.map((svc) => getCachedOrDefault(svc));

      const statusById = new Map<string, ServiceStatus>();
      const cfgById = new Map<string, ServiceConfig>();

      cat.services.forEach((cfg, idx) => {
        cfgById.set(cfg.id, cfg);
        statusById.set(cfg.id, allStatuses[idx]);
      });

      // Bucket children by groupId
      const childrenByGroup = new Map<string, ServiceStatus[]>();
      for (const cfg of cat.services) {
        if (cfg.groupId) {
          const childStatus = statusById.get(cfg.id);
          if (!childStatus) continue;
          const list = childrenByGroup.get(cfg.groupId) ?? [];
          list.push(childStatus);
          childrenByGroup.set(cfg.groupId, list);
        }
      }

      const output: ServiceStatus[] = [];

      for (const cfg of cat.services) {
        // Hide child services from the UI
        if (cfg.groupId) continue;

        const baseStatus = statusById.get(cfg.id)!;
        const children = childrenByGroup.get(cfg.id);

        if (children && children.length) {
          // root of a group (e.g. "aws")
          output.push(aggregateGroupStatus(cfg, baseStatus, children));
        } else {
          // normal service
          output.push(baseStatus);
        }
      }

      return { name: cat.name, services: output };
    });
  };

  // Compute ms until next aligned tick on a given interval and optional offset
  const msUntilNextAlignedTick = (intervalMs: number, offsetMs = 0) => {
    const now = Date.now();
    const next = Math.ceil((now - offsetMs) / intervalMs) * intervalMs + offsetMs;
    return Math.max(0, next - now);
  };

  const ensureHeartbeat = (desiredMs: number) => {
    if (heartbeatMsCurrent === desiredMs && heartbeatTimer && !heartbeatAlignTimeout) return;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (heartbeatAlignTimeout) {
      clearTimeout(heartbeatAlignTimeout);
      heartbeatAlignTimeout = null;
    }

    // Align heartbeat to the next 5-minute boundary when running at 5 minutes,
    // otherwise just start after desiredMs
    const initialDelay = desiredMs === FIVE_MIN ? msUntilNextAlignedTick(FIVE_MIN, 0) : desiredMs;

    heartbeatAlignTimeout = setTimeout(async () => {
      heartbeatAlignTimeout = null;
      if (isStale()) return;
      try {
        lastUpdateContext = "heartbeat";
        requestUpdateSoon(true);
      } catch (e) {
        logWarn(`Heartbeat update failed: ${(e as Error).message}`);
      }
      heartbeatTimer = setInterval(async () => {
        if (isStale()) return;
        try {
          lastUpdateContext = "heartbeat";
          requestUpdateSoon(true);
        } catch (e) {
          logWarn(`Heartbeat update failed: ${(e as Error).message}`);
        }
      }, desiredMs);
      const mins = Math.round(desiredMs / 60000);
      logInfo(`Heartbeat started interval=${mins}m (aligned)`);
    }, initialDelay);

    heartbeatMsCurrent = desiredMs;
  };

  const statusChanged = (a?: ServiceStatus, b?: ServiceStatus): boolean => {
    if (!a || !b) return true;
    if (a.status !== b.status) return true;
    if ((a.description || "") !== (b.description || "")) return true;
    const alen = a.incidents?.length || 0;
    const blen = b.incidents?.length || 0;
    if (alen !== blen) return true;
    if (alen > 0 && blen > 0) {
      const aTop = a.incidents![0];
      const bTop = b.incidents![0];
      if ((aTop.id || "") !== (bTop.id || "")) return true;
      if ((aTop.status || "") !== (bTop.status || "")) return true;
      // Ignore timestamp-only churn; compare top update content instead of just created_at
      const auBody = aTop.incident_updates?.[0]?.body || "";
      const buBody = bTop.incident_updates?.[0]?.body || "";
      if (auBody !== buBody) return true;
    }
    return false;
  };

  const updateEmbedsIfNeeded = async (force: boolean = false) => {
    if (hardRestartPending) return;
    const cats = categoriesFromCache();
    const { issues } = summarizeIssues(cats);
    const hasIssuesNow = issues > 0;

    const shouldUpdate = force || hasIssuesNow || lastHadIssues;
    if (shouldUpdate) {
      const embeds = buildMainEmbeds(cats);
      const okMain = await upsertMainStatusEmbeds(channel, embeds, requestHardRestart);
      if (hardRestartPending) return;
      let okInc = true;
      try {
        okInc = await upsertIncidentEmbeds(channel, cats);
      } catch (err) {
        okInc = false;
        logWarn(`Incident upsert failed: ${(err as Error).message}`);
      }
      logInfo(
        `Upsert complete (force=${force}) pages=${embeds.length} issues=${issues} okMain=${okMain} okInc=${okInc}`
      );
    }
    lastHadIssues = hasIssuesNow;
    // Adapt heartbeat cadence: faster when issues exist
    ensureHeartbeat(hasIssuesNow ? 5 * 60 * 1000 : 30 * 60 * 1000);
  };

  const requestUpdate = async (force: boolean) => {
    if (isStale()) return;
    if (updateInFlight) {
      pendingUpdate = true; // NEW: remember that something changed
      pendingForce = (pendingForce ?? false) || force;
      return;
    }

    updateInFlight = true;
    try {
      await updateEmbedsIfNeeded(force);
    } finally {
      const againForce = pendingForce === true;
      const againAny = pendingUpdate;

      pendingForce = null;
      pendingUpdate = false;
      updateInFlight = false;

      // If anything changed while we were updating, schedule one follow-up run
      // BUT if this was a forced refresh (heartbeat), don't immediately reschedule
      // just because background sweep checks landed mid-upsert
      if (againForce || (!force && againAny)) {
        requestUpdateSoon(againForce); // coalesce follow-up too
      }
    }
  };

  const requestUpdateSoon = (force: boolean) => {
    updateSoonForce = updateSoonForce || force;

    if (updateSoonTimer) return;

    updateSoonTimer = setTimeout(async () => {
      const f = updateSoonForce;
      updateSoonForce = false;
      updateSoonTimer = null;

      try {
        await requestUpdate(f);
      } catch (e) {
        logWarn(`Debounced update failed: ${(e as Error).message}`);
      }
    }, 10_000); // 10s debounce window
  };

  const clearIssuePollTimeouts = () => {
    for (const t of issuePollTimeouts.values()) clearTimeout(t);
    issuePollTimeouts.clear();
  };

  const stopIssuePolling = () => {
    clearIssuePollTimeouts();
    if (issueCycleTimer) {
      clearInterval(issueCycleTimer);
      issueCycleTimer = null;
    }
    if (issueCycleAlignTimeout) {
      clearTimeout(issueCycleAlignTimeout);
      issueCycleAlignTimeout = null;
    }
  };

  const pollIssueService = async (cfg: ServiceConfig) => {
    if (isStale()) return;
    try {
      v2LogCheck("issue", cfg.name, runId);
      logInfo(`IssuePoll Start: RunID=${runId} PID=${process.pid} SVC=${cfg.id}`);
      const updated = await checkSingleService(cfg);
      if (isStale()) return;
      logInfo(`IssuePoll done SVC=${cfg.id} status=${updated.status}`);

      // ---- metrics ----
      recordCheckResult(updated.status);

      const before = statusCache.get(cfg.id);
      await onServiceUpdated(updated, before, "issue");
    } catch (e) {
      recordCheckFailure();
      logWarn(`Polling failed for ${cfg.id}: ${(e as Error).message}`);
      logImportantWarn(`Check failed: ${cfg.id} (${cfg.name}) err=${(e as Error).message}`);
    }
  };

  const runIssuePollCycle = () => {
    if (isStale() || stopped) return;
    clearIssuePollTimeouts();
    const issueIds = Array.from(issueServices).sort((a, b) => a.localeCompare(b));
    if (issueIds.length === 0) return;

    const spacing = issueIds.length > 1 ? POLL_SPREAD_MS / (issueIds.length - 1) : 0;
    logInfo(`IssuePoll schedule: count=${issueIds.length} window=${POLL_SPREAD_MS}ms spacing=${Math.round(spacing)}ms`);

    issueIds.forEach((id, idx) => {
      const cfg = getServiceConfig(id);
      if (!cfg) return;
      const delay = Math.round(idx * spacing);
      const t = setTimeout(async () => {
        if (isStale() || stopped) return;
        if (!issueServices.has(id)) return;
        await pollIssueService(cfg);
      }, delay);
      issuePollTimeouts.set(id, t);
    });
  };

  const ensureIssuePollCycle = () => {
    if (issueServices.size === 0) {
      stopIssuePolling();
      return;
    }
    if (issueCycleTimer || issueCycleAlignTimeout) return;
    const alignDelayRaw = msUntilNextAlignedTick(FIVE_MIN, 0) - POLL_AHEAD_MS;
    const alignDelay = alignDelayRaw >= 0 ? alignDelayRaw : alignDelayRaw + FIVE_MIN;
    issueCycleAlignTimeout = setTimeout(() => {
      issueCycleAlignTimeout = null;
      runIssuePollCycle();
      issueCycleTimer = setInterval(runIssuePollCycle, FIVE_MIN);
      logInfo(`IssuePoll cycle started window=${POLL_SPREAD_MS}ms ahead=${POLL_AHEAD_MS}ms`);
    }, alignDelay);
  };

  const onServiceUpdated = async (newStatus: ServiceStatus, prev?: ServiceStatus, source: UpdateContext = "normal") => {
    const cfg = getServiceConfig(newStatus.id);
    if (!cfg) return; // unknown service id
    const old = prev ?? statusCache.get(newStatus.id);
    statusCache.set(newStatus.id, newStatus);
    lastUpdateContext = source;
    // Update last-seen timestamp when status is known (not unknown)
    try {
      if (newStatus.status !== "unknown" && newStatus.lastChecked) {
        lastSeenTimestamps.set(newStatus.id, new Date(newStatus.lastChecked).getTime());
      }
    } catch {
      /* ignore */
    }
    const changed = statusChanged(old, newStatus);

    if (!changed) return;

    // Manage issue polling membership
    const isIssue = isIssueStatus(newStatus.status);
    const inIssueSet = issueServices.has(cfg.id);
    const wasIssue = old ? isIssueStatus(old.status) : false;

    if (isIssue && !wasIssue) {
      logImportant(`Incident detected: ${cfg.id} (${cfg.name}) status=${newStatus.status} PID=${process.pid}`);
    } else if (!isIssue && wasIssue) {
      logImportant(`Incident resolved: ${cfg.id} (${cfg.name}) PID=${process.pid}`);
    }

    if (isIssue && !cfg.isGroupRoot && !inIssueSet) {
      issueServices.add(cfg.id);
      ensureIssuePollCycle();
    }
    if (!isIssue && inIssueSet) {
      issueServices.delete(cfg.id);
      const pending = issuePollTimeouts.get(cfg.id);
      if (pending) {
        clearTimeout(pending);
        issuePollTimeouts.delete(cfg.id);
      }
      if (issueServices.size === 0) {
        stopIssuePolling();
      }
    }

    // Update embeds only when there are issues or resolving previous ones, or when this service changed significantly
    // Throttle incident edits to the aligned heartbeat tick; avoid immediate edits here
    // Still allow the heartbeat to refresh the embeds on the 5-minute schedule.
  };

  const clearNonIssueTimeouts = () => {
    for (const t of nonIssueTimeouts) clearTimeout(t);
    nonIssueTimeouts = [];

    if (sweepWindowTimer) clearTimeout(sweepWindowTimer);
    sweepWindowTimer = null;

    // Counters should reflect “nothing pending” now
    sweepRemainingChecks = 0;
    sweepPlannedBatch = 0;
    // (optional) keep sweepPlannedTotal as “last known total candidates” or also reset it:
    // sweepPlannedTotal = 0;
  };

  const clearAwsTimeouts = () => {
    for (const t of nonIssueTimeoutsAws) clearTimeout(t);
    nonIssueTimeoutsAws = [];

    if (sweepWindowTimerAws) clearTimeout(sweepWindowTimerAws);
    sweepWindowTimerAws = null;

    sweepRemainingChecksAws = 0;
    sweepPlannedBatchAws = 0;
    // sweepPlannedTotalAws can be preserved or reset as needed
  };

  const scheduleNonIssueSweep = () => {
    clearNonIssueTimeouts();
    sweepGen++;
    const myGen = sweepGen;

    if (sweepWindowTimer) clearTimeout(sweepWindowTimer);
    sweepWindowTimer = null;
    // Build list of services to check that are not currently under issue polling
    const candidates: ServiceConfig[] = Categories.flatMap((c) => c.services)
      .filter((svc) => {
        // Never directly poll group roots like "aws"; they are aggregates only
        if (svc.isGroupRoot) return false;
        // Exclude AWS children from default sweep; they are handled by the AWS sweep
        if (svc.groupId === "aws") return false;

        if (issueServices.has(svc.id)) return false; // handled by 5-min polling
        const st = statusCache.get(svc.id);
        // include if unknown or operational (or not yet checked)
        return !st || st.status === "operational" || st.status === "unknown";
      })
      .sort((a, b) => a.id.localeCompare(b.id));
    const count = candidates.length;
    if (count === 0) return;
    if (sweepCursor >= count) sweepCursor = 0;
    const batch = candidates.slice(sweepCursor, sweepCursor + MAX_CHECKS_PER_SWEEP);
    sweepCursor += batch.length;

    const windowMs = 30 * 60 * 1000;
    const spacing = Math.max(250, Math.floor(windowMs / batch.length));
    sweepPlannedTotal = candidates.length;
    sweepPlannedBatch = batch.length;
    sweepRemainingChecks = batch.length;

    logInfo(`Sweep: total=${candidates.length} batch=${batch.length} cursor=${sweepCursor} spacing=${spacing}ms`);
    logInfo(`SweepCheck Start: RunID=${runId} PID=${process.pid}`);

    batch.forEach((cfg, idx) => {
      const t = setTimeout(async () => {
        if (isStale()) return;
        if (stopped) return;
        if (myGen !== sweepGen) return; // stale timeout from an older sweep

        try {
          // If moved to issue polling, treat as "done" for this batch
          if (issueServices.has(cfg.id)) {
            logInfo(`SweepCheck skip svc=${cfg.id} (moved to issue polling)`);
            return;
          }
          v2LogCheck("normal", cfg.name, runId);
          const updated = await checkSingleService(cfg);
          if (isStale()) return;
          recordCheckResult(updated.status);

          const before = statusCache.get(cfg.id);
          await onServiceUpdated(updated, before, "normal");
        } catch (e) {
          recordCheckFailure();
          logWarn(`Sweep check failed for ${cfg.id}: ${(e as Error).message}`);
          logImportantWarn(`Check failed: ${cfg.id} (${cfg.name}) err=${(e as Error).message}`);
        } finally {
          sweepRemainingChecks = Math.max(0, sweepRemainingChecks - 1);

          if (sweepRemainingChecks === 0 && !newSweepScheduled) {
            newSweepScheduled = true;
            logInfo("Sweep batch complete — scheduling next batch");
            nextSweepTimer = setTimeout(() => {
              if (isStale()) return;
              if (stopped) return;
              newSweepScheduled = false;
              scheduleNonIssueSweep();
            }, 1000);
          }
        }
      }, idx * spacing);

      nonIssueTimeouts.push(t);
    });
    sweepWindowTimer = setTimeout(() => {
      if (myGen !== sweepGen) return;
      logInfo(`Sweep window complete: cursor=${sweepCursor} total=${count} remaining=${sweepRemainingChecks}`);
    }, windowMs + 1000);
  };

  // Separate AWS sweep running in parallel
  const scheduleAwsSweep = () => {
    clearAwsTimeouts();
    sweepGenAws++;
    const myGen = sweepGenAws;

    if (sweepWindowTimerAws) clearTimeout(sweepWindowTimerAws);
    sweepWindowTimerAws = null;

    const candidates: ServiceConfig[] = Categories.flatMap((c) => c.services)
      .filter((svc) => {
        if (svc.isGroupRoot) return false; // not the aggregate row
        if (svc.groupId !== "aws") return false; // only AWS children here
        if (issueServices.has(svc.id)) return false;
        const st = statusCache.get(svc.id);
        return !st || st.status === "operational" || st.status === "unknown";
      })
      .sort((a, b) => a.id.localeCompare(b.id));

    const count = candidates.length;
    if (count === 0) return;
    if (sweepCursorAws >= count) sweepCursorAws = 0;
    const windowMs = 30 * 60 * 1000;
    const batch = candidates.slice(sweepCursorAws, sweepCursorAws + MAX_CHECKS_PER_SWEEP);
    sweepCursorAws += batch.length;
    const spacing = Math.max(250, Math.floor(windowMs / batch.length));

    sweepPlannedTotalAws = candidates.length;
    sweepPlannedBatchAws = batch.length;
    sweepRemainingChecksAws = batch.length;

    logInfo(
      `AWS Sweep: total=${candidates.length} batch=${batch.length} cursor=${sweepCursorAws} spacing=${spacing}ms`
    );

    batch.forEach((cfg, idx) => {
      const t = setTimeout(async () => {
        if (isStale()) return;
        if (stopped) return;
        if (myGen !== sweepGenAws) return;

        try {
          if (issueServices.has(cfg.id)) return;
          v2LogCheck("normal", cfg.name, runId);
          const updated = await checkSingleService(cfg);
          if (isStale()) return;
          recordCheckResult(updated.status);

          const before = statusCache.get(cfg.id);
          await onServiceUpdated(updated, before, "normal");
        } catch (e) {
          recordCheckFailure();
          logWarn(`AWS sweep check failed for ${cfg.id}: ${(e as Error).message}`);
          logImportantWarn(`Check failed: ${cfg.id} (${cfg.name}) err=${(e as Error).message}`);
        } finally {
          sweepRemainingChecksAws = Math.max(0, sweepRemainingChecksAws - 1);

          if (sweepRemainingChecksAws === 0 && !newSweepScheduledAws) {
            newSweepScheduledAws = true;
            nextSweepTimerAws = setTimeout(() => {
              if (isStale()) return;
              if (stopped) return;
              newSweepScheduledAws = false;
              scheduleAwsSweep();
            }, 1000);
          }
        }
      }, idx * spacing);
      nonIssueTimeoutsAws.push(t);
    });

    sweepWindowTimerAws = setTimeout(() => {
      if (myGen !== sweepGenAws) return;
      logInfo(
        `AWS Sweep window complete: cursor=${sweepCursorAws} total=${count} remaining=${sweepRemainingChecksAws}`
      );
    }, windowMs + 1000);
  };

  // Initial run
  try {
    // Clear channel at startup per requirement
    try {
      logInfo("Startup: clearing status channel…");
      await deleteAllMessagesInTextChannel(channel);
      logInfo("Startup: channel cleared");
      resetDiscordTracking();
    } catch (e) {
      logWarn(`Startup: channel clear failed: ${(e as Error).message}`);
      // proceed without clearing; any failures will be retried selectively
    }

    const { categories } = await fetchAllStatuses();
    // Seed cache from initial run
    for (const cat of categories) {
      for (const svc of cat.services) {
        statusCache.set(svc.id, svc);
        // seed last-seen if we have a non-unknown status
        try {
          if (svc.status !== "unknown" && svc.lastChecked) {
            lastSeenTimestamps.set(svc.id, new Date(svc.lastChecked).getTime());
          }
        } catch {
          /* ignore */
        }
      }
    }
    // Build display categories from cache (collapsing groups like AWS)
    const displayCategories = categoriesFromCache();

    const embeds = buildMainEmbeds(displayCategories);
    await upsertMainStatusEmbeds(channel, embeds, requestHardRestart);
    if (hardRestartPending) return;
    await upsertIncidentEmbeds(channel, displayCategories).catch((err) => {
      logWarn(`Incident upsert failed: ${(err as Error).message}`);
      return false as const;
    });
    logInfo(`Initial post complete pages=${embeds.length}`);

    // Initialize lastHadIssues state and start per-service schedulers
    try {
      const { issues } = summarizeIssues(displayCategories);
      lastHadIssues = issues > 0;
    } catch {
      lastHadIssues = false;
    }

    // Track active issue services for aligned issue polling
    issueServices.clear();
    for (const cat of categories) {
      for (const svc of cat.services) {
        if (isIssueStatus(svc.status)) {
          const cfg = getServiceConfig(svc.id);
          if (cfg && !cfg.isGroupRoot) issueServices.add(cfg.id);
        }
      }
    }
    ensureIssuePollCycle();

    // Stagger checks for non-issue services over 30 minutes
    scheduleNonIssueSweep();
    // Run AWS checks in a parallel sweep so large AWS feed sets don't block others
    scheduleAwsSweep();

    // Start heartbeat with appropriate cadence based on current issue state
    ensureHeartbeat(lastHadIssues ? 5 * 60 * 1000 : 30 * 60 * 1000);
    // Start retry processor for failed operations
    startRetryProcessor();
  } catch (e) {
    logWarn(`API status initial run failed: ${(e as Error).message}`);
  }

  // All further checks are handled by staggered sweep timers and aligned issue polling cycles
  watchdogTimer = setInterval(
    () => {
      if (isStale()) return;
      if (stopped) return;
      const stale = [...statusCache.values()].filter((s) => {
        const t =
          s.lastChecked instanceof Date
            ? s.lastChecked.getTime()
            : typeof s.lastChecked === "string"
              ? new Date(s.lastChecked).getTime()
              : typeof s.lastChecked === "number"
                ? s.lastChecked
                : NaN;
        return !Number.isFinite(t) || Date.now() - t > 60 * 60 * 1000;
      }).length;

      const leftThisSweepBatch = sweepRemainingChecks; // remaining checks to attempt (default sweep)
      const leftThisSweepBatchAws = sweepRemainingChecksAws; // remaining checks to attempt (AWS sweep)
      const checked = checkedSinceWatchdog;
      const ok = okSinceWatchdog;
      const issues = issueSinceWatchdog;
      const unknown = unknownSinceWatchdog;
      const fails = checkFailSinceWatchdog;

      // Reset 5-minute counters after logging
      checkedSinceWatchdog = 0;
      okSinceWatchdog = 0;
      issueSinceWatchdog = 0;
      unknownSinceWatchdog = 0;
      checkFailSinceWatchdog = 0;

      const lagSec = lastCheckAt ? Math.round((Date.now() - lastCheckAt) / 1000) : -1;

      const watchdogMsg =
        "Watchdog: " +
        `discordQ=${discordTaskQueue.length} inFlight=${updateInFlight} pendingUpdate=${pendingUpdate} pendingForce=${pendingForce} ` +
        `checks/5min=${checked} ok=${ok} issues=${issues} unknown=${unknown} fails=${fails} ` +
        `sweepTotal=${sweepPlannedTotal} sweepBatch=${sweepPlannedBatch} leftInBatch=${leftThisSweepBatch} ` +
        `awsSweepTotal=${sweepPlannedTotalAws} awsSweepBatch=${sweepPlannedBatchAws} awsLeftInBatch=${leftThisSweepBatchAws} ` +
        `staleServices=${stale} lastCheckLag=${lagSec}s RunID=${runId} PID=${process.pid}`;
      logInfo(watchdogMsg);
      logImportant(watchdogMsg);
    },
    60 * 5 * 1000
  );
  activeReportingStop = () => {
    activeReportingRunId++;
    stopped = true;
    // Invalidate any already-scheduled sweep callbacks
    sweepGen++;
    sweepGenAws++;
    // Clear the staggered non-issue sweep timers + sweep window timer
    clearNonIssueTimeouts();
    // Clear AWS sweep timers
    clearAwsTimeouts();
    // Clear the next sweep timer
    if (nextSweepTimer) {
      clearTimeout(nextSweepTimer);
      nextSweepTimer = null;
    }
    if (nextSweepTimerAws) {
      clearTimeout(nextSweepTimerAws);
      nextSweepTimerAws = null;
    }
    newSweepScheduled = false;
    newSweepScheduledAws = false;

    // Clear Heartbeat
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (heartbeatAlignTimeout) {
      clearTimeout(heartbeatAlignTimeout);
      heartbeatAlignTimeout = null;
    }
    heartbeatMsCurrent = null;

    // Clear Retry Processor
    if (retryTimer) {
      clearInterval(retryTimer);
      retryTimer = null;
    }

    // Clear Watchdog logger
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }

    // Clear aligned issue polling timers and state
    stopIssuePolling();
    issueServices.clear();

    // Clear any pending debounced update timer
    if (updateSoonTimer) {
      clearTimeout(updateSoonTimer);
      updateSoonTimer = null;
    }
    updateSoonForce = false;

    // Reset coalescing flags
    updateInFlight = false;
    pendingForce = null;
    pendingUpdate = false;

    logInfo("[APIStatus] Reporting stopped, all timers cleared.");
  };
}

export function stopApiStatusReporting() {
  if (activeReportingStop) {
    activeReportingStop();
    activeReportingStop = null;
  }
}
