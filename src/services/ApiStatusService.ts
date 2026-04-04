/* eslint-disable sort-keys */
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
  groupId?: string;
  isGroupRoot?: boolean;
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

export interface ApiStatusCatalogEntry {
  categoryName: string;
  service: ServiceConfig;
}

export interface ApiStatusCatalog {
  awsChildren: ApiStatusCatalogEntry[];
  awsRoot: ApiStatusCatalogEntry | null;
  displayCategories: CategoryConfig[];
  generalServices: ApiStatusCatalogEntry[];
}

const STATUS_RANK: Record<StatusLevel, number> = {
  degraded_performance: 2,
  major_outage: 4,
  operational: 0,
  partial_outage: 3,
  under_maintenance: 1,
  // Treat unknown as the lowest severity so it never overrides a known non-operational status
  unknown: -1,
};

const STATUS_RANK_UNKNOWN_HIGH: Record<StatusLevel, number> = {
  degraded_performance: 2,
  major_outage: 4,
  operational: 0,
  partial_outage: 3,
  under_maintenance: 1,
  unknown: 5,
};

const FEED_PARSER_OPTIONS = {
  attributeNamePrefix: "@_",
  ignoreAttributes: false,
  processEntities: false,
} as const;

const isWorseStatus = (candidate: StatusLevel, current: StatusLevel, rank = STATUS_RANK): boolean =>
  rank[candidate] > rank[current];

function buildStatus(service: ServiceConfig, overrides: Partial<ServiceStatus> = {}): ServiceStatus {
  return {
    id: service.id,
    groupId: service.groupId,
    isGroupRoot: service.isGroupRoot,
    name: service.name,
    pageUrl: service.pageUrl,
    status: "unknown",
    description: "",
    lastChecked: new Date(),
    incidents: [],
    ...overrides,
  };
}

function errorStatus(service: ServiceConfig, description: string, status: StatusLevel = "unknown"): ServiceStatus {
  return buildStatus(service, { status, description, incidents: [] });
}

function createFeedParser(): XMLParser {
  return new XMLParser(FEED_PARSER_OPTIONS);
}

function normalizeStatusLevel(value?: string): StatusLevel | null {
  const v = (value || "").toLowerCase();
  switch (v) {
    case "operational":
    case "degraded_performance":
    case "partial_outage":
    case "major_outage":
    case "under_maintenance":
      return v;
    case "maintenance":
      return "under_maintenance";
    default:
      return null;
  }
}

function impactToStatusLevel(impact?: string, fallback: StatusLevel = "operational"): StatusLevel {
  const normalized = normalizeStatusLevel(impact);
  if (normalized) return normalized;
  const imp = (impact || "").toLowerCase();
  if (imp === "critical") return "major_outage";
  if (imp === "major") return "partial_outage";
  if (imp === "minor") return "degraded_performance";
  if (imp === "none") return "operational";
  return fallback;
}

export function impactToStatusWithState(impact?: string, status?: string): StatusLevel {
  const st = (status || "").toLowerCase();
  if (/scheduled|in_progress/.test(st)) return "under_maintenance";
  const active = /(investigating|identified|monitoring|verifying|postmortem)/.test(st);
  return impactToStatusLevel(impact, active ? "degraded_performance" : "operational");
}

function humanizeServiceStatus(status: StatusLevel): string {
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

// Decode common HTML entities
function decodeHtmlEntities(text: string): string {
  if (!text) return text;
  let result = text;
  const map: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    // eslint-disable-next-line quotes
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
  };
  for (const [k, v] of Object.entries(map)) {
    result = result.replace(new RegExp(k, "g"), v);
  }
  // numeric entities
  result = result.replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(parseInt(d, 10)));
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  return result;
}

function decodeHtmlEntitiesDeep(text: string): string {
  let current = text;
  for (let index = 0; index < 3; index += 1) {
    const decoded = decodeHtmlEntities(current);
    if (decoded === current) {
      break;
    }
    current = decoded;
  }
  return current;
}

function extractStructuredText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => extractStructuredText(item))
      .filter(Boolean)
      .join(" ");
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const preferredKeys = ["#text", "__text", "#cdata", "__cdata", "text", "value"];
    const preferredText = preferredKeys
      .map((key) => extractStructuredText(record[key]))
      .filter(Boolean)
      .join(" ");

    if (preferredText) {
      return preferredText;
    }

    return Object.entries(record)
      .filter(([key]) => !key.startsWith("@_"))
      .map(([, nested]) => extractStructuredText(nested))
      .filter(Boolean)
      .join(" ");
  }

  return "";
}

