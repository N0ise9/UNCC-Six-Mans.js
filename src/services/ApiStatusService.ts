import { XMLParser } from "fast-xml-parser";

export type StatusLevel =
  | "operational"
  | "degraded_performance"
  | "partial_outage"
  | "major_outage"
  | "under_maintenance"
  | "unknown";

export interface ServiceConfig {
  id: string;
  name: string;
  pageUrl: string;
  type: "statuspage" | "generic";
  apiUrl?: string; // For statuspage or custom JSON endpoints
  rssUrl?: string; // Optional RSS/Atom feed
  rssUrls?: string[]; // Optional multiple RSS/Atom feeds to aggregate
  groupId?: string; // If set, this service is a child of groupId (e.g. "aws")
  isGroupRoot?: boolean; // If true, this is the aggregate/root (e.g. the visible "AWS" row)
}

export interface IncidentUpdateInfo {
  body: string;
  created_at: string;
}

export interface IncidentInfo {
  id: string;
  name: string;
  impact?: string;
  status?: string;
  shortlink?: string;
  created_at?: string;
  incident_updates?: IncidentUpdateInfo[];
}

export interface ServiceStatus {
  id: string;
  name: string;
  pageUrl: string;
  status: StatusLevel;
  description?: string;
  lastChecked: Date;
  incidents?: IncidentInfo[];
}

export interface CategoryConfig {
  name: string;
  services: ServiceConfig[];
}

// Helper to fetch with timeout
async function fetchWithTimeout(url: string, ms = 15000): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { headers: { "user-agent": "NormJS-StatusBot/1.0" }, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

function statuspageToLevel(indicator?: string, overall?: string): StatusLevel {
  // indicator: none|minor|major|critical; overall description might include Maintenance
  if (!indicator) return "unknown";
  const ind = indicator.toLowerCase();
  if (overall && /maintenance/i.test(overall)) return "under_maintenance";
  switch (ind) {
    case "none":
      return "operational";
    case "minor":
      return "degraded_performance";
    case "major":
      return "partial_outage";
    case "critical":
      return "major_outage";
    default:
      return "unknown";
  }
}

type StatuspageUpdate = { body: string; created_at: string };
type StatuspageIncident = {
  id: string;
  name: string;
  impact?: string;
  status?: string;
  shortlink?: string;
  created_at?: string;
  incident_updates?: StatuspageUpdate[];
  scheduled_for?: string;
  scheduled_until?: string;
  monitoring_at?: string;
};
type StatuspageSummary = {
  status?: { description?: string; indicator?: string };
  incidents?: StatuspageIncident[];
};

async function fetchStatuspage(service: ServiceConfig): Promise<ServiceStatus> {
  const apiUrl = service.apiUrl || service.pageUrl.replace(/\/?$/, "/") + "api/v2/summary.json";
  try {
    const res = await fetchWithTimeout(apiUrl);
    if (!res.ok) throw new Error(`${service.name} status API returned ${res.status}`);
    const data: StatuspageSummary = await res.json();
    let status = statuspageToLevel(data?.status?.indicator, data?.status?.description);
    // Include active outages and maintenance only when currently happening
    const nowMs = Date.now();
    const incidents: IncidentInfo[] = (data?.incidents || [])
      .filter((i) => {
        const st = (i.status || "").toLowerCase();
        const imp = (i.impact || "").toLowerCase();
        // In-progress maintenance always included
        if (/in_progress/.test(st)) return true;
        // Scheduled maintenance only if current time within the window
        if (/scheduled/.test(st)) {
          const startMs = i.scheduled_for ? Date.parse(i.scheduled_for) : NaN;
          const endMs = i.scheduled_until ? Date.parse(i.scheduled_until) : NaN;
          if (!Number.isNaN(startMs) && !Number.isNaN(endMs) && nowMs >= startMs && nowMs <= endMs) return true;
          return false;
        }
        // For non-maintenance incidents, require an active/problem state and a real impact
        const active = /(investigating|identified|monitoring|verifying|postmortem)/i.test(st);
        return active && imp && imp !== "none";
      })
      .map((i) => ({
        created_at: i.created_at,
        id: i.id,
        impact: i.impact,
        incident_updates: (i.incident_updates || []).map((u) => ({ body: u.body, created_at: u.created_at })),
        name: i.name,
        shortlink: i.shortlink,
        status: i.status,
      }));

    // If summary claims maintenance but none is currently in-progress or within window, treat as operational
    if (status === "under_maintenance" && incidents.length === 0) {
      status = "operational";
    }

    // Escalate overall status based on active incidents. Some Statuspage sites keep the indicator at "none"
    // while incidents are in progress; in that case, ensure we reflect a non-operational state.
    if (incidents.length > 0) {
      const mapImpact = (imp?: string, st?: string): StatusLevel => {
        const impact = (imp || "").toLowerCase();
        const s = (st || "").toLowerCase();
        if (/scheduled|in_progress/.test(s)) return "under_maintenance";
        switch (impact) {
          case "critical":
            return "major_outage";
          case "major":
            return "partial_outage";
          case "minor":
            return "degraded_performance";
          case "none":
          default:
            // Unknown impact but active states like investigating/identified should show degradation
            return /(investigating|identified|monitoring|verifying|postmortem)/.test(s)
              ? "degraded_performance"
              : "operational";
        }
      };
      let incWorst: StatusLevel = "operational";
      for (const inc of incidents) {
        const m = mapImpact(inc.impact, inc.status);
        incWorst = escalateStatus(incWorst, m);
      }
      status = escalateStatus(status, incWorst);
    }

    return {
      // Append short text for live maintenance, otherwise keep concise
      description:
        status === "under_maintenance" && incidents.length > 0
          ? "Maintenance in progress"
          : status === "operational"
            ? ""
            : data?.status?.description,
      id: service.id,
      incidents,
      lastChecked: new Date(),
      name: service.name,
      pageUrl: service.pageUrl,
      status: status,
    };
  } catch (e) {
    return {
      description: "Unreachable",
      id: service.id,
      incidents: [],
      lastChecked: new Date(),
      name: service.name,
      pageUrl: service.pageUrl,
      status: "unknown",
    };
  }
}

async function fetchGeneric(service: ServiceConfig): Promise<ServiceStatus> {
  try {
    const res = await fetchWithTimeout(service.pageUrl);
    const { ok, status } = res;
    return {
      description: ok ? "" : `HTTP ${status}`,
      id: service.id,
      incidents: [],
      lastChecked: new Date(),
      name: service.name,
      pageUrl: service.pageUrl,
      status: ok ? "operational" : "major_outage",
    };
  } catch (e) {
    return {
      description: "Unreachable",
      id: service.id,
      incidents: [],
      lastChecked: new Date(),
      name: service.name,
      pageUrl: service.pageUrl,
      status: "unknown",
    };
  }
}

function inferStatusFromText(text: string): StatusLevel {
  const t = text.toLowerCase();
  // Ignore informational posts explicitly stating no impact
  if (/(no\s+operational\s+impact|no\s+impact)/i.test(t)) return "operational";
  if (/(maintenance)/i.test(t)) return "under_maintenance";
  if (/(critical|major outage|service unavailable|outage|unavailable|downtime|down)/i.test(t)) return "major_outage";
  if (/(partial)/i.test(t)) return "partial_outage";
  if (/(degrad)/i.test(t)) return "degraded_performance";
  return "operational";
}

// Detect when a feed item indicates the issue has been resolved or maintenance completed
function isResolutionText(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /\b(resolved|resolution|restored|recovered)\b/.test(t) ||
    /back\s*to\s*normal/.test(t) ||
    /no\s*further\s*impact/.test(t) ||
    /monitoring\s*complete/.test(t) ||
    /incident\s*(closed|resolved)/.test(t) ||
    /maintenance\s*(completed|complete|ended|finished)/.test(t) ||
    /all\s+systems\s+operational/.test(t)
  );
}

