/* eslint-disable max-len */
/* eslint-disable sort-keys */
import { TextChannel, EmbedBuilder as MessageEmbed, Message } from "discord.js";
import { deleteAllMessagesInTextChannel } from "../utils/discordUtils";
import { ColorCodes } from "../utils/utils";
import { fetchAllStatuses, summarizeIssues, ServiceStatus, IncidentInfo } from "../services/ApiStatusService";

type IncidentMessage = {
  messageId: string;
  serviceId: string;
};

let mainStatusMessages: Message[] = [];
const incidentMessages = new Map<string, IncidentMessage>(); // key: serviceId

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
    description: `${statusEmoji(service.status)} ${service.description ?? service.status}`,
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

async function upsertIncidentEmbeds(channel: TextChannel, categories: { name: string; services: ServiceStatus[] }[]) {
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
          } catch {
            // recreate if missing
            const newMsg = await channel.send({ embeds: [buildIncidentEmbed(s)] });
            incidentMessages.set(s.id, { messageId: newMsg.id, serviceId: s.id });
          }
        } else {
          const newMsg = await channel.send({ embeds: [buildIncidentEmbed(s)] });
          incidentMessages.set(s.id, { messageId: newMsg.id, serviceId: s.id });
        }
        // throttle between message mutations
        await sleep(300);
      } else if (existing) {
        // resolved — delete the incident embed
        try {
          const cached = channel.messages.cache.get(existing.messageId);
          const msg = cached ?? (await channel.messages.fetch(existing.messageId));
          await msg.delete();
        } catch (e) {
          console.warn("Failed to delete incident message:", (e as Error).message);
        }
        incidentMessages.delete(s.id);
        await sleep(200);
      }
    }
  }
}

// Edit existing page messages when possible; only delete/create when count changes
async function upsertMainStatusEmbeds(channel: TextChannel, embeds: MessageEmbed[]) {
  const current = mainStatusMessages;
  const minCount = Math.min(current.length, embeds.length);

  // Edit in place for shared range
  for (let i = 0; i < minCount; i++) {
    try {
      await current[i].edit({ embeds: [embeds[i]] });
    } catch (err) {
      try {
        const sent = await channel.send({ embeds: [embeds[i]] });
        current[i] = sent;
      } catch (e) {
        console.warn("Failed to update status page:", (e as Error).message);
      }
    }
    await sleep(300);
  }

  // If there are extra old pages, delete them
  if (current.length > embeds.length) {
    for (let i = embeds.length; i < current.length; i++) {
      try {
        await current[i].delete();
      } catch (e) {
        console.warn("Failed to delete extra status page:", (e as Error).message);
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
      } catch (e) {
        console.warn("Failed to send a status page:", (e as Error).message);
      }
      await sleep(300);
    }
  }
}

export async function startApiStatusReporting(channel: TextChannel) {
  // Initial run
  try {
    // Clear channel at startup per requirement
    try {
      await deleteAllMessagesInTextChannel(channel);
    } catch (e) {
      console.warn("Failed to clear API status channel on startup:", (e as Error).message);
    }

    const { categories } = await fetchAllStatuses();
    const embeds = buildMainEmbeds(categories);
    await upsertMainStatusEmbeds(channel, embeds);
    try {
      await upsertIncidentEmbeds(channel, categories);
    } catch (err) {
      console.warn("Incident embed update failed:", (err as Error).message);
    }
    console.info(`Status posted successfully (pages: ${embeds.length}).`);
  } catch (e) {
    console.warn("API status initial run failed:", (e as Error).message);
  }

  // 5-minute main embed refresher: delete prior and post new
  let refreshing = false;
  setInterval(
    async () => {
      if (refreshing) return; // skip if previous cycle still running
      refreshing = true;
      try {
        const { categories } = await fetchAllStatuses();
        const embeds = buildMainEmbeds(categories);
        await upsertMainStatusEmbeds(channel, embeds);
        try {
          await upsertIncidentEmbeds(channel, categories);
        } catch (err) {
          console.warn("Incident embed update failed:", (err as Error).message);
        }
        // refresh success: remain silent to avoid noisy logs
      } catch (e) {
        console.warn("API status refresh failed:", (e as Error).message);
      } finally {
        refreshing = false;
      }
      // every 5 minutes
    },
    5 * 60 * 1000
  );

  // Incident updates are refreshed with the 5-minute main cycle
}