// Convert basic HTML content to plain text suitable for Discord embeds
function htmlToText(html: unknown): string {
  const raw = extractStructuredText(html);
  if (!raw) return "";
  // Normalize newlines first and decode early so encoded markup can be stripped safely.
  let s = decodeHtmlEntitiesDeep(raw).replace(/\r\n?|\r/g, "\n");
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  // Line break style tags -> newlines
  s = s.replace(/<br\s*\/?\s*>/gi, "\n");
  s = s.replace(/<\/(p|div|h[1-6]|section|article|tr)\s*>/gi, "\n");
  // Start of blocks -> nothing
  s = s.replace(/<(p|div|h[1-6]|section|article|tr)[^>]*>/gi, "");
  // Lists -> bullets
  s = s.replace(/<li[^>]*>/gi, "- ");
  s = s.replace(/<\/li\s*>/gi, "\n");
  s = s.replace(/<\/?(ul|ol|table|tbody|thead|tr|td|th)[^>]*>/gi, "");
  // Remove all remaining tags
  s = s.replace(/<[^>]+>/g, "");
  // Decode any remaining entities after tags are gone.
  s = decodeHtmlEntitiesDeep(s);
  // Collapse excessive whitespace/newlines
  s = s.replace(/\u00A0/g, " ");
  s = s.replace(/[\t ]+/g, " ");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.replace(/ *\n */g, "\n");
  return s.trim();
}