function deriveStatuspageRssUrl(pageUrl: string): string {
  // e.g., https://www.githubstatus.com/ -> https://www.githubstatus.com/history.atom
  const base = pageUrl.replace(/\/?$/, "/");
  return base + "history.atom";
}

// AWS feed generator: build many service/region RSS endpoints
const AWS_REGIONS: readonly string[] = [
  "af-south-1",
  "ap-east-1",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-northeast-3",
  "ap-south-1",
  "ap-south-2",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-southeast-3",
  "ap-southeast-4",
  "ap-southeast-5",
  "ap-southeast-7",
  "ca-central-1",
  "ca-west-1",
  "eu-central-1",
  "eu-central-2",
  "eu-north-1",
  "eu-south-1",
  "eu-south-2",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "il-central-1",
  "me-central-1",
  "me-south-1",
  "mx-central-1",
  "sa-east-1",
  "us-east-1",
  "us-east-2",
  "us-gov-east-1",
  "us-gov-west-1",
  "us-west-1",
  "us-west-2",
];

const AWS_SERVICES_WITH_REGIONS: readonly string[] = [
  "apigateway",
  "appflow",
  "applicationinsights",
  "appmesh",
  "apprunner",
  "athena",
  "augmentedai",
  "autoscaling",
  "backup",
  "batch",
  "bedrock",
  "braket",
  "cloudformation",
  "cloudhsm",
  "cloudsearch",
  "cloudtrail",
  "cloudwatch",
  "codebuild",
  "codecommit",
  "codedeploy",
  "codepipeline",
  "config",
  "connect",
  "directconnect",
  "docdb",
  "dsql",
  "dynamodb",
  "ec2",
  "ecr",
  "ecs",
  "eks",
  "elasticache",
  "elasticbeanstalk",
  "elb",
  "emr",
  "glue",
  "guardduty",
  "kinesis",
  "kms",
  "lambda",
  "memorydb",
  "mq",
  "quicksight",
  "rds",
  "redshift",
  "s3",
  "sagemaker",
  "secretsmanager",
  "ses",
  "sns",
  "sqs",
  "transfer",
  "workdocs",
  "workmail",
  "workspaces",
  "xray",
];

function getAwsRssUrls(): string[] {
  const urls: string[] = [];
  for (const svc of AWS_SERVICES_WITH_REGIONS) {
    for (const region of AWS_REGIONS) {
      urls.push(`https://status.aws.amazon.com/rss/${svc}-${region}.rss`);
    }
  }
  // Global (no-region) feeds and special cases
  urls.push(
    "https://status.aws.amazon.com/rss/cloudfront.rss",
    "https://status.aws.amazon.com/rss/route53.rss",
    "https://status.aws.amazon.com/rss/chime.rss",
    "https://status.aws.amazon.com/rss/organizations.rss",
    // GovCloud specials that are not covered by generic service-region combos
    "https://status.aws.amazon.com/rss/route53-us-gov-east-1.rss",
    "https://status.aws.amazon.com/rss/route53-us-gov-west-1.rss",
    "https://status.aws.amazon.com/rss/chime-us-gov-east-1.rss",
    "https://status.aws.amazon.com/rss/chime-us-gov-west-1.rss",
    "https://status.aws.amazon.com/rss/organizations-us-gov-east-1.rss",
    "https://status.aws.amazon.com/rss/organizations-us-gov-west-1.rss",
    "https://status.aws.amazon.com/rss/globalaccelerator.rss"
  );
  return urls;
}

function buildAwsChildServices(): ServiceConfig[] {
  const pageUrl = "https://health.aws.amazon.com/health/status";
  const urls = getAwsRssUrls();

  return urls.map((url, idx) => {
    // derive a stable key from the URL path, e.g. "apigateway-us-east-1"
    const m = url.match(/\/rss\/([^/]+)\.rss$/);
    const slug = m ? m[1] : `feed-${idx}`;

    return {
      groupId: "aws", // roll up into the "aws" root
      id: `aws-${slug}`, // e.g. "aws-apigateway-us-east-1"
      name: `AWS ${slug}`, // internal name; UI will see only the root
      pageUrl,
      rssUrl: url, // single feed per child
      type: "generic",
    } satisfies ServiceConfig;
  });
}

type FeedEntry = {
  id?: string;
  link?: string | Record<string, unknown> | Array<Record<string, unknown>>;
  published?: string;
  updated?: string;
  title?: string;
  summary?: string | Record<string, unknown>;
  content?: string | Record<string, unknown>;
  pubDate?: string; // RSS
};

