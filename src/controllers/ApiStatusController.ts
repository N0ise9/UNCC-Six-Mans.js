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
} from "../services/ApiStatusService";

type IncidentMessage = {
  messageId: string;
  serviceId: string;
};

let mainStatusMessages: Message[] = [];
const incidentMessages = new Map<string, IncidentMessage>(); // key: serviceId
// Track last time a service's status page was successfully seen (any non-unknown status)
const lastSeenTimestamps = new Map<string, number>(); // serviceId -> epoch ms
// Track Discord connectivity around embed operations (removed detailed flag usage; retry is selective now)

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
const logInfo = (msg: string) => console.info(`[APIStatus ${nowLocalMs()}] ${msg}`);
const logWarn = (msg: string) => console.warn(`[APIStatus ${nowLocalMs()}] ${msg}`);

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

function overallColor(categories: { services: ServiceStatus[] }[]): number {
  const severityRank: Record<ServiceStatus["status"], number> = {
    operational: 0,
    under_maintenance: 1,
    degraded_performance: 2,
    partial_outage: 3,
    major_outage: 4,
    unknown: 5,
  };

  let worst: ServiceStatus["status"] = "operational";
  let worstRank = severityRank[worst];
  for (const c of categories) {
    for (const s of c.services) {
      const r = severityRank[s.status];
      if (r > worstRank) {
        worst = s.status;
        worstRank = r;
      }
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

  // Map incident impacts/status text to a StatusLevel for display emphasis
  const impactToLevel = (impact?: string, status?: string): StatusLevel => {
    const imp = (impact || "").toLowerCase();
    const st = (status || "").toLowerCase();
    if (/scheduled|in_progress/.test(st)) return "under_maintenance";
    if (imp === "critical") return "major_outage";
    if (imp === "major") return "partial_outage";
    if (imp === "minor") return "degraded_performance";
    if (/(investigating|identified|monitoring|verifying|postmortem)/.test(st)) return "degraded_performance";
    return "operational";
  };

  const worstFromIncidents = (incidents?: IncidentInfo[]): StatusLevel => {
    if (!incidents || incidents.length === 0) return "operational";
    let worst: StatusLevel = "operational";
    const rank: Record<StatusLevel, number> = {
      operational: 0,
      under_maintenance: 1,
      degraded_performance: 2,
      partial_outage: 3,
      major_outage: 4,
      unknown: -1,
    };
    for (const inc of incidents) {
      const lvl = impactToLevel(inc.impact, inc.status);
      if (rank[lvl] > rank[worst]) worst = lvl;
    }
    return worst;
  };

  const safeLine = (s: ServiceStatus) => {
    let iconStatus: StatusLevel = s.status;
    // If incidents exist but status is operational/unknown, derive a more accurate emphasis from incident impacts
    if ((s.status === "operational" || s.status === "unknown") && s.incidents && s.incidents.length > 0) {
      const worst = worstFromIncidents(s.incidents);
      if (worst !== "operational") iconStatus = worst;
    }
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
  // Derive a better emoji level if incidents exist but status is operational/unknown
  const impactToLevel = (impact?: string, status?: string): StatusLevel => {
    const imp = (impact || "").toLowerCase();
    const st = (status || "").toLowerCase();
    if (/scheduled|in_progress/.test(st)) return "under_maintenance";
    if (imp === "critical") return "major_outage";
    if (imp === "major") return "partial_outage";
    if (imp === "minor") return "degraded_performance";
    if (/(investigating|identified|monitoring|verifying|postmortem)/.test(st)) return "degraded_performance";
    return service.status;
  };
  let iconStatus: StatusLevel = service.status;
  if ((service.status === "operational" || service.status === "unknown") && incidents.length > 0) {
    let worst: StatusLevel = "operational";
    const rank: Record<StatusLevel, number> = {
      operational: 0,
      under_maintenance: 1,
      degraded_performance: 2,
      partial_outage: 3,
      major_outage: 4,
      unknown: -1,
    };
    for (const inc of incidents) {
      const lvl = impactToLevel(inc.impact, inc.status);
      if (rank[lvl] > rank[worst]) worst = lvl;
    }
    if (worst !== "operational") iconStatus = worst;
  }

  const embed = new MessageEmbed({
    color: ColorCodes.DarkRed,
    title: `Incident — ${service.name}`,
    url: service.pageUrl,
    description: `${statusEmoji(iconStatus)} ${service.description ?? service.status}\nLast updated: <t:${Math.floor(Date.now() / 1000)}:R>`,
  });

  if (incidents.length === 0) {
    embed.addFields({ name: "Details", value: "Issue detected without incident details." });
    return embed;
  }

  const active = incidents[0];
  const updateLines = (active.incident_updates || []).map(
    (u) => `• [<t:${Math.floor(new Date(u.created_at).getTime() / 1000)}:R>] ${u.body}`
  );

  // Build fields with values <= 1024 chars each
  const MAX_FIELD_VALUE = 1024;
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

  const incidentTitle = (active.name || "").toString().trim() || "Incident";
  const linkValue = (active.shortlink ? `[Status Page](${active.shortlink})` : service.pageUrl) || service.pageUrl;
  embed.addFields({ name: incidentTitle, value: linkValue });

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
      const hasIssue = (s.status !== "operational" && s.status !== "unknown") || (s.incidents?.length || 0) > 0;
      const hasIncidentDetails = Array.isArray(s.incidents) && s.incidents.length > 0;
      const existing = incidentMessages.get(s.id);
      if (hasIssue && hasIncidentDetails) {
        if (existing) {
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
            await queueDiscord(
              () => msg.edit({ embeds: [buildIncidentEmbed(s)] }),
              `edit incident ${existing.messageId}`
            );
            // success: clear any pending retry for this service
            incidentRetry.delete(s.id);
            logInfo(`Incident edit: ${s.id} (${s.name}) msg=${existing.messageId}`);
          } catch (e) {
            logWarn(`Incident edit failed: ${s.id} (${s.name}) msg=${existing?.messageId} err=${(e as Error).message}`);
            // enqueue retry for this service
            incidentRetry.add(s.id);
            // also try recreate immediately
            try {
              const newMsg = await queueDiscord(
                () => channel.send({ embeds: [buildIncidentEmbed(s)] }),
                `send incident ${s.id}`
              );
              incidentMessages.set(s.id, { messageId: newMsg.id, serviceId: s.id });
              incidentRetry.delete(s.id);
              logInfo(`Incident create (after edit fail): ${s.id} (${s.name}) msg=${newMsg.id}`);
            } catch (err) {
              allOk = false;
              logWarn(`Incident recreate failed: ${s.id} (${s.name}) err=${(err as Error).message}`);
              incidentRetry.add(s.id);
            }
          }
        } else {
          try {
            const newMsg = await queueDiscord(
              () => channel.send({ embeds: [buildIncidentEmbed(s)] }),
              `send incident ${s.id}`
            );
            incidentMessages.set(s.id, { messageId: newMsg.id, serviceId: s.id });
            incidentRetry.delete(s.id);
            logInfo(`Incident create: ${s.id} (${s.name}) msg=${newMsg.id}`);
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
          logInfo(`Incident delete: ${s.id} (${s.name}) msg=${existing.messageId}`);
        } catch (e) {
          logWarn(`Incident delete failed: ${s.id} (${s.name}) msg=${existing.messageId} err=${(e as Error).message}`);
          allOk = false;
          incidentRetryDelete.set(s.id, existing.messageId);
        }
        incidentMessages.delete(s.id);
      }
    }
  }
  return allOk;
}

// Edit existing page messages when possible; only delete/create when count changes
// Returns true if all discord operations succeeded; false if any failed
async function upsertMainStatusEmbeds(channel: TextChannel, embeds: MessageEmbed[]): Promise<boolean> {
  const current = mainStatusMessages;
  const minCount = Math.min(current.length, embeds.length);
  let allOk = true;
  logInfo(`Main upsert: have=${current.length} need=${embeds.length}`);

  // Edit in place for shared range
  for (let i = 0; i < minCount; i++) {
    try {
      await queueDiscord(() => current[i].edit({ embeds: [embeds[i]] }), `edit main page ${i + 1}`);
      mainRetryUpsert.delete(i);
      logInfo(`Main edit: page#${i + 1}`);
    } catch (err) {
      logWarn(`Main edit failed: page#${i + 1} err=${(err as Error).message}`);
      try {
        const sent = await queueDiscord(() => channel.send({ embeds: [embeds[i]] }), `send main page ${i + 1}`);
        current[i] = sent;
        mainRetryUpsert.delete(i);
        logInfo(`Main create (after edit fail): page#${i + 1} msg=${sent.id}`);
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
        logInfo(`Main delete: page#${i + 1}`);
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
        logInfo(`Main create: page#${i + 1} msg=${sent.id}`);
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
    activeReportingRunId++;
    activeReportingStop();
    activeReportingStop = null;
  }
  const runId = activeReportingRunId;
  logInfo(`[APIStatus] Starting reporting run #${runId}`);

  // State for adaptive, staggered polling
  let lastHadIssues = false;
  const statusCache = new Map<string, ServiceStatus>(); // serviceId -> last known status
  const issueIntervals = new Map<string, ReturnType<typeof setInterval>>(); // serviceId -> interval handle
  let nonIssueTimeouts: Array<ReturnType<typeof setTimeout>> = []; // scheduled one-offs over 15 minutes
  // Heartbeat to ensure embeds refresh periodically; interval adapts based on whether issues exist
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatMsCurrent: number | null = null;
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  let nextSweepTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  // Coalesced update control
  let updateInFlight = false;
  let pendingForce: boolean | null = null;
  let pendingUpdate = false; // NEW: remembers non-force updates that happened during inFlight
  let updateSoonTimer: ReturnType<typeof setTimeout> | null = null;
  let updateSoonForce = false;
  // Retry processor timer (2 minutes)
  let retryTimer: ReturnType<typeof setInterval> | null = null;
  let sweepCursor = 0;
  const MAX_CHECKS_PER_SWEEP = 1000; // # to check per sweep window (aid to avoid throttling)

  const startRetryProcessor = () => {
    if (retryTimer) return;
    retryTimer = setInterval(
      async () => {
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

    const rank: Record<StatusLevel, number> = {
      operational: 0,
      under_maintenance: 1,
      degraded_performance: 2,
      partial_outage: 3,
      major_outage: 4,
      unknown: -1,
    };

    let topStatus: StatusLevel = "operational";
    let latestChecked = rootStatus.lastChecked ?? new Date(0);
    const incidents: IncidentInfo[] = [];

    for (const child of children) {
      // pick worst status among children
      if (rank[child.status] > rank[topStatus]) {
        topStatus = child.status;
      }
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

  const ensureHeartbeat = (desiredMs: number) => {
    if (heartbeatMsCurrent === desiredMs && heartbeatTimer) return;
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(async () => {
      try {
        requestUpdateSoon(true);
      } catch (e) {
        logWarn(`Heartbeat update failed: ${(e as Error).message}`);
      }
    }, desiredMs);
    heartbeatMsCurrent = desiredMs;
    const mins = Math.round(desiredMs / 60000);
    logInfo(`Heartbeat started interval=${mins}m`);
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
    const cats = categoriesFromCache();
    const { issues } = summarizeIssues(cats);
    const hasIssuesNow = issues > 0;

    const shouldUpdate = force || hasIssuesNow || lastHadIssues;
    if (shouldUpdate) {
      const embeds = buildMainEmbeds(cats);
      const okMain = await upsertMainStatusEmbeds(channel, embeds);
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
      if (againForce || againAny) {
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

  const onServiceUpdated = async (newStatus: ServiceStatus, prev?: ServiceStatus) => {
    const cfg = getServiceConfig(newStatus.id);
    if (!cfg) return; // unknown service id
    const old = prev ?? statusCache.get(newStatus.id);
    statusCache.set(newStatus.id, newStatus);
    // Update last-seen timestamp when status is known (not unknown)
    try {
      if (newStatus.status !== "unknown" && newStatus.lastChecked) {
        lastSeenTimestamps.set(newStatus.id, new Date(newStatus.lastChecked).getTime());
      }
    } catch {
      /* ignore */
    }
    const changed = statusChanged(old, newStatus);

    // Manage per-service polling strategy transitions
    const isIssue = newStatus.status !== "operational" && newStatus.status !== "unknown";
    const wasIssue = old ? old.status !== "operational" && old.status !== "unknown" : false;

    if (isIssue && !issueIntervals.has(cfg.id)) {
      // start 5-min polling for this service
      const handle = setInterval(
        async () => {
          try {
            logInfo(`IssuePoll start svc=${cfg.id}`);
            const updated = await checkSingleService(cfg);
            logInfo(`IssuePoll done svc=${cfg.id} status=${updated.status}`);

            // ---- metrics ----
            checkedSinceWatchdog++;
            lastCheckAt = Date.now();
            if (updated.status === "operational") okSinceWatchdog++;
            else if (updated.status === "unknown") unknownSinceWatchdog++;
            else issueSinceWatchdog++;

            const before = statusCache.get(cfg.id);
            await onServiceUpdated(updated, before);

            // If resolved, stop interval
            if (updated.status === "operational" || updated.status === "unknown") {
              const h = issueIntervals.get(cfg.id);
              if (h) clearInterval(h);
              issueIntervals.delete(cfg.id);
            }
          } catch (e) {
            checkFailSinceWatchdog++;
            lastCheckAt = Date.now();
            logWarn(`Polling failed for ${cfg.id}: ${(e as Error).message}`);
          }
        },
        5 * 60 * 1000
      );
      issueIntervals.set(cfg.id, handle);
    }
    if (!isIssue && wasIssue) {
      const h = issueIntervals.get(cfg.id);
      logInfo(`IssuePoll resolved svc=${cfg.id} stopping interval`);
      if (h) clearInterval(h);
      issueIntervals.delete(cfg.id);
    }

    // Update embeds only when there are issues or resolving previous ones, or when this service changed significantly
    if (changed) {
      requestUpdateSoon(false);
    }
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

        if (issueIntervals.has(svc.id)) return false; // handled by 5-min polling
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

    batch.forEach((cfg, idx) => {
      const t = setTimeout(async () => {
        if (stopped) return;
        if (myGen !== sweepGen) return; // stale timeout from an older sweep
        try {
          // If moved to issue polling, treat as "done" for this batch
          if (issueIntervals.has(cfg.id)) {
            logInfo(`SweepCheck skip svc=${cfg.id} (moved to issue polling)`);
            return;
          }
          const updated = await checkSingleService(cfg);
          checkedSinceWatchdog++;
          lastCheckAt = Date.now();
          if (updated.status === "operational") okSinceWatchdog++;
          else if (updated.status === "unknown") unknownSinceWatchdog++;
          else issueSinceWatchdog++;

          const before = statusCache.get(cfg.id);
          await onServiceUpdated(updated, before);
        } catch (e) {
          checkFailSinceWatchdog++;
          lastCheckAt = Date.now();
          logWarn(`Sweep check failed for ${cfg.id}: ${(e as Error).message}`);
        } finally {
          sweepRemainingChecks = Math.max(0, sweepRemainingChecks - 1);

          if (sweepRemainingChecks === 0 && !newSweepScheduled) {
            newSweepScheduled = true;
            logInfo("Sweep batch complete — scheduling next batch");
            nextSweepTimer = setTimeout(() => {
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

  // Initial run
  try {
    // Clear channel at startup per requirement
    try {
      logInfo("Startup: clearing status channel…");
      await deleteAllMessagesInTextChannel(channel);
      logInfo("Startup: channel cleared");
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
    await upsertMainStatusEmbeds(channel, embeds);
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

    // Start 5-min polling for any services already having issues
    for (const cat of categories) {
      for (const svc of cat.services) {
        if (svc.status !== "operational" && svc.status !== "unknown") {
          const cfg = getServiceConfig(svc.id);
          if (cfg && !cfg.isGroupRoot && !issueIntervals.has(cfg.id)) {
            const handle = setInterval(
              async () => {
                try {
                  const updated = await checkSingleService(cfg);

                  // ---- metrics ----
                  checkedSinceWatchdog++;
                  lastCheckAt = Date.now();
                  if (updated.status === "operational") okSinceWatchdog++;
                  else if (updated.status === "unknown") unknownSinceWatchdog++;
                  else issueSinceWatchdog++;

                  const before = statusCache.get(cfg.id);
                  await onServiceUpdated(updated, before);

                  if (updated.status === "operational" || updated.status === "unknown") {
                    const h = issueIntervals.get(cfg.id);
                    if (h) clearInterval(h);
                    issueIntervals.delete(cfg.id);
                  }
                } catch (e) {
                  checkFailSinceWatchdog++;
                  lastCheckAt = Date.now();
                  logWarn(`Polling failed for ${cfg.id}: ${(e as Error).message}`);
                }
              },
              5 * 60 * 1000
            );
            issueIntervals.set(cfg.id, handle);
          }
        }
      }
    }

    // Stagger checks for non-issue services over 15 minutes
    scheduleNonIssueSweep();

    // Start heartbeat with appropriate cadence based on current issue state
    ensureHeartbeat(lastHadIssues ? 5 * 60 * 1000 : 30 * 60 * 1000);
    // Start retry processor for failed operations
    startRetryProcessor();
  } catch (e) {
    logWarn(`API status initial run failed: ${(e as Error).message}`);
  }

  // All further checks are handled by staggered sweep timers and per-issue intervals
  watchdogTimer = setInterval(
    () => {
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

      const leftThisSweepBatch = sweepRemainingChecks; // remaining checks to attempt
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

      logInfo(
        "Watchdog: " +
          `discordQ=${discordTaskQueue.length} inFlight=${updateInFlight} pendingUpdate=${pendingUpdate} pendingForce=${pendingForce} ` +
          `checks/5min=${checked} ok=${ok} issues=${issues} unknown=${unknown} fails=${fails} ` +
          `sweepTotal=${sweepPlannedTotal} sweepBatch=${sweepPlannedBatch} leftInBatch=${leftThisSweepBatch} ` +
          `staleServices=${stale} lastCheckLag=${lagSec}s`
      );
    },
    60 * 5 * 1000
  );
  activeReportingStop = () => {
    stopped = true;
    // Invalidate any already-scheduled sweep callbacks
    sweepGen++;
    // Clear the staggered non-issue sweep timers + sweep window timer
    clearNonIssueTimeouts();
    // Clear the next sweep timer
    if (nextSweepTimer) {
      clearTimeout(nextSweepTimer);
      nextSweepTimer = null;
    }
    newSweepScheduled = false;

    // Clear Heartbeat
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
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

    // Clear Per-Service issue polling intervals
    for (const h of issueIntervals.values()) clearInterval(h);
    issueIntervals.clear();

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