function stripInformationalBoilerplate(text: string): string {
  return text
    .replace(/this site is updated when[^.]+\.?/gi, " ")
    .replace(/customers can (also )?reference[^.]+\.?/gi, " ")
    .replace(/for additional insights into[^.]+\.?/gi, " ")
    .replace(/visit (our )?(status page|dashboard)[^.]+\.?/gi, " ")
    .replace(/learn more[^.]*\.?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function statuspageToLevel(indicator?: string, overall?: string): StatusLevel {
  // indicator: none|minor|major|critical; overall description might include Maintenance
  if (!indicator) {
    const o = (overall || "").toLowerCase();
    if (!o) return "unknown";
    if (/maintenance/.test(o)) return "under_maintenance";
    if (/all\s*systems\s*operational|operational|no\s*issues|no\s*incidents/i.test(o)) return "operational";
    if (/degrad/.test(o)) return "degraded_performance";
    if (/partial/.test(o)) return "partial_outage";
    if (/outage|unavailable|major|critical/.test(o)) return "major_outage";
    return "unknown";
  }
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

type StatuspageUpdate = { body: unknown; created_at: string };
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
type StatuspageComponent = {
  description?: string | null;
  group?: boolean;
  group_id?: string;
  id: string;
  name: string;
  status?: string;
  updated_at?: string;
};
type StatuspageSummary = {
  components?: StatuspageComponent[];
  scheduled_maintenances?: StatuspageIncident[];
  status?: { description?: string; indicator?: string };
  incidents?: StatuspageIncident[];
};

async function fetchStatuspage(service: ServiceConfig): Promise<ServiceStatus> {
  const apiUrl = deriveStatuspageSummaryUrl(service);
  try {
    const res = await fetchWithTimeout(apiUrl);
    if (!res.ok) throw new Error(`${service.name} status API returned ${res.status}`);
    const data: StatuspageSummary = await res.json();
    let status = statuspageToLevel(data?.status?.indicator, data?.status?.description);
    const nowMs = Date.now();
    const futureScheduledMaintenances = [
      ...(data?.incidents || []).filter((incident) => isFutureScheduledStatuspageIncident(incident, nowMs)),
      ...(data?.scheduled_maintenances || []).filter((incident) =>
        isFutureScheduledStatuspageIncident(incident, nowMs)
      ),
    ];
    const incidents: IncidentInfo[] = [
      ...mapActiveStatuspageIncidents(data?.incidents, nowMs),
      ...mapActiveStatuspageIncidents(data?.scheduled_maintenances, nowMs),
    ];

    // If summary claims maintenance but none is currently in-progress or within window, treat as operational
    if (status === "under_maintenance" && incidents.length === 0) {
      status = "operational";
    }

    // Escalate overall status based on active incidents. Some Statuspage sites keep the indicator at "none"
    // while incidents are in progress; in that case, ensure we reflect a non-operational state.
    if (incidents.length > 0) {
      let incWorst: StatusLevel = "operational";
      for (const inc of incidents) {
        const m = impactToStatusWithState(inc.impact, inc.status);
        incWorst = escalateStatus(incWorst, m);
      }
      status = escalateStatus(status, incWorst);
    }

    if (incidents.length === 0 && futureScheduledMaintenances.length > 0) {
      status = "operational";
    }

    if (incidents.length === 0 && status !== "operational" && status !== "unknown") {
      incidents.push(...synthesizeStatuspageFallbackIncidents(service, data, status));
    }

    return buildStatus(service, {
      description: describeStatuspageResult(status, data?.status?.description, incidents),
      incidents,
      status,
    });
  } catch {
    return errorStatus(service, "Unreachable");
  }
}

function describeStatuspageResult(
  status: StatusLevel,
  summaryDescription: string | undefined,
  incidents: IncidentInfo[]
): string {
  const trimmedSummary = (summaryDescription ?? "").trim();

  if (status === "operational") {
    return "";
  }

  if (status === "under_maintenance" && incidents.length > 0) {
    return "Maintenance in progress";
  }

  if (incidents.length > 0) {
    const incidentName = (incidents[0]?.name ?? "").trim();
    if (incidentName && (!trimmedSummary || isOperationalSummaryDescription(trimmedSummary))) {
      return incidentName;
    }
  }

  return trimmedSummary || humanizeServiceStatus(status);
}

function isOperationalSummaryDescription(description: string): boolean {
  return /all systems operational|no known issues|no incidents reported|operational/i.test(description);
}

function mapActiveStatuspageIncidents(items: StatuspageIncident[] | undefined, nowMs: number): IncidentInfo[] {
  return (items || []).filter((incident) => isActiveStatuspageIncident(incident, nowMs)).map(mapStatuspageIncident);
}

function isActiveStatuspageIncident(incident: StatuspageIncident, nowMs: number): boolean {
  const status = (incident.status || "").toLowerCase();
  const impact = (incident.impact || "").toLowerCase();

  if (/in_progress/.test(status)) {
    return true;
  }

  if (/scheduled/.test(status)) {
    const startMs = incident.scheduled_for ? Date.parse(incident.scheduled_for) : NaN;
    const endMs = incident.scheduled_until ? Date.parse(incident.scheduled_until) : NaN;
    return !Number.isNaN(startMs) && !Number.isNaN(endMs) && nowMs >= startMs && nowMs <= endMs;
  }

  if (/investigating|identified|monitoring|verifying|postmortem/i.test(status)) {
    return !!impact && impact !== "none";
  }

  return false;
}

function isFutureScheduledStatuspageIncident(incident: StatuspageIncident, nowMs: number): boolean {
  const status = (incident.status || "").toLowerCase();
  if (!/scheduled/.test(status)) {
    return false;
  }

  const startMs = incident.scheduled_for ? Date.parse(incident.scheduled_for) : NaN;
  return !Number.isNaN(startMs) && startMs > nowMs;
}

function mapStatuspageIncident(incident: StatuspageIncident): IncidentInfo {
  return {
    created_at: incident.created_at,
    id: incident.id,
    impact: incident.impact,
    incident_updates: (incident.incident_updates || []).map((update) => ({
      body: htmlToText(update.body),
      created_at: update.created_at,
    })),
    name: htmlToText(incident.name),
    shortlink: incident.shortlink,
    status: incident.status,
  };
}

function synthesizeStatuspageFallbackIncidents(
  service: ServiceConfig,
  summary: StatuspageSummary,
  status: StatusLevel
): IncidentInfo[] {
  const impactedComponents = getImpactedStatuspageComponents(summary.components);
  if (impactedComponents.length > 0) {
    const impactedNames = summarizeAffectedComponents(impactedComponents);
    const componentLevels = impactedComponents
      .map((component) => normalizeStatusLevel(component.status))
      .filter((level): level is StatusLevel => level !== null);
    const componentStatus = componentLevels.reduce<StatusLevel>(escalateStatus, status);

    return [
      {
        created_at: getLatestStatuspageComponentUpdateAt(impactedComponents),
        id: `${service.id}-statuspage-components`,
        impact: componentStatus,
        incident_updates: [],
        name: impactedComponents.length === 1 ? impactedNames : `Affected components: ${impactedNames}`,
        shortlink: service.pageUrl,
        status: componentStatus,
      },
    ];
  }

  const summaryDescription = (summary.status?.description ?? "").trim();
  if (!summaryDescription || isOperationalSummaryDescription(summaryDescription)) {
    return [];
  }

  return [
    {
      created_at: new Date().toISOString(),
      id: `${service.id}-statuspage-summary`,
      impact: status,
      incident_updates: [],
      name: summaryDescription,
      shortlink: service.pageUrl,
      status,
    },
  ];
}

function getImpactedStatuspageComponents(components: StatuspageComponent[] | undefined): StatuspageComponent[] {
  const impacted = (components || []).filter((component) => {
    const normalized = normalizeStatusLevel(component.status);
    return normalized !== null && normalized !== "operational";
  });

  const leaves = impacted.filter((component) => !component.group);
  return leaves.length > 0 ? leaves : impacted;
}

function summarizeAffectedComponents(components: StatuspageComponent[]): string {
  const names = components.map((component) => htmlToText(component.name)).filter(Boolean);
  if (names.length <= 3) {
    return names.join(", ");
  }

  return `${names.slice(0, 3).join(", ")} +${names.length - 3} more`;
}

function getLatestStatuspageComponentUpdateAt(components: StatuspageComponent[]): string {
  const latest = components.reduce<number>((currentLatest, component) => {
    const parsed = component.updated_at ? Date.parse(component.updated_at) : NaN;
    return Number.isNaN(parsed) ? currentLatest : Math.max(currentLatest, parsed);
  }, 0);

  return new Date(latest > 0 ? latest : Date.now()).toISOString();
}

async function fetchGeneric(service: ServiceConfig): Promise<ServiceStatus> {
  try {
    const res = await fetchWithTimeout(service.pageUrl);
    const { ok, status } = res;
    return buildStatus(service, {
      description: ok ? "" : `HTTP ${status}`,
      status: ok ? "operational" : "major_outage",
    });
  } catch {
    return errorStatus(service, "Unreachable");
  }
}

function inferStatusFromText(text: string): StatusLevel {
  const operationalPhrasePattern = new RegExp(
    ["\\bno\\s+issues\\b", "\\bno\\s+known\\s+issues\\b", "\\bavailable\\b", "\\bhealthy\\b", "\\ball clear\\b"].join(
      "|"
    ),
    "i"
  );
  const activeMaintenancePattern = new RegExp(
    [
      "(ongoing|current|active|in progress).{0,24}(maintenance)",
      "maintenance.{0,24}(ongoing|current|active|in progress)",
    ].join("|"),
    "i"
  );
  const majorOutagePattern = /(critical|major outage|service unavailable|outage|unavailable|downtime|down)/i;
  const degradedPattern = new RegExp(
    [
      "degrad",
      "investigating",
      "identified",
      "monitoring",
      "verifying",
      "latenc",
      "error",
      "elevated\\s+error",
      "disruption",
      "interruption",
    ].join("|"),
    "i"
  );
  const activeIssueContextPattern = new RegExp(
    [
      "active",
      "current",
      "ongoing",
      "widespread",
      "affecting",
      "impacting",
      "preventing",
      "experiencing",
      "detected",
      "users?\\s+(may|are|cannot|can't)",
    ].join("|"),
    "i"
  );
  const t = stripInformationalBoilerplate(text).toLowerCase();
  if (!t) return "operational";
  // Ignore informational posts explicitly stating no impact
  if (/(no\s+operational\s+impact|no\s+impact)/i.test(t)) return "operational";
  if (operationalPhrasePattern.test(t))
    return "operational";
  if (activeMaintenancePattern.test(t))
    return "under_maintenance";
  if (majorOutagePattern.test(t))
    return "major_outage";
  if (/(partial)/i.test(t)) return "partial_outage";
  if (degradedPattern.test(t))
    return "degraded_performance";
  if (/(incident|issue|issues)/i.test(t) && activeIssueContextPattern.test(t)) {
    return "degraded_performance";
  }
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

function deriveStatuspagePathUrl(pageUrl: string, pathname: string): string {
  try {
    const url = new URL(pageUrl);
    url.pathname = pathname;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    const normalizedBase = pageUrl.replace(/\/+$/, "");
    return `${normalizedBase}${pathname}`;
  }
}

function deriveStatuspageSummaryUrl(service: ServiceConfig): string {
  return service.apiUrl || deriveStatuspagePathUrl(service.pageUrl, "/api/v2/summary.json");
}

function deriveStatuspageRssUrl(pageUrl: string): string {
  return deriveStatuspagePathUrl(pageUrl, "/history.atom");
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

export function buildAwsChildServices(): ServiceConfig[] {
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

export function createUnknownServiceStatus(service: ServiceConfig, description = "Checking status..."): ServiceStatus {
  return buildStatus(service, {
    description,
    incidents: [],
    status: "unknown",
  });
}

type FeedEntry = {
  description?: unknown;
  id?: string;
  link?: string | Record<string, unknown> | Array<Record<string, unknown>>;
  published?: string;
  updated?: string;
  status?: string;
  title?: string;
  summary?: unknown;
  content?: unknown;
  pubDate?: string; // RSS
};

function feedEntryStatusToLevel(status?: string): StatusLevel | null {
  const normalized = (status || "").trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (/^(available|healthy|ok|operational|resolved)$/.test(normalized)) {
    return "operational";
  }
  if (/maintenance/.test(normalized) && !/(scheduled|planned|upcoming)/.test(normalized)) {
    return "under_maintenance";
  }
  if (/(partial|degraded|warning)/.test(normalized)) {
    return "degraded_performance";
  }
  if (/(major|critical|unavailable|outage|down)/.test(normalized)) {
    return "major_outage";
  }

  return null;
}

function isFutureScheduledMaintenanceText(text: string): boolean {
  if (!/(scheduled event|scheduled maintenance|upcoming scheduled maintenance|maintenance is scheduled)/i.test(text)) {
    return false;
  }

  if (/(in progress|ongoing|current|started|underway|active maintenance)/i.test(text)) {
    return false;
  }

  if (/\bin\s+\d+\s+(minute|minutes|hour|hours|day|days|week|weeks|month|months)\b/i.test(text)) {
    return true;
  }

  return /(upcoming|scheduled)/i.test(text);
}

function getFeedEntryBody(entry: FeedEntry, titleFallback = ""): string {
  return htmlToText(entry.summary ?? entry.content ?? entry.description ?? titleFallback);
}

function getFeedEntryLink(entry: FeedEntry): string | undefined {
  if (typeof entry.link === "string") {
    return entry.link;
  }

  if (Array.isArray(entry.link)) {
    const first = entry.link[0] as Record<string, unknown> | undefined;
    return first && typeof first["@_href"] === "string" ? (first["@_href"] as string) : undefined;
  }

  if (entry.link && typeof entry.link === "object") {
    const objectLink = entry.link as Record<string, unknown>;
    return typeof objectLink["@_href"] === "string" ? (objectLink["@_href"] as string) : undefined;
  }

  return undefined;
}

async function fetchRSS(service: ServiceConfig): Promise<ServiceStatus> {
  // If multiple feeds are provided, aggregate them
  if (service.rssUrls && service.rssUrls.length > 0) {
    const parser = createFeedParser();

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
    let latestNonOperationalTitle: string | undefined;
    let latestNonOperationalLink: string | undefined;

    for (const e of entries.slice(0, 200)) {
      const tsStr = (e.updated || e.published || e.pubDate || "").toString();
      const ts = tsStr ? Date.parse(tsStr) : NaN;
      const title = htmlToText(e.title);
      const body = getFeedEntryBody(e, title);
      const link = getFeedEntryLink(e);
      if (!Number.isNaN(ts) && now - ts <= 1000 * 60 * 60 * 24 * 3) {
        updates.push({ body, created_at: new Date(ts).toISOString() });
        const combined = `${title} ${body}`;
        const explicitStatus = feedEntryStatusToLevel(e.status);
        if (isFutureScheduledMaintenanceText(combined)) {
          continue;
        }
        if (isResolutionText(combined)) {
          latestResolutionMs = Math.max(latestResolutionMs, ts);
          continue;
        }
        const st = explicitStatus ?? inferStatusFromText(combined);
        if (st !== "operational") latestNonOperationalMs = Math.max(latestNonOperationalMs, ts);
        if (st !== "operational" && (latestNonOperationalTitle === undefined || ts >= latestNonOperationalMs)) {
          latestNonOperationalTitle = title || latestNonOperationalTitle;
          latestNonOperationalLink = link || latestNonOperationalLink;
        }
        if (isWorseStatus(st, topStatus, STATUS_RANK_UNKNOWN_HIGH)) topStatus = st;
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
              name: (latestNonOperationalTitle || `${service.name} - Aggregated RSS incidents`).toString(),
              shortlink: latestNonOperationalLink || service.pageUrl,
              status: topStatus,
            },
          ]
        : [];

    return buildStatus(service, {
      description:
        incidents.length > 0
          ? topStatus === "under_maintenance" && maintenanceInProgress
            ? "Maintenance in progress"
            : (latestNonOperationalTitle || "Recent incidents detected").toString()
          : "",
      incidents,
      status: incidents.length > 0 ? topStatus : "operational",
    });
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
    return buildStatus(service, { description: "No RSS", status: "unknown" });
  }

  try {
    const res = await fetchWithTimeout(rssUrl);
    if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);
    const xml = await res.text();

    const parser = createFeedParser();
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
      feedTitle = htmlToText((feedObj.title || "").toString());
      const atomEntries = Array.isArray(feedObj.entry) ? feedObj.entry : feedObj.entry ? [feedObj.entry] : [];
      for (const e of atomEntries) entries.push(e as FeedEntry);
    } else if (isRss(parsed)) {
      const { channel } = parsed.rss as { channel?: { title?: string; item?: unknown | unknown[] } };
      if (channel) {
        feedTitle = htmlToText((channel.title || "").toString());
        const items = Array.isArray(channel.item) ? channel.item : channel.item ? [channel.item] : [];
        for (const i of items) entries.push(i as FeedEntry);
      }
    }

    // Build incident info from recent entries
    const now = Date.now();
    const updates: IncidentUpdateInfo[] = [];
    let topStatus: StatusLevel = "operational";
    let incidentName = htmlToText((entries[0]?.title || feedTitle || service.name).toString());
    let shortlink: string | undefined;
    let latestNonOperationalTitle2: string | undefined;
    let latestNonOperationalLink2: string | undefined;

    let maintenanceInProgress = false;
    let latestResolutionMs = -1;
    let latestNonOperationalMs = -1;
    for (const e of entries.slice(0, 20)) {
      const tsStr = (e.updated || e.published || e.pubDate || "").toString();
      const ts = tsStr ? Date.parse(tsStr) : NaN;
      const title = htmlToText(e.title);
      const body = getFeedEntryBody(e, title);
      const link = getFeedEntryLink(e);

      if (!Number.isNaN(ts) && now - ts <= 1000 * 60 * 60 * 24 * 3) {
        // consider last 3 days
        updates.push({ body, created_at: new Date(ts).toISOString() });
        const combined = `${title} ${body}`;
        const explicitStatus = feedEntryStatusToLevel(e.status);
        if (isFutureScheduledMaintenanceText(combined)) {
          continue;
        }
        if (isResolutionText(combined)) {
          latestResolutionMs = Math.max(latestResolutionMs, ts);
          continue;
        }
        const st = explicitStatus ?? inferStatusFromText(combined);
        if (st !== "operational") {
          latestNonOperationalMs = Math.max(latestNonOperationalMs, ts);
          // pick the worst
          if (isWorseStatus(st, topStatus, STATUS_RANK_UNKNOWN_HIGH)) topStatus = st;
          // Track latest non-operational entry's title/link for summary
          if (!latestNonOperationalTitle2 || ts >= latestNonOperationalMs) {
            latestNonOperationalTitle2 = title || latestNonOperationalTitle2;
            latestNonOperationalLink2 = link || latestNonOperationalLink2;
          }
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
              name: (latestNonOperationalTitle2 || incidentName).toString(),
              shortlink: latestNonOperationalLink2 || shortlink,
              status: topStatus,
            },
          ]
        : [];

    return buildStatus(service, {
      description:
        incidents.length > 0
          ? topStatus === "under_maintenance" && maintenanceInProgress
            ? "Maintenance in progress"
            : (latestNonOperationalTitle2 || incidentName).toString()
          : "",
      incidents,
      status: incidents.length > 0 ? topStatus : "operational",
    });
  } catch {
    return errorStatus(service, "Unreachable");
  }
}

function escalateStatus(a: StatusLevel, b: StatusLevel): StatusLevel {
  return isWorseStatus(b, a, STATUS_RANK) ? b : a;
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
      let worst: StatusLevel = "operational";
      for (const inc of incidents)
        worst = escalateStatus(worst, impactToStatusLevel(inc.impact, "degraded_performance"));
      overall = escalateStatus(overall, worst);
    }

    // Keep concise; only append text for noteworthy states
    const description = overall === "operational" ? "" : overall === "major_outage" ? "Major Outage" : parts.join("; ");
    return buildStatus(service, {
      description: description || "Parsed Steam status",
      incidents,
      status: overall,
    });
  } catch {
    return errorStatus(service, "Unreachable", "major_outage");
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

    return buildStatus(service, { description, incidents, status: overall });
  } catch {
    return errorStatus(service, "Unreachable", "major_outage");
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

      return buildStatus(service, {
        description:
          overall === "under_maintenance" && incidents.length
            ? "Maintenance in progress"
            : incidents.length
              ? "Issues detected"
              : "",
        incidents,
        status: incidents.length ? overall : "operational",
      });
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
    return buildStatus(service, {
      description:
        overall === "under_maintenance" && incidents.length
          ? "Maintenance in progress"
          : incidents.length
            ? "Issues detected"
            : "",
      incidents,
      status: incidents.length ? overall : "operational",
    });
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
    if (sp.status !== "unknown") {
      return sp;
    }

    // Statuspage summary is the preferred source of truth.
    // RSS and generic checks are only backups when summary.json is unavailable or ambiguous.
    const rss = await fetchRSS(service);
    if (rss.status !== "unknown") {
      return rss;
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
      {
        apiUrl: "https://status.zendesk.com/api/v2/summary.json",
        id: "zendesk",
        name: "Zendesk",
        pageUrl: "https://status.zendesk.com/",
        type: "statuspage",
      },
      {
        apiUrl: "https://status.hubspot.com/api/v2/summary.json",
        id: "hubspot",
        name: "HubSpot",
        pageUrl: "https://status.hubspot.com/",
        type: "statuspage",
      },
      {
        apiUrl: "https://www.frontstatus.com/api/v2/summary.json",
        id: "front",
        name: "Front",
        pageUrl: "https://www.frontstatus.com/",
        type: "statuspage",
      },
      {
        apiUrl: "https://status.miro.com/api/v2/summary.json",
        id: "miro",
        name: "Miro",
        pageUrl: "https://status.miro.com/",
        type: "statuspage",
      },
      {
        apiUrl: "https://status.notion.so/api/v2/summary.json",
        id: "notion",
        name: "Notion",
        pageUrl: "https://status.notion.so/",
        type: "statuspage",
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
        // Keep official Azure status page; support both legacy and new RSS endpoints
        pageUrl: "https://status.azure.com/",
        rssUrls: [
          "https://rssfeed.azure.status.microsoft/en-us/status/feed/",
          "https://azure.status.microsoft/en-us/status/feed/",
        ],
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
        apiUrl: "https://status.digitalocean.com/api/v2/summary.json",
        id: "digitalocean",
        name: "DigitalOcean",
        pageUrl: "https://status.digitalocean.com/",
        type: "statuspage",
      },
      {
        apiUrl: "https://status.linode.com/api/v2/summary.json",
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
        apiUrl: "https://status.lastpass.com/api/v2/summary.json",
        id: "lastpass",
        name: "LastPass",
        pageUrl: "https://status.lastpass.com/",
        type: "statuspage",
      },
      {
        apiUrl: "https://status.duo.com/api/v2/summary.json",
        id: "duo",
        name: "Duo Security",
        pageUrl: "https://status.duo.com/",
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
        type: "generic",
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
      {
        apiUrl: "https://www.vercel-status.com/api/v2/summary.json",
        id: "vercel",
        name: "Vercel",
        pageUrl: "https://www.vercel-status.com/",
        type: "statuspage",
      },
      {
        apiUrl: "https://www.status-ovhcloud.com/api/v2/summary.json",
        id: "ovhcloud",
        name: "OVHcloud",
        pageUrl: "https://www.status-ovhcloud.com/",
        type: "statuspage",
      },
      {
        apiUrl: "https://statuspage.hostinger.com/api/v2/summary.json",
        id: "hostinger",
        name: "Hostinger",
        pageUrl: "https://statuspage.hostinger.com/",
        type: "statuspage",
      },
      {
        apiUrl: "https://status.webflow.com/api/v2/summary.json",
        id: "webflow",
        name: "Webflow",
        pageUrl: "https://status.webflow.com/",
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
      {
        apiUrl: "https://status.robinhood.com/api/v2/summary.json",
        id: "robinhood",
        name: "Robinhood",
        pageUrl: "https://status.robinhood.com/",
        type: "statuspage",
      },
      {
        apiUrl: "https://status.gemini.com/api/v2/summary.json",
        id: "gemini",
        name: "Gemini",
        pageUrl: "https://status.gemini.com/",
        type: "statuspage",
      },
      {
        apiUrl: "https://status.brex.com/api/v2/summary.json",
        id: "brex",
        name: "Brex",
        pageUrl: "https://status.brex.com/",
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
        apiUrl: "https://status.algolia.com/api/v2/summary.json",
        id: "algolia",
        name: "Algolia",
        pageUrl: "https://status.algolia.com/",
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
        apiUrl: "https://confluence.status.atlassian.com/api/v2/summary.json",
        id: "confluence",
        name: "Confluence",
        pageUrl: "https://confluence.status.atlassian.com/",
        type: "statuspage",
      },
      {
        apiUrl: "https://trello.status.atlassian.com/api/v2/summary.json",
        id: "trello",
        name: "Trello",
        pageUrl: "https://trello.status.atlassian.com/",
        type: "statuspage",
      },
      {
        apiUrl: "https://status.asana.com/api/v2/summary.json",
        id: "asana",
        name: "Asana",
        pageUrl: "https://status.asana.com/",
        type: "statuspage",
      },
      {
        apiUrl: "https://loom.status.atlassian.com/api/v2/summary.json",
        id: "loom",
        name: "Loom",
        pageUrl: "https://loom.status.atlassian.com/",
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
        apiUrl: "https://status.dropbox.com/api/v2/summary.json",
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
        apiUrl: "https://status.box.com/api/v2/summary.json",
        id: "box",
        name: "Box",
        pageUrl: "https://status.box.com/",
        type: "statuspage",
      },
      {
        apiUrl: "https://status.postman.com/api/v2/summary.json",
        id: "postman",
        name: "Postman",
        pageUrl: "https://status.postman.com/",
        type: "statuspage",
      },
      {
        apiUrl: "https://snyk.statuspage.io/api/v2/summary.json",
        id: "snyk",
        name: "Snyk",
        pageUrl: "https://snyk.statuspage.io/",
        type: "statuspage",
      },
      {
        apiUrl: "https://status.launchdarkly.com/api/v2/summary.json",
        id: "launchdarkly",
        name: "LaunchDarkly",
        pageUrl: "https://status.launchdarkly.com/",
        type: "statuspage",
      },
      {
        apiUrl: "https://status.harness.io/api/v2/summary.json",
        id: "harness",
        name: "Harness",
        pageUrl: "https://status.harness.io/",
        type: "statuspage",
      },
      {
        apiUrl: "https://status.figma.com/api/v2/summary.json",
        id: "figma",
        name: "Figma",
        pageUrl: "https://status.figma.com/",
        type: "statuspage",
      },
      {
        apiUrl: "https://status.mixpanel.com/api/v2/summary.json",
        id: "mixpanel",
        name: "Mixpanel",
        pageUrl: "https://status.mixpanel.com/",
        type: "statuspage",
      },
      {
        apiUrl: "https://status.segment.com/api/v2/summary.json",
        id: "segment",
        name: "Segment",
        pageUrl: "https://status.segment.com/",
        type: "statuspage",
      },
      {
        apiUrl: "https://status.pagerduty.com/api/v2/summary.json",
        id: "pagerduty",
        name: "PagerDuty",
        pageUrl: "https://status.pagerduty.com/",
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
        apiUrl: "https://status.airtable.com/api/v2/summary.json",
        id: "airtable",
        name: "Airtable",
        pageUrl: "https://status.airtable.com/",
        type: "statuspage",
      },
      {
        apiUrl: "https://status.supabase.com/api/v2/summary.json",
        id: "supabase",
        name: "Supabase",
        pageUrl: "https://status.supabase.com/",
        type: "statuspage",
      },
      {
        apiUrl: "https://crowdstrike.statuspage.io/api/v2/summary.json",
        id: "crowdstrike",
        name: "CrowdStrike",
        pageUrl: "https://crowdstrike.statuspage.io/",
        type: "statuspage",
      },
      {
        apiUrl: "https://status.fivetran.com/api/v2/summary.json",
        id: "fivetran",
        name: "Fivetran",
        pageUrl: "https://status.fivetran.com/",
        type: "statuspage",
      },
      {
        apiUrl: "https://status.snowflake.com/api/v2/summary.json",
        id: "snowflake",
        name: "Snowflake",
        pageUrl: "https://status.snowflake.com/",
        type: "statuspage",
      },
      {
        apiUrl: "https://status.metabase.com/api/v2/summary.json",
        id: "metabase",
        name: "Metabase",
        pageUrl: "https://status.metabase.com/",
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
        apiUrl: "https://slack-status.com/api/v2/summary.json",
        id: "slack",
        name: "Slack",
        pageUrl: "https://slack-status.com/",
        rssUrl: "https://slack-status.com/feed/rss",
        type: "statuspage",
      },
      {
        id: "microsoft365",
        name: "Microsoft 365",
        pageUrl: "https://status.cloud.microsoft/",
        rssUrl: "https://status.cloud.microsoft/api/feed/mac",
        type: "generic",
      },
      {
        apiUrl: "https://status.vzconnect.com/api/v2/summary.json",
        id: "vzconnect",
        name: "Verizon Connect",
        pageUrl: "https://status.vzconnect.com/",
        type: "statuspage",
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
        apiUrl: "https://www.intercomstatus.com/api/v2/summary.json",
        id: "intercom",
        name: "Intercom",
        pageUrl: "https://www.intercomstatus.com/",
        type: "statuspage",
      },
      {
        apiUrl: "https://www.vimeostatus.com/api/v2/summary.json",
        id: "vimeo",
        name: "Vimeo",
        pageUrl: "https://www.vimeostatus.com/",
        type: "statuspage",
      },
      {
        apiUrl: "https://status.wistia.com/api/v2/summary.json",
        id: "wistia",
        name: "Wistia",
        pageUrl: "https://status.wistia.com/",
        rssUrl: "https://status.wistia.com/history.rss",
        type: "statuspage",
      },
      {
        apiUrl: "https://www.redditstatus.com/api/v2/summary.json",
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

export function getApiStatusCatalog(categories: CategoryConfig[] = Categories): ApiStatusCatalog {
  const displayCategories = categories.map((category) => ({
    name: category.name,
    services: category.services.filter((service) => !service.groupId),
  }));

  const generalServices: ApiStatusCatalogEntry[] = [];
  const awsChildren: ApiStatusCatalogEntry[] = [];
  let awsRoot: ApiStatusCatalogEntry | null = null;

  for (const category of categories) {
    for (const service of category.services) {
      const entry: ApiStatusCatalogEntry = {
        categoryName: category.name,
        service,
      };

      if (service.id === "aws" && service.isGroupRoot) {
        awsRoot = entry;
        continue;
      }

      if (service.groupId === "aws") {
        awsChildren.push(entry);
        continue;
      }

      generalServices.push(entry);
    }
  }

  return {
    awsChildren,
    awsRoot,
    displayCategories,
    generalServices,
  };
}

export async function fetchAllStatuses(): Promise<{ categories: { name: string; services: ServiceStatus[] }[] }> {
  const tasks: Array<Promise<{ name: string; services: ServiceStatus[] }>> = Categories.map(async (cat) => {
    // Run all services in the category concurrently for speed
    const services = await Promise.all(
      cat.services.map(async (svc) => {
        try {
          return await checkService(svc);
        } catch {
          // Extremely defensive fallback
          return errorStatus(svc, "Unreachable", "major_outage");
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