async function fetchRSS(service: ServiceConfig): Promise<ServiceStatus> {
  // If multiple feeds are provided, aggregate them
  if (service.rssUrls && service.rssUrls.length > 0) {
    const parser = new XMLParser({ attributeNamePrefix: "@_", ignoreAttributes: false });

    const parseFeed = async (url: string) => {
      try {
        const res = await fetchWithTimeout(url);
        if (!res.ok) return [] as FeedEntry[];
        const xml = await res.text();
        const parsed = parser.parse(xml);

        type AtomShape = { feed?: { title?: string; entry?: unknown | unknown[] } };
        type RssShape = { rss?: { channel?: { item?: unknown | unknown[] } } };
        const isAtom = (u: unknown): u is AtomShape => !!u && typeof u === "object" && "feed" in u;
        const isRss = (u: unknown): u is RssShape => !!u && typeof u === "object" && "rss" in u;

        const entries: FeedEntry[] = [];
        if (isAtom(parsed)) {
          const feedObj = parsed.feed as { entry?: unknown | unknown[] };
          const arr = Array.isArray(feedObj.entry) ? feedObj.entry : feedObj.entry ? [feedObj.entry] : [];
          for (const e of arr) entries.push(e as FeedEntry);
        } else if (isRss(parsed)) {
          const { channel } = parsed.rss as { channel?: { item?: unknown | unknown[] } };
          if (channel) {
            const arr = Array.isArray(channel.item) ? channel.item : channel.item ? [channel.item] : [];
            for (const e of arr) entries.push(e as FeedEntry);
          }
        }
        return entries;
      } catch {
        return [] as FeedEntry[];
      }
    };

    const lists = await Promise.all(service.rssUrls.map((u) => parseFeed(u)));
    const entries = lists.flat();
    const now = Date.now();
    const updates: IncidentUpdateInfo[] = [];
    let topStatus: StatusLevel = "operational";
    let maintenanceInProgress = false;
    let latestResolutionMs = -1;
    let latestNonOperationalMs = -1;
    const rank: Record<StatusLevel, number> = {
      degraded_performance: 2,
      major_outage: 4,
      operational: 0,
      partial_outage: 3,
      under_maintenance: 1,
      unknown: 5,
    };

    for (const e of entries.slice(0, 200)) {
      const tsStr = (e.updated || e.published || e.pubDate || "").toString();
      const ts = tsStr ? Date.parse(tsStr) : NaN;
      const title = (e.title || "").toString();
      const bodyRaw = typeof e.summary === "string" ? e.summary : typeof e.content === "string" ? e.content : "";
      const body = (bodyRaw || title).toString();
      if (!Number.isNaN(ts) && now - ts <= 1000 * 60 * 60 * 24 * 3) {
        updates.push({ body, created_at: new Date(ts).toISOString() });
        const combined = `${title} ${body}`;
        if (isResolutionText(combined)) {
          latestResolutionMs = Math.max(latestResolutionMs, ts);
          continue;
        }
        const st = inferStatusFromText(combined);
        if (st !== "operational") latestNonOperationalMs = Math.max(latestNonOperationalMs, ts);
        if (rank[st] > rank[topStatus]) topStatus = st;
        if (st === "under_maintenance" && /(in progress|ongoing)/i.test(combined)) {
          maintenanceInProgress = true;
        }
      }
    }

    // If the latest update is a resolution newer than any non-operational update, suppress incident
    if (latestNonOperationalMs !== -1 && latestResolutionMs >= latestNonOperationalMs) {
      topStatus = "operational";
      maintenanceInProgress = false;
    }

    const sorted = updates.sort((a, b) => (a.created_at > b.created_at ? -1 : 1));
    const incidents: IncidentInfo[] =
      sorted.length > 0 && topStatus !== "operational" && (topStatus !== "under_maintenance" || maintenanceInProgress)
        ? [
            {
              created_at: sorted[sorted.length - 1].created_at,
              id: `${service.id}-rss-incident`,
              impact: topStatus,
              incident_updates: sorted,
              name: `${service.name} — Aggregated RSS incidents`,
              shortlink: service.pageUrl,
              status: topStatus,
            },
          ]
        : [];

    return {
      description:
        incidents.length > 0
          ? topStatus === "under_maintenance" && maintenanceInProgress
            ? "Maintenance in progress"
            : "Recent incidents detected"
          : "",
      id: service.id,
      incidents,
      lastChecked: new Date(),
      name: service.name,
      pageUrl: service.pageUrl,
      status: incidents.length > 0 ? topStatus : "operational",
    };
  }

  let rssUrl = service.rssUrl || (service.type === "statuspage" ? deriveStatuspageRssUrl(service.pageUrl) : undefined);
  // Special-case: Auth0 supports domain-specific RSS: https://status.auth0.com/rss?domain={YOUR_AUTH0_DOMAIN}
  if (!rssUrl && service.id === "auth0") {
    const domain = process.env.AUTH0_RSS_DOMAIN || process.env.AUTH0_DOMAIN;
    if (domain) {
      rssUrl = `https://status.auth0.com/rss?domain=${encodeURIComponent(domain)}`;
    }
  }
  if (!rssUrl) {
    // No RSS configured
    return {
      description: "No RSS",
      id: service.id,
      incidents: [],
      lastChecked: new Date(),
      name: service.name,
      pageUrl: service.pageUrl,
      status: "unknown",
    };
  }

  try {
    const res = await fetchWithTimeout(rssUrl);
    if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);
    const xml = await res.text();

    const parser = new XMLParser({ attributeNamePrefix: "@_", ignoreAttributes: false });
    const parsed = parser.parse(xml);

    // Type guards for Atom vs RSS
    type AtomShape = { feed?: { title?: string; entry?: unknown | unknown[] } };
    type RssShape = { rss?: { channel?: { title?: string; item?: unknown | unknown[] } } };

    const isAtom = (u: unknown): u is AtomShape =>
      !!u && typeof u === "object" && "feed" in u && typeof (u as AtomShape).feed === "object";

    const isRss = (u: unknown): u is RssShape =>
      !!u && typeof u === "object" && "rss" in u && typeof (u as RssShape).rss === "object";

    // Normalize entries
    const entries: FeedEntry[] = [];
    let feedTitle = "";
    if (isAtom(parsed)) {
      const feedObj = parsed.feed as { title?: string; entry?: unknown | unknown[] };
      feedTitle = (feedObj.title || "").toString();
      const atomEntries = Array.isArray(feedObj.entry) ? feedObj.entry : feedObj.entry ? [feedObj.entry] : [];
      for (const e of atomEntries) entries.push(e as FeedEntry);
    } else if (isRss(parsed)) {
      const { channel } = parsed.rss as { channel?: { title?: string; item?: unknown | unknown[] } };
      if (channel) {
        feedTitle = (channel.title || "").toString();
        const items = Array.isArray(channel.item) ? channel.item : channel.item ? [channel.item] : [];
        for (const i of items) entries.push(i as FeedEntry);
      }
    }

    // Build incident info from recent entries
    const now = Date.now();
    const updates: IncidentUpdateInfo[] = [];
    let topStatus: StatusLevel = "operational";
    let incidentName = entries[0]?.title || feedTitle || service.name;
    let shortlink: string | undefined;

    let maintenanceInProgress = false;
    let latestResolutionMs = -1;
    let latestNonOperationalMs = -1;
    for (const e of entries.slice(0, 20)) {
      const tsStr = (e.updated || e.published || e.pubDate || "").toString();
      const ts = tsStr ? Date.parse(tsStr) : NaN;
      const title = (e.title || "").toString();
      const bodyRaw = typeof e.summary === "string" ? e.summary : typeof e.content === "string" ? e.content : "";
      const body = (bodyRaw || title).toString();
      let link: string | undefined;
      if (typeof e.link === "string") {
        link = e.link;
      } else if (Array.isArray(e.link)) {
        const first = e.link[0] as Record<string, unknown> | undefined;
        const href = first && typeof first["@_href"] === "string" ? (first["@_href"] as string) : undefined;
        link = href;
      } else if (e.link && typeof e.link === "object") {
        const obj = e.link as Record<string, unknown>;
        link = typeof obj["@_href"] === "string" ? (obj["@_href"] as string) : undefined;
      }

      if (!Number.isNaN(ts) && now - ts <= 1000 * 60 * 60 * 24 * 3) {
        // consider last 3 days
        updates.push({ body, created_at: new Date(ts).toISOString() });
        const combined = `${title} ${body}`;
        if (isResolutionText(combined)) {
          latestResolutionMs = Math.max(latestResolutionMs, ts);
          continue;
        }
        const st = inferStatusFromText(combined);
        if (st !== "operational") {
          latestNonOperationalMs = Math.max(latestNonOperationalMs, ts);
          // pick the worst
          const rank: Record<StatusLevel, number> = {
            degraded_performance: 2,
            major_outage: 4,
            operational: 0,
            partial_outage: 3,
            under_maintenance: 1,
            unknown: 5,
          };
          if (rank[st] > rank[topStatus]) topStatus = st;
          if (!shortlink && link) shortlink = String(link);
          if (!incidentName && title) incidentName = title;
          if (st === "under_maintenance" && /(in progress|ongoing)/i.test(combined)) {
            maintenanceInProgress = true;
          }
        }
      }
    }

    // If a resolution is more recent than any non-operational update, treat as operational
    if (latestNonOperationalMs !== -1 && latestResolutionMs >= latestNonOperationalMs) {
      topStatus = "operational";
      maintenanceInProgress = false;
    }

    const incidents: IncidentInfo[] =
      updates.length > 0 && topStatus !== "operational" && (topStatus !== "under_maintenance" || maintenanceInProgress)
        ? [
            {
              created_at: updates[0].created_at,
              id: `${service.id}-rss-incident`,
              impact: topStatus,
              incident_updates: updates,
              name: incidentName,
              shortlink,
              status: topStatus,
            },
          ]
        : [];

    return {
      description:
        incidents.length > 0
          ? topStatus === "under_maintenance" && maintenanceInProgress
            ? "Maintenance in progress"
            : incidentName
          : "",
      id: service.id,
      incidents,
      lastChecked: new Date(),
      name: service.name,
      pageUrl: service.pageUrl,
      status: incidents.length > 0 ? topStatus : "operational",
    };
  } catch (e) {
    return {
      description: "Unreachable",
      id: service.id,
      incidents: [],
      lastChecked: new Date(),
      name: service.name,
      pageUrl: service.pageUrl,
      status: "unknown",
    };
  }
}

