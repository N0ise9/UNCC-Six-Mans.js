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
// Track Discord connectivity around embed operations
let discordHadErrorSinceLastReset = false;
let discordHadSuccessSinceLastError = false;

// Small helper to space out Discord API calls and avoid burst rate limits
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  const safeLine = (s: ServiceStatus) => {
    // For unknown (unreachable) show last-seen timestamp when available
    if (s.status === "unknown") {
      const ts = lastSeenTimestamps.get(s.id);
      const seen = ts ? ` — last seen <t:${Math.floor(ts / 1000)}:R>` : "";
      return `${statusEmoji(s.status)} ${s.name}${seen}`;
    }
    const desc = (s.description || "").toString().trim();
    const maxLine = 90;
    const truncated = desc.length > maxLine ? desc.slice(0, maxLine - 1) + "…" : desc;
    const suffix = truncated ? ` — ${truncated}` : "";
    return `${statusEmoji(s.status)} ${s.name}${suffix}`;
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
  const embed = new MessageEmbed({
    color: ColorCodes.DarkRed,
    title: `Incident — ${service.name}`,
    url: service.pageUrl,
    description: `${statusEmoji(service.status)} ${service.description ?? service.status}\nLast updated: <t:${Math.floor(Date.now() / 1000)}:R>`,
  });

  const incidents: IncidentInfo[] = service.incidents || [];
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

  embed.addFields({
    name: active.name,
    value: active.shortlink ? `[Status Page](${active.shortlink})` : service.pageUrl,
  });

  if (usedChunks.length === 0) {
    embed.addFields({ name: "Updates", value: "No updates yet." });
  } else if (usedChunks.length === 1) {
    embed.addFields({ name: "Updates", value: usedChunks[0] });
  } else {
    usedChunks.forEach((c, i) => embed.addFields({ name: `Updates (${i + 1}/${usedChunks.length})`, value: c }));
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
      const hasIssue = s.status !== "operational" && s.status !== "unknown";
      const hasIncidentDetails = Array.isArray(s.incidents) && s.incidents.length > 0;
      const existing = incidentMessages.get(s.id);
      if (hasIssue && hasIncidentDetails) {
        if (existing) {
          // edit existing
          try {
            // prefer cache to reduce API hits
            const cached = channel.messages.cache.get(existing.messageId);
            const msg = cached ?? (await channel.messages.fetch(existing.messageId));
            await msg.edit({ embeds: [buildIncidentEmbed(s)] });
            discordHadSuccessSinceLastError = true;
          } catch (e) {
            discordHadErrorSinceLastReset = true;
            // recreate if missing or edit failed
            try {
              const newMsg = await channel.send({ embeds: [buildIncidentEmbed(s)] });
              incidentMessages.set(s.id, { messageId: newMsg.id, serviceId: s.id });
              discordHadSuccessSinceLastError = true;
            } catch (err) {
              allOk = false;
              discordHadErrorSinceLastReset = true;
              console.warn("Failed to recreate incident message:", (err as Error).message);
            }
          }
        } else {
          try {
            const newMsg = await channel.send({ embeds: [buildIncidentEmbed(s)] });
            incidentMessages.set(s.id, { messageId: newMsg.id, serviceId: s.id });
            discordHadSuccessSinceLastError = true;
          } catch (e) {
            allOk = false;
            discordHadErrorSinceLastReset = true;
            console.warn("Failed to send incident message:", (e as Error).message);
          }
        }
        // throttle between message mutations
        await sleep(300);
      } else if (existing) {
        // resolved — delete the incident embed
        try {
          const cached = channel.messages.cache.get(existing.messageId);
          const msg = cached ?? (await channel.messages.fetch(existing.messageId));
          await msg.delete();
          discordHadSuccessSinceLastError = true;
        } catch (e) {
          discordHadErrorSinceLastReset = true;
          console.warn("Failed to delete incident message:", (e as Error).message);
          allOk = false;
        }
        incidentMessages.delete(s.id);
        await sleep(200);
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

  // Edit in place for shared range
  for (let i = 0; i < minCount; i++) {
    try {
      await current[i].edit({ embeds: [embeds[i]] });
      discordHadSuccessSinceLastError = true;
    } catch (err) {
      discordHadErrorSinceLastReset = true;
      try {
        const sent = await channel.send({ embeds: [embeds[i]] });
        current[i] = sent;
        discordHadSuccessSinceLastError = true;
      } catch (e) {
        discordHadErrorSinceLastReset = true;
        console.warn("Failed to update status page:", (e as Error).message);
        allOk = false;
      }
    }
    await sleep(300);
  }

  // If there are extra old pages, delete them
  if (current.length > embeds.length) {
    for (let i = embeds.length; i < current.length; i++) {
      try {
        await current[i].delete();
        discordHadSuccessSinceLastError = true;
      } catch (e) {
        discordHadErrorSinceLastReset = true;
        console.warn("Failed to delete extra status page:", (e as Error).message);
        allOk = false;
      }
      await sleep(300);
    }
    mainStatusMessages = current.slice(0, embeds.length);
  }

  // If we need more pages, send them
  if (embeds.length > current.length) {
    for (let i = current.length; i < embeds.length; i++) {
      try {
        const sent = await channel.send({ embeds: [embeds[i]] });
        mainStatusMessages.push(sent);
        discordHadSuccessSinceLastError = true;
      } catch (e) {
        discordHadErrorSinceLastReset = true;
        console.warn("Failed to send a status page:", (e as Error).message);
        allOk = false;
      }
      await sleep(300);
    }
  }
  return allOk;
}

export async function startApiStatusReporting(channel: TextChannel) {
  // State for adaptive, staggered polling
  let lastHadIssues = false;
  const statusCache = new Map<string, ServiceStatus>(); // serviceId -> last known status
  const issueIntervals = new Map<string, ReturnType<typeof setInterval>>(); // serviceId -> interval handle
  let nonIssueTimeouts: Array<ReturnType<typeof setTimeout>> = []; // scheduled one-offs over 15 minutes
  let nonIssueSweepTimer: ReturnType<typeof setTimeout> | null = null; // timer to start next 15-min sweep
  // Discord availability & desired state buffering
  let discordUnavailable = false;
  let desiredMainEmbeds: MessageEmbed[] = [];
  let desiredIncidentCategories: { name: string; services: ServiceStatus[] }[] = [];
  let reconnectInterval: ReturnType<typeof setInterval> | null = null;

  const setDiscordUnavailable = (v: boolean) => {
    if (discordUnavailable === v) return;
    discordUnavailable = v;
    if (discordUnavailable) {
      if (!reconnectInterval) {
        reconnectInterval = setInterval(
          async () => {
            try {
              // Attempt to flush desired state periodically while offline
              await flushDiscordIfPossible();
            } catch {
              // ignore
            }
          },
          2 * 60 * 1000
        ); // try every 2 minutes
      }
    } else if (reconnectInterval) {
      clearInterval(reconnectInterval);
      reconnectInterval = null;
    }
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

  const resetDiscordFlags = () => {
    discordHadErrorSinceLastReset = false;
    discordHadSuccessSinceLastError = false;
  };

  const performFullChannelResync = async () => {
    console.warn("Discord appears to have recovered; performing full channel resync for API status.");

    // Try to clear all messages in the status channel
    try {
      await deleteAllMessagesInTextChannel(channel);
    } catch (e) {
      // If we can't clear the channel, don't get stuck in a loop;
      // just log and clear flags so we fall back to incremental updates.
      console.warn("Failed to clear API status channel on resync:", (e as Error).message);
      resetDiscordFlags();
      return;
    }

    // Reset local tracking; we're starting fresh from cache
    mainStatusMessages = [];
    incidentMessages.clear();

    const cats = categoriesFromCache();
    const embeds = buildMainEmbeds(cats);

    // Rebuild main status embeds
    await upsertMainStatusEmbeds(channel, embeds);

    // Rebuild incident embeds (if any)
    try {
      await upsertIncidentEmbeds(channel, cats);
    } catch (err) {
      console.warn("Incident embed update failed during resync:", (err as Error).message);
    }

    resetDiscordFlags();
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
      if ((aTop.created_at || "") !== (bTop.created_at || "")) return true;
      const au = aTop.incident_updates?.[0]?.created_at || "";
      const bu = bTop.incident_updates?.[0]?.created_at || "";
      if (au !== bu) return true;
    }
    return false;
  };

  const flushDiscordIfPossible = async () => {
    if (!discordUnavailable) return;
    if (desiredMainEmbeds.length === 0 && desiredIncidentCategories.length === 0) return;
    const okMain = desiredMainEmbeds.length ? await upsertMainStatusEmbeds(channel, desiredMainEmbeds) : true;
    const okInc = desiredIncidentCategories.length
      ? await upsertIncidentEmbeds(channel, desiredIncidentCategories)
      : true;
    if (okMain && okInc) {
      setDiscordUnavailable(false);
      console.info("Reconnected to Discord — flushed pending status updates.");
    }
  };

  const updateEmbedsIfNeeded = async (force: boolean = false) => {
    const cats = categoriesFromCache();
    const { issues } = summarizeIssues(cats);
    const hasIssuesNow = issues > 0;

    // If we previously saw Discord errors AND have now observed at least one
    // successful Discord operation, do a one-shot full resync instead of incremental updates.
    if (discordHadErrorSinceLastReset && discordHadSuccessSinceLastError) {
      await performFullChannelResync();
      // Recompute from cache after resync in case it changed while we were updating
      const { issues: postIssues } = summarizeIssues(categoriesFromCache());
      lastHadIssues = postIssues > 0;
      return;
    }

    const shouldUpdate = force || hasIssuesNow || lastHadIssues;
    if (shouldUpdate) {
      const embeds = buildMainEmbeds(cats);
      await upsertMainStatusEmbeds(channel, embeds);
      try {
        await upsertIncidentEmbeds(channel, cats);
      } catch (err) {
        console.warn("Incident embed update failed:", (err as Error).message);
      }
    }
    lastHadIssues = hasIssuesNow;
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
            const updated = await checkSingleService(cfg);
            const before = statusCache.get(cfg.id);
            await onServiceUpdated(updated, before);
            // If resolved, stop interval
            if (updated.status === "operational" || updated.status === "unknown") {
              const h = issueIntervals.get(cfg.id);
              if (h) clearInterval(h);
              issueIntervals.delete(cfg.id);
            }
          } catch (e) {
            console.warn(`Polling failed for ${cfg.id}:`, (e as Error).message);
          }
        },
        5 * 60 * 1000
      );
      issueIntervals.set(cfg.id, handle);
    }
    if (!isIssue && wasIssue) {
      const h = issueIntervals.get(cfg.id);
      if (h) clearInterval(h);
      issueIntervals.delete(cfg.id);
    }

    // Update embeds only when there are issues or resolving previous ones, or when this service changed significantly
    if (changed) {
      await updateEmbedsIfNeeded(false);
    }
  };

  const clearNonIssueTimeouts = () => {
    for (const t of nonIssueTimeouts) clearTimeout(t);
    nonIssueTimeouts = [];
  };

  const scheduleNonIssueSweep = () => {
    clearNonIssueTimeouts();
    // Build list of services to check that are not currently under issue polling
    const candidates: ServiceConfig[] = Categories.flatMap((c) => c.services).filter((svc) => {
      // Never directly poll group roots like "aws"; they are aggregates only
      if (svc.isGroupRoot) return false;

      if (issueIntervals.has(svc.id)) return false; // handled by 5-min polling
      const st = statusCache.get(svc.id);
      // include if unknown or operational (or not yet checked)
      return !st || st.status === "operational" || st.status === "unknown";
    });
    const count = candidates.length;
    if (count === 0) return;
    const windowMs = 15 * 60 * 1000;
    const spacing = Math.max(1000, Math.floor(windowMs / count));
    candidates.forEach((cfg, idx) => {
      const t = setTimeout(async () => {
        // Skip if this service moved to issue polling since scheduled
        if (issueIntervals.has(cfg.id)) return;
        try {
          const updated = await checkSingleService(cfg);
          const before = statusCache.get(cfg.id);
          await onServiceUpdated(updated, before);
        } catch (e) {
          console.warn(`Sweep check failed for ${cfg.id}:`, (e as Error).message);
        }
      }, idx * spacing);
      nonIssueTimeouts.push(t);
    });
  };

  const planNextNonIssueSweep = () => {
    if (nonIssueSweepTimer) clearTimeout(nonIssueSweepTimer);
    nonIssueSweepTimer = setTimeout(
      () => {
        scheduleNonIssueSweep();
        planNextNonIssueSweep();
      },
      15 * 60 * 1000
    );
  };

  // Initial run
  try {
    // Clear channel at startup per requirement
    try {
      await deleteAllMessagesInTextChannel(channel);
    } catch (e) {
      console.warn("Failed to clear API status channel on startup:", (e as Error).message);
      setDiscordUnavailable(true);
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
    if (discordUnavailable) {
      desiredMainEmbeds = embeds;
      desiredIncidentCategories = displayCategories;
      await flushDiscordIfPossible();
    } else {
      const okMain = await upsertMainStatusEmbeds(channel, embeds);
      const okInc = await upsertIncidentEmbeds(channel, displayCategories).catch((err) => {
        console.warn("Incident embed update failed:", (err as Error).message);
        return false;
      });
      if (!okMain || !okInc) {
        desiredMainEmbeds = embeds;
        desiredIncidentCategories = displayCategories;
        setDiscordUnavailable(true);
      }
    }
    console.info(`Status posted successfully (pages: ${embeds.length}).`);

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
                  const before = statusCache.get(cfg.id);
                  await onServiceUpdated(updated, before);
                  if (updated.status === "operational" || updated.status === "unknown") {
                    const h = issueIntervals.get(cfg.id);
                    if (h) clearInterval(h);
                    issueIntervals.delete(cfg.id);
                  }
                } catch (e) {
                  console.warn(`Polling failed for ${cfg.id}:`, (e as Error).message);
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
    planNextNonIssueSweep();
  } catch (e) {
    console.warn("API status initial run failed:", (e as Error).message);
  }

  // All further checks are handled by staggered sweep timers and per-issue intervals
}