function escalateStatus(a: StatusLevel, b: StatusLevel): StatusLevel {
  const rank: Record<StatusLevel, number> = {
    degraded_performance: 2,
    major_outage: 4,
    operational: 0,
    partial_outage: 3,
    under_maintenance: 1,
    // Treat unknown as the lowest severity so it never overrides a known non-operational status
    unknown: -1,
  };
  return rank[b] > rank[a] ? b : a;
}

function extractSpanById(html: string, id: string): { text: string | null; openTag: string | null } {
  const re = new RegExp(`<span[^>]*id=["']${id}["'][^>]*>(.*?)</span>`, "is");
  const m = html.match(re);
  if (!m) return { openTag: null, text: null };
  const openTagMatch = m[0].match(/<span[^>]*>/i);
  const openTag = openTagMatch ? openTagMatch[0] : null;
  // Strip HTML tags inside text if any
  const raw = m[1] ?? "";
  const text = raw.replace(/<[^>]*>/g, "").trim();
  return { openTag, text };
}

function classifySteamTextStatus(text: string): StatusLevel {
  const t = text.toLowerCase();
  if (/full load|0\.0%/.test(t)) return "major_outage";
  if (/high load/.test(t)) return "partial_outage";
  if (/medium load/.test(t)) return "degraded_performance";
  if (/normal|ok|online/.test(t)) return "operational";
  return "unknown";
}

async function fetchSteamStatus(service: ServiceConfig): Promise<ServiceStatus> {
  try {
    const res = await fetchWithTimeout(service.pageUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    const idsToCheck = [
      "store",
      "community",
      "webapi",
      "cms",
      "online",
      "ingame",
      "cs2",
      "dota2",
      "tf2",
      "pageviews",
    ] as const;

    let overall: StatusLevel = "operational";
    const parts: string[] = [];
    const offlineComponents: string[] = [];

    for (const id of idsToCheck) {
      const { text } = extractSpanById(html, id);
      if (text) {
        // Summarize nicely
        switch (id) {
          case "online":
            parts.push(`Online: ${text}`);
            break;
          case "ingame":
            parts.push(`In-Game: ${text}`);
            break;
          case "cms":
            parts.push(`CMs: ${text}`);
            overall = escalateStatus(overall, classifySteamTextStatus(text));
            break;
          case "store":
            parts.push(`Store: ${text}`);
            overall = escalateStatus(overall, classifySteamTextStatus(text));
            if (/offline/i.test(text)) offlineComponents.push(`Store: ${text}`);
            break;
          case "community":
            parts.push(`Community: ${text}`);
            overall = escalateStatus(overall, classifySteamTextStatus(text));
            if (/offline/i.test(text)) offlineComponents.push(`Community: ${text}`);
            break;
          case "webapi":
            parts.push(`Web API: ${text}`);
            overall = escalateStatus(overall, classifySteamTextStatus(text));
            if (/offline/i.test(text)) offlineComponents.push(`Web API: ${text}`);
            break;
          case "cs2":
            parts.push(`CS2: ${text}`);
            overall = escalateStatus(overall, classifySteamTextStatus(text));
            if (/offline/i.test(text)) offlineComponents.push(`CS2: ${text}`);
            break;
          case "dota2":
            parts.push(`Dota2: ${text}`);
            overall = escalateStatus(overall, classifySteamTextStatus(text));
            if (/offline/i.test(text)) offlineComponents.push(`Dota2: ${text}`);
            break;
          case "tf2":
            parts.push(`TF2: ${text}`);
            overall = escalateStatus(overall, classifySteamTextStatus(text));
            if (/offline/i.test(text)) offlineComponents.push(`TF2: ${text}`);
            break;
          case "pageviews":
            parts.push(`Page Views: ${text}`);
            break;
        }
      }
    }

    // PSA
    const psaMatch = html.match(/<div\s+id=["']psa["'][^>]*>(.*?)<\/div>/is);
    let incidents: IncidentInfo[] = [];
    if (psaMatch) {
      const psaText = psaMatch[1].replace(/<[^>]*>/g, "").trim();
      if (psaText && !/Loading…/i.test(psaText)) {
        incidents = [
          {
            created_at: new Date().toISOString(),
            id: `${service.id}-psa`,
            impact: "partial_outage",
            incident_updates: [{ body: psaText, created_at: new Date().toISOString() }],
            name: "Steam PSA",
            shortlink: service.pageUrl,
            status: "partial_outage",
          },
        ];
        overall = escalateStatus(overall, "partial_outage");
      }
    }

    // If any core component is Offline, mark as major outage and create an incident with details
    if (offlineComponents.length > 0) {
      overall = "major_outage";
      const nowIso = new Date().toISOString();
      const updateLines = offlineComponents.map((c) => ({ body: c, created_at: nowIso }));
      incidents.unshift({
        created_at: nowIso,
        id: `${service.id}-offline`,
        impact: "major_outage",
        incident_updates: updateLines,
        name: "Steam Outage",
        shortlink: service.pageUrl,
        status: "major_outage",
      });
    }

    // If we discovered incidents but overall is still operational/unknown, escalate based on incident impacts
    if (incidents.length > 0 && (overall === "operational" || overall === "unknown")) {
      const mapImpact = (imp?: string): StatusLevel => {
        const s = (imp || "").toLowerCase();
        if (s === "critical") return "major_outage";
        if (s === "major") return "partial_outage";
        if (s === "minor") return "degraded_performance";
        return "degraded_performance"; // default to degraded when incident exists without clear impact
      };
      let worst: StatusLevel = "operational";
      for (const inc of incidents) worst = escalateStatus(worst, mapImpact(inc.impact));
      overall = escalateStatus(overall, worst);
    }

    // Keep concise; only append text for noteworthy states
    const description = overall === "operational" ? "" : overall === "major_outage" ? "Major Outage" : parts.join("; ");
    return {
      description: description || "Parsed Steam status",
      id: service.id,
      incidents,
      lastChecked: new Date(),
      name: service.name,
      pageUrl: service.pageUrl,
      status: overall,
    };
  } catch (e) {
    return {
      description: "Unreachable",
      id: service.id,
      incidents: [],
      lastChecked: new Date(),
      name: service.name,
      pageUrl: service.pageUrl,
      status: "major_outage",
    };
  }
}

function mapAuth0ImpactToStatus(impact?: string, status?: string): StatusLevel {
  const imp = (impact || "").toLowerCase();
  const st = (status || "").toLowerCase();
  if (st === "scheduled" || st === "in_progress" || imp === "maintenance") return "under_maintenance";
  if (imp === "critical") return "major_outage";
  if (imp === "major") return "partial_outage";
  if (imp === "minor") return "degraded_performance";
  if (st === "operational" || imp === "none") return "operational";
  return "unknown";
}

type Auth0Incident = {
  id?: string;
  name?: string;
  impact?: string;
  status?: string;
  updated_at?: string;
  scheduled_for?: string;
  monitoring_at?: string;
};

type Auth0ActiveIncidentRegion = {
  region?: string;
  response?: { incidents?: Auth0Incident[] };
};

type Auth0NextData = {
  props?: { pageProps?: { activeIncidents?: Auth0ActiveIncidentRegion[] } };
};

async function fetchAuth0Status(service: ServiceConfig): Promise<ServiceStatus> {
  try {
    const res = await fetchWithTimeout(service.pageUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    // Extract Next.js data payload
    const nextDataMatch = html.match(/<script\s+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
    if (!nextDataMatch) {
      // Fallback: try generic
      return await fetchGeneric(service);
    }
    const jsonStr = nextDataMatch[1];
    let data: Auth0NextData | undefined;
    try {
      data = JSON.parse(jsonStr);
    } catch {
      return await fetchGeneric(service);
    }

    const pageProps = data?.props?.pageProps || {};
    const activeIncidents: Auth0ActiveIncidentRegion[] = Array.isArray(pageProps.activeIncidents)
      ? (pageProps.activeIncidents as Auth0ActiveIncidentRegion[])
      : [];

    let overall: StatusLevel = "operational";
    const incidents: IncidentInfo[] = [];
    const nonOperationalRegions: string[] = [];

    for (const regionEntry of activeIncidents) {
      const region = regionEntry?.region || "";
      const list: Auth0Incident[] = Array.isArray(regionEntry?.response?.incidents)
        ? (regionEntry.response?.incidents as Auth0Incident[])
        : [];

      for (const inc of list) {
        // Start with Auth0-provided impact/status mapping
        let incStatus = mapAuth0ImpactToStatus(inc?.impact, inc?.status);
        const rawStatus = (inc?.status || "").toString();
        const nameText = (inc?.name || "").toString();
        const isMaintenanceByText = /mainten|upgrade|patch/i.test(nameText);
        const isMaintenanceBySchedule = !!inc?.scheduled_for;
        // If the incident text or presence of a schedule indicates maintenance, override to maintenance
        if (incStatus !== "under_maintenance" && (isMaintenanceByText || isMaintenanceBySchedule)) {
          incStatus = "under_maintenance";
        }
        // Skip clear operational placeholders
        const name = (inc?.name || "").toString();
        const isAllOps = /all\s+systems\s+operational/i.test(name) || incStatus === "operational";
        if (isAllOps) continue;

        overall = escalateStatus(overall, incStatus);
        nonOperationalRegions.push(region);

        // Build a concise incident with minimal but useful details
        const updates: IncidentUpdateInfo[] = [];
        // Prefer scheduled time if present
        if (inc?.scheduled_for) {
          const when = new Date(inc.scheduled_for).toISOString();
          updates.push({ body: `Scheduled for ${when} (${region})`, created_at: when });
        }
        if (inc?.monitoring_at) {
          const when = new Date(inc.monitoring_at).toISOString();
          updates.push({ body: `Monitoring (${region})`, created_at: when });
        }
        if (inc?.updated_at) {
          const when = new Date(inc.updated_at).toISOString();
          if (!updates.find((u) => u.created_at === when))
            updates.push({ body: `Updated ${when} (${region})`, created_at: when });
        }

        incidents.push({
          created_at: (inc?.updated_at || inc?.scheduled_for || new Date().toISOString()).toString(),
          id: inc?.id || `${service.id}-${region}-incident`,
          impact: incStatus,
          incident_updates: updates,
          name: name || `${service.name} – ${region}`,
          shortlink: service.pageUrl,
          // Preserve the raw status from Auth0 (e.g., scheduled, in_progress) for downstream logic
          status: rawStatus,
        });
      }
    }

    // Ensure maintenance is portrayed as such: if any incident is maintenance-like, keep overall as maintenance
    const hasMaintenance =
      overall === "under_maintenance" ||
      incidents.some((i) => i.impact === "under_maintenance" || /mainten|upgrade|patch/i.test(i.name || ""));
    if (hasMaintenance) {
      overall = "under_maintenance";
    }
    // Concise description only for notable outages
    let description = "";
    if (overall === "major_outage") description = "Major Outage";
    else if (overall === "partial_outage") description = "Partial Outage";
    else if (overall === "degraded_performance") description = "Degraded Performance";
    else if (overall === "under_maintenance") description = "Maintenance in progress";

    return {
      description,
      id: service.id,
      incidents,
      lastChecked: new Date(),
      name: service.name,
      pageUrl: service.pageUrl,
      status: overall,
    };
  } catch (e) {
    return {
      description: "Unreachable",
      id: service.id,
      incidents: [],
      lastChecked: new Date(),
      name: service.name,
      pageUrl: service.pageUrl,
      status: "major_outage",
    };
  }
}

// -----------------------------
// Apple status (Support and Developer)
// -----------------------------

type AppleEvent = {
  title?: string;
  message?: string;
  status?: string;
  statusType?: string;
  eventType?: string;
  startDate?: string | number;
  endDate?: string | number;
  isOngoing?: boolean;
  resolved?: boolean;
};

function toDateMs(v: unknown): number {
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  if (typeof v === "string" && v.trim()) {
    const ms = Date.parse(v);
    if (!Number.isNaN(ms)) return ms;
  }
  return NaN;
}

function classifyAppleEventStatus(e: AppleEvent): StatusLevel {
  const t = `${e.status || e.statusType || e.eventType || ""}`.toLowerCase();
  const titleMsg = `${e.title || ""} ${e.message || ""}`.toLowerCase();
  if (/maintenance|planned maintenance|scheduled maintenance/.test(t) || /maintenance/.test(titleMsg)) {
    return "under_maintenance";
  }
  if (/outage|unavailable|major/.test(t) || /outage|unavailable/.test(titleMsg)) return "major_outage";
  if (/issue|degrad/.test(t) || /issue|degrad/.test(titleMsg)) return "degraded_performance";
  return "operational";
}

function isAppleEventActiveNow(e: AppleEvent, now = Date.now()): boolean {
  // Resolved flags
  const statusStr = `${e.status || e.statusType || ""}`.toLowerCase();
  if (e.resolved || /resolved/.test(statusStr)) return false;

  const primaryStart: unknown =
    (e as Record<string, unknown>).startDate ||
    (e as Record<string, unknown>)["begin"] ||
    (e as Record<string, unknown>)["started"] ||
    (e as Record<string, unknown>)["date"] ||
    (e as Record<string, unknown>)["createdAt"];
  const primaryEnd: unknown =
    (e as Record<string, unknown>).endDate ||
    (e as Record<string, unknown>)["until"] ||
    (e as Record<string, unknown>)["ended"] ||
    (e as Record<string, unknown>)["completedAt"];
  const start = toDateMs(primaryStart);
  const end = toDateMs(primaryEnd);

  // If explicit ongoing flag present
  if (typeof e.isOngoing === "boolean") return e.isOngoing;

  // Maintenance: require within window
  const level = classifyAppleEventStatus(e);
  if (level === "under_maintenance") {
    if (!Number.isNaN(start) && !Number.isNaN(end)) return now >= start && now <= end;
    if (!Number.isNaN(start) && Number.isNaN(end)) return now >= start; // started, no end yet
    return false; // don't surface future maintenance as active
  }
  // Issues/Outages: active when no end specified or end in future
  if (!Number.isNaN(end)) return now <= end;
  return true; // treat as active when no end present
}

function collectAppleEvents(obj: unknown, bucket: AppleEvent[] = []): AppleEvent[] {
  if (Array.isArray(obj)) {
    for (const it of obj) collectAppleEvents(it, bucket);
    return bucket;
  }
  if (obj && typeof obj === "object") {
    const o = obj as Record<string, unknown>;
    // Heuristic: looks like an event
    const maybeEvent =
      typeof o === "object" &&
      ("status" in o || "statusType" in o || "eventType" in o) &&
      ("title" in o || "message" in o || "startDate" in o || "endDate" in o);
    if (maybeEvent) {
      const endDate = (o.endDate ?? o["end"] ?? o["until"]) as string | number | undefined;
      const eventType = (o.eventType ?? o["type"]) as string | undefined;
      const isOngoing = (o.isOngoing ?? (o["ongoing"] as unknown)) as boolean | undefined;
      const message = (o.message ?? o["notes"] ?? o["summary"]) as string | undefined;
      const resolved = (o.resolved as boolean | undefined) ?? /resolved/i.test(String(o.status || o.statusType || ""));
      const startDate = (o.startDate ?? o["start"]) as string | number | undefined;
      const status = o.status as string | undefined;
      const statusType = o.statusType as string | undefined;
      const title = (o.title ?? o["name"]) as string | undefined;
      bucket.push({ endDate, eventType, isOngoing, message, resolved, startDate, status, statusType, title });
    }
    for (const v of Object.values(o)) collectAppleEvents(v, bucket);
  }
  return bucket;
}

async function fetchAppleSupportStatus(service: ServiceConfig): Promise<ServiceStatus> {
  // Try JSON endpoints in order
  const urls = [
    "https://www.apple.com/support/systemstatus/data/system_status_en_US.json",
    "https://www.apple.com/support/systemstatus/data/system_status_en_US.js",
  ];
  const now = Date.now();
  for (const url of urls) {
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) continue;
      const txt = await res.text();
      let data: unknown;
      try {
        // If JS assigns to a variable, strip prefix/suffix to leave JSON
        const jsonStart = txt.indexOf("{");
        const jsonEnd = txt.lastIndexOf("}");
        const maybe = jsonStart >= 0 && jsonEnd > jsonStart ? txt.slice(jsonStart, jsonEnd + 1) : txt;
        data = JSON.parse(maybe);
      } catch {
        continue;
      }
      const events = collectAppleEvents(data).filter((e) => isAppleEventActiveNow(e, now));
      let overall: StatusLevel = "operational";
      const updates: IncidentUpdateInfo[] = [];
      for (const e of events) {
        const st = classifyAppleEventStatus(e);
        overall = escalateStatus(overall, st);
        const when = toDateMs(e.startDate);
        const created_at = Number.isNaN(when) ? new Date().toISOString() : new Date(when).toISOString();
        const body = `${e.title || "Apple Service"}: ${e.message || e.status || e.statusType || "Issue"}`;
        updates.push({ body, created_at });
      }

      const incidents: IncidentInfo[] =
        updates.length && overall !== "operational"
          ? [
              {
                created_at: updates[updates.length - 1].created_at,
                id: `${service.id}-incident`,
                impact: overall,
                incident_updates: updates.sort((a, b) => (a.created_at > b.created_at ? -1 : 1)),
                name: overall === "under_maintenance" ? "Maintenance in progress" : "Apple Services Incident",
                shortlink: service.pageUrl,
                status: overall,
              },
            ]
          : [];

      return {
        description:
          overall === "under_maintenance" && incidents.length
            ? "Maintenance in progress"
            : incidents.length
              ? "Issues detected"
              : "",
        id: service.id,
        incidents,
        lastChecked: new Date(),
        name: service.name,
        pageUrl: service.pageUrl,
        status: incidents.length ? overall : "operational",
      };
    } catch {
      // try next
    }
  }
  // Fallback to reachability
  return await fetchGeneric(service);
}

async function fetchAppleDeveloperStatus(service: ServiceConfig): Promise<ServiceStatus> {
  try {
    const res = await fetchWithTimeout("https://developer.apple.com/system-status/data/system-statuses.json");
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    const now = Date.now();
    const events = collectAppleEvents(data).filter((e) => isAppleEventActiveNow(e, now));
    let overall: StatusLevel = "operational";
    const updates: IncidentUpdateInfo[] = [];
    for (const e of events) {
      const st = classifyAppleEventStatus(e);
      overall = escalateStatus(overall, st);
      const when = toDateMs(e.startDate);
      const created_at = Number.isNaN(when) ? new Date().toISOString() : new Date(when).toISOString();
      const body = `${e.title || "Apple Developer"}: ${e.message || e.status || e.statusType || "Issue"}`;
      updates.push({ body, created_at });
    }
    const incidents: IncidentInfo[] =
      updates.length && overall !== "operational"
        ? [
            {
              created_at: updates[updates.length - 1].created_at,
              id: `${service.id}-incident`,
              impact: overall,
              incident_updates: updates.sort((a, b) => (a.created_at > b.created_at ? -1 : 1)),
              name: overall === "under_maintenance" ? "Maintenance in progress" : "Apple Developer Incident",
              shortlink: service.pageUrl,
              status: overall,
            },
          ]
        : [];
    return {
      description:
        overall === "under_maintenance" && incidents.length
          ? "Maintenance in progress"
          : incidents.length
            ? "Issues detected"
            : "",
      id: service.id,
      incidents,
      lastChecked: new Date(),
      name: service.name,
      pageUrl: service.pageUrl,
      status: incidents.length ? overall : "operational",
    };
  } catch {
    return await fetchGeneric(service);
  }
}

async function checkService(service: ServiceConfig): Promise<ServiceStatus> {
  if (service.id === "steam") {
    return await fetchSteamStatus(service);
  }
  if (service.id === "auth0") {
    return await fetchAuth0Status(service);
  }
  if (service.id === "apple") {
    return await fetchAppleSupportStatus(service);
  }
  if (service.id === "appledev") {
    return await fetchAppleDeveloperStatus(service);
  }
  // Strategy adjustment:
  // For Statuspage-backed services, the JSON summary is most accurate for "current" state.
  if (service.type === "statuspage") {
    const sp = await fetchStatuspage(service);
    const spUnreachable = sp.status === "unknown" && sp.description === "Unreachable";
    if (!spUnreachable) {
      // If non-operational and RSS is available, consult RSS for richer details or more severe state
      const hasRss = !!service.rssUrl || (service.rssUrls && service.rssUrls.length > 0);
      if (hasRss && sp.status !== "operational" && sp.status !== "unknown") {
        try {
          const rss = await fetchRSS(service);
          const rank: Record<StatusLevel, number> = {
            degraded_performance: 2,
            major_outage: 4,
            operational: 0,
            partial_outage: 3,
            under_maintenance: 1,
            unknown: 5,
          };
          const rssBetter = rank[rss.status] > rank[sp.status] || (sp.incidents?.length ?? 0) === 0;
          return rssBetter ? rss : sp;
        } catch {
          return sp;
        }
      }
      return sp;
    }
    // If statuspage summary unreachable, fall back to RSS, then generic
    if (service.rssUrl || (service.rssUrls && service.rssUrls.length)) {
      const rss = await fetchRSS(service);
      if (rss.status !== "unknown") {
        return rss;
      }
    }
    return await fetchGeneric(service);
  }

  // For generic services, prefer RSS if provided; else simple reachability
  if (service.rssUrl || (service.rssUrls && service.rssUrls.length)) {
    const rss = await fetchRSS(service);
    if (rss.status !== "unknown") {
      return rss;
    }
  }
  return await fetchGeneric(service);
}

// Public single-service checker for staggered polling
export async function checkSingleService(service: ServiceConfig): Promise<ServiceStatus> {
  return await checkService(service);
}

export const Categories: CategoryConfig[] = [
  {
    name: "Cloud Platforms",
    services: [
      // Aggregate/root AWS row (what you see in Discord)
      {
        id: "aws",
        isGroupRoot: true,
        name: "AWS",
        pageUrl: "https://health.aws.amazon.com/health/status",
        type: "generic",
      },
      // AWS child services: each RSS feed is its own independently scheduled service
      ...buildAwsChildServices(),
      {
        id: "gcp",
        name: "Google Cloud",
        pageUrl: "https://status.cloud.google.com/",
        rssUrl: "https://status.cloud.google.com/en/feed.atom",
        type: "generic",
      },
      {
        id: "azure",
        name: "Microsoft Azure",
        pageUrl: "https://status.azure.com/",
        rssUrl: "https://rssfeed.azure.status.microsoft/en-us/status/feed/",
        type: "generic",
      },
      {
        id: "ibm",
        name: "IBM Cloud",
        pageUrl: "https://cloud.ibm.com/status",
        rssUrl: "https://cloud.ibm.com/status/api/notifications/feed.rss",
        type: "generic",
      },
      {
        id: "oracle",
        name: "Oracle Cloud",
        pageUrl: "https://ocistatus.oraclecloud.com/",
        rssUrl: "https://ocistatus.oraclecloud.com/api/v2/incident-summary.rss",
        type: "generic",
      },
      {
        id: "linode",
        name: "Linode",
        pageUrl: "https://status.linode.com/",
        rssUrl: "https://status.linode.com/history.rss",
        type: "statuspage",
      },
      {
        id: "atlassian",
        name: "Atlassian (Jira/Confluence)",
        pageUrl: "https://status.atlassian.com/",
        rssUrl: "https://status.atlassian.com/history.atom",
        type: "statuspage",
      },
    ],
  },
  {
    name: "Communication & Identity APIs",
    services: [
      {
        id: "twilio",
        name: "Twilio",
        pageUrl: "https://status.twilio.com/",
        rssUrl: "https://status.twilio.com/history.rss",
        type: "statuspage",
      },
      {
        id: "sendgrid",
        name: "SendGrid",
        pageUrl: "https://status.sendgrid.com/",
        rssUrl: "https://status.sendgrid.com/history.rss",
        type: "statuspage",
      },
      {
        id: "mailgun",
        name: "Mailgun",
        pageUrl: "https://status.mailgun.com/",
        rssUrl: "https://status.mailgun.com/history.rss",
        type: "statuspage",
      },
      {
        id: "auth0",
        name: "Auth0",
        pageUrl: "https://status.auth0.com/",
        type: "generic",
      },
      {
        id: "okta",
        name: "Okta",
        pageUrl: "https://status.okta.com/",
        rssUrl: "https://feeds.feedburner.com/OktaStatusRSS",
        type: "statuspage",
      },
      {
        id: "zoom",
        name: "Zoom",
        pageUrl: "https://www.zoomstatus.com/",
        rssUrl: "https://www.zoomstatus.com/history.rss",
        type: "statuspage",
      },
      {
        id: "auth0fga",
        name: "Auth0 FGA",
        pageUrl: "https://status.fga.dev/",
        rssUrl: "https://status.fga.dev/history.rss",
        type: "statuspage",
      },
    ],
  },
  {
    name: "Hosting & DNS / CDN",
    services: [
      {
        id: "cloudflare",
        name: "Cloudflare",
        pageUrl: "https://www.cloudflarestatus.com/",
        rssUrl: "https://www.cloudflarestatus.com/history.atom",
        type: "statuspage",
      },
      {
        id: "fastly",
        name: "Fastly",
        pageUrl: "https://www.fastlystatus.com/",
        rssUrl: "https://www.fastlystatus.com/rss",
        type: "statuspage",
      },
      {
        id: "akamai",
        name: "Akamai",
        pageUrl: "https://www.akamaistatus.com/",
        rssUrl: "https://www.akamaistatus.com/history.rss",
        type: "statuspage",
      },
      {
        id: "netlify",
        name: "Netlify",
        pageUrl: "https://www.netlifystatus.com/",
        rssUrl: "https://www.netlifystatus.com/history.rss",
        type: "statuspage",
      },
    ],
  },
  {
    name: "Payment & Financial APIs",
    services: [
      {
        id: "stripe",
        name: "Stripe",
        pageUrl: "https://status.stripe.com/",
        rssUrl: "https://www.stripestatus.com/history.rss",
        type: "generic",
      },
      {
        id: "paypal",
        name: "PayPal",
        pageUrl: "https://www.paypal-status.com/product/production",
        rssUrl: "https://www.paypal-status.com/feed/rss",
        type: "statuspage",
      },
      {
        id: "square",
        name: "Square",
        pageUrl: "https://www.issquareup.com/",
        rssUrl: "https://www.issquareup.com/united-states/feed.rss",
        type: "statuspage",
      },
      {
        id: "shopify",
        name: "Shopify",
        pageUrl: "https://shopstatus.shopifyapps.com/",
        type: "generic",
      },
      {
        id: "plaid",
        name: "Plaid",
        pageUrl: "https://status.plaid.com/",
        rssUrl: "https://status.plaid.com/history.rss",
        type: "statuspage",
      },
      {
        id: "coinbase",
        name: "Coinbase",
        pageUrl: "http://status.coinbase.com/",
        rssUrl: "http://status.coinbase.com/history.rss",
        type: "statuspage",
      },
    ],
  },
  {
    name: "Developer Tools / CI & CD",
    services: [
      {
        id: "github",
        name: "GitHub",
        pageUrl: "https://www.githubstatus.com/",
        rssUrl: "https://www.githubstatus.com/history.rss",
        type: "statuspage",
      },
      {
        id: "gitlab",
        name: "GitLab",
        pageUrl: "https://status.gitlab.com/",
        rssUrl: "https://status.gitlab.com/pages/5b36dc6502d06804c08349f7/rss",
        type: "statuspage",
      },
      {
        id: "bitbucket",
        name: "Bitbucket",
        pageUrl: "https://bitbucket.status.atlassian.com/",
        rssUrl: "https://bitbucket.status.atlassian.com/history.rss",
        type: "statuspage",
      },
      {
        id: "circleci",
        name: "CircleCI",
        pageUrl: "https://status.circleci.com/",
        rssUrl: "https://status.circleci.com/history.rss",
        type: "statuspage",
      },
      {
        id: "travis",
        name: "Travis CI",
        pageUrl: "https://www.traviscistatus.com/",
        rssUrl: "https://www.traviscistatus.com/history.rss",
        type: "statuspage",
      },
      {
        id: "docker",
        name: "Docker",
        pageUrl: "https://www.dockerstatus.com/",
        rssUrl: "https://www.dockerstatus.com/pages/533c6539221ae15e3f000031/rss",
        type: "statuspage",
      },
      {
        id: "hpanyware",
        name: "HP Anyware",
        pageUrl: "https://status.hpanyware.com/",
        rssUrl: "https://status.hpanyware.com/history.rss",
        type: "statuspage",
      },
      {
        id: "dropbox",
        name: "Dropbox",
        pageUrl: "https://status.dropbox.com/",
        rssUrl: "https://status.dropbox.com/history.rss",
        type: "statuspage",
      },
      {
        id: "statusio",
        name: "Status.io",
        pageUrl: "https://status.status.io/",
        rssUrl: "https://status.status.io/pages/51f6f2088643809b7200000d/rss",
        type: "generic",
      },
      {
        apiUrl: "https://status.openai.com/api/v2/summary.json",
        id: "openai",
        name: "OpenAI",
        pageUrl: "https://status.openai.com/",
        rssUrl: "https://status.openai.com/feed.rss",
        type: "statuspage",
      },
      {
        id: "anthropic",
        name: "Anthropic (Claude)",
        pageUrl: "https://status.claude.com/",
        rssUrl: "https://status.claude.com/history.rss",
        type: "statuspage",
      },
    ],
  },
  {
    name: "Monitoring / Logging / Database Services",
    services: [
      {
        id: "datadog",
        name: "Datadog",
        pageUrl: "https://status.datadoghq.com/",
        rssUrl: "https://status.datadoghq.com/history.rss",
        type: "statuspage",
      },
      {
        id: "newrelic",
        name: "New Relic",
        pageUrl: "https://status.newrelic.com/",
        rssUrl: "https://status.newrelic.com/history.rss",
        type: "statuspage",
      },
      {
        id: "sentry",
        name: "Sentry",
        pageUrl: "https://status.sentry.io/",
        rssUrl: "https://status.sentry.io/history.rss",
        type: "statuspage",
      },
      {
        id: "mongodb",
        name: "MongoDB Atlas",
        pageUrl: "https://status.mongodb.com/",
        rssUrl: "https://status.mongodb.com/history.rss",
        type: "statuspage",
      },
      {
        id: "ibmsecurity",
        name: "IBM Security",
        pageUrl: "https://statuspage.ibmcloudsecurity.com/",
        rssUrl: "https://statuspage.ibmcloudsecurity.com/history.rss",
        type: "statuspage",
      },
      {
        id: "firebase",
        name: "Firebase",
        pageUrl: "https://status.firebase.google.com/",
        rssUrl: "https://status.firebase.google.com/en/feed.atom",
        type: "generic",
      },
      {
        id: "elastic",
        name: "Elastic Cloud",
        pageUrl: "https://status.elastic.co/",
        rssUrl: "https://status.elastic.co/history.rss",
        type: "statuspage",
      },
    ],
  },
  {
    name: "Messaging / Social Platforms",
    services: [
      {
        id: "slack",
        name: "Slack",
        pageUrl: "https://slack-status.com/",
        rssUrl: "https://slack-status.com/feed/rss",
        type: "generic",
      },
      {
        apiUrl: "https://discordstatus.com/api/v2/summary.json",
        id: "discord",
        name: "Discord",
        pageUrl: "https://discordstatus.com/",
        rssUrl: "https://status.discord.com/history.rss",
        type: "statuspage",
      },
      {
        id: "spotify",
        name: "Spotify",
        pageUrl: "https://spotify.statuspage.io/",
        rssUrl: "https://spotify.statuspage.io/history.rss",
        type: "statuspage",
      },
      {
        id: "canva",
        name: "Canva",
        pageUrl: "https://www.canvastatus.com/",
        rssUrl: "https://www.canvastatus.com/history.rss",
        type: "statuspage",
      },
      {
        id: "reddit",
        name: "Reddit",
        pageUrl: "https://www.redditstatus.com/",
        rssUrl: "https://www.redditstatus.com/history.rss",
        type: "statuspage",
      },
      {
        id: "samsungiot",
        name: "Samsung SmartThings",
        pageUrl: "https://status.smartthings.com/",
        rssUrl: "https://status.smartthings.com/history.rss",
        type: "statuspage",
      },
      {
        id: "googleworkspace",
        name: "Google Workspace",
        pageUrl: "https://www.google.com/appsstatus/dashboard/",
        rssUrl: "https://www.google.com/appsstatus/dashboard/en/feed.atom",
        type: "generic",
      },
      {
        id: "googleplay",
        name: "Google Play",
        pageUrl: "https://status.play.google.com/",
        rssUrl: "https://status.play.google.com/en/feed.atom",
        type: "generic",
      },
      {
        id: "googlesearch",
        name: "Google Search",
        pageUrl: "https://status.search.google.com/",
        rssUrl: "https://status.search.google.com/en/feed.atom",
        type: "generic",
      },
      {
        id: "googlegaistudio",
        name: "Google AI Studio & Gemini",
        pageUrl: "https://aistudio.google.com/status",
        type: "generic",
      },
      { id: "steam", name: "Steam", pageUrl: "https://steamstat.us/", type: "generic" },
      { id: "twitter", name: "Twitter (X) API", pageUrl: "https://docs.x.com/status", type: "generic" },
      {
        id: "facebook",
        name: "Meta (Facebook/Instagram/WhatsApp)",
        pageUrl: "https://metastatus.com/",
        rssUrls: [
          "https://metastatus.com/outage-events-feed-ads-manager.rss",
          "https://metastatus.com/outage-events-feed-catalog.rss",
          "https://metastatus.com/outage-events-feed-ctx.rss",
          "https://metastatus.com/outage-events-feed-fb-ig-shops.rss",
          "https://metastatus.com/outage-events-feed-fbs.rss",
          "https://metastatus.com/outage-events-feed-ig-boost.rss",
          "https://metastatus.com/outage-events-feed-admin-center.rss",
          "https://metastatus.com/outage-events-feed-audience-network.rss",
          "https://metastatus.com/outage-events-feed-workplace.rss",
          "https://metastatus.com/outage-events-feed-facebook-login.rss",
          "https://metastatus.com/outage-events-feed-graph-api.rss",
          "https://metastatus.com/outage-events-feed-ig-messenger.rss",
          "https://metastatus.com/outage-events-feed-messenger.rss",
          "https://metastatus.com/outage-events-feed-whatsapp-business-api.rss",
          "https://metastatus.com/outage-events-feed-marketing-api.rss",
          "https://metastatus.com/outage-events-feed-ads-transparency.rss",
          "https://metastatus.com/outage-events-feed-data-transparency.rss",
        ],
        type: "generic",
      },
    ],
  },
  {
    name: "Apple",
    services: [
      {
        id: "apple",
        name: "Apple Services",
        pageUrl: "https://www.apple.com/support/systemstatus/",
        type: "generic",
      },
      {
        id: "appledev",
        name: "Apple Developer",
        pageUrl: "https://developer.apple.com/system-status/",
        type: "generic",
      },
    ],
  },
  {
    name: "Maps & Location",
    services: [
      {
        id: "mapbox",
        name: "Mapbox",
        pageUrl: "https://status.mapbox.com/",
        rssUrl: "https://status.mapbox.com/history.rss",
        type: "statuspage",
      },
    ],
  },
];

export async function fetchAllStatuses(): Promise<{ categories: { name: string; services: ServiceStatus[] }[] }> {
  const tasks: Array<Promise<{ name: string; services: ServiceStatus[] }>> = Categories.map(async (cat) => {
    // Run all services in the category concurrently for speed
    const services = await Promise.all(
      cat.services.map(async (svc) => {
        try {
          return await checkService(svc);
        } catch {
          // Extremely defensive fallback
          return {
            description: "Unreachable",
            id: svc.id,
            incidents: [],
            lastChecked: new Date(),
            name: svc.name,
            pageUrl: svc.pageUrl,
            status: "major_outage" as StatusLevel,
          };
        }
      })
    );
    return { name: cat.name, services };
  });

  const categories = await Promise.all(tasks);
  return { categories };
}

export function summarizeIssues(categories: { name: string; services: ServiceStatus[] }[]) {
  let issues = 0;
  let critical = 0;
  let operational = 0;

  for (const cat of categories) {
    for (const s of cat.services) {
      if (s.status === "operational") operational++;
      else if (s.status === "major_outage") {
        issues++;
        critical++;
      } else if (s.status !== "unknown") {
        issues++;
      }
    }
  }
  return { critical, issues, operational };
}
