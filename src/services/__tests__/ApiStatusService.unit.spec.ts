import { checkSingleService, ServiceConfig } from "../ApiStatusService";

function createStatuspageService(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    id: "statuspage-service",
    name: "Statuspage Service",
    pageUrl: "https://status.example.com/",
    type: "statuspage",
    ...overrides,
  };
}

function createSteamService(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    id: "steam",
    name: "Steam",
    pageUrl: "https://steamstat.us/",
    type: "generic",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function htmlResponse(body = "<!doctype html><html></html>", status = 200): Response {
  return new Response(body, {
    headers: { "content-type": "text/html" },
    status,
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    headers: { "content-type": "application/xml" },
    status,
  });
}

describe("ApiStatusService statuspage fetching", () => {
  const originalFetch = global.fetch;
  const fixedNow = new Date("2026-04-05T12:00:00.000Z").getTime();

  beforeEach(() => {
    jest.useFakeTimers({ now: fixedNow });
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  function getFirstRequestedUrl(fetchMock: jest.Mock): string | undefined {
    return fetchMock.mock.calls[0]?.[0] as string | undefined;
  }

  function getSecondRequestedUrl(fetchMock: jest.Mock): string | undefined {
    return fetchMock.mock.calls[1]?.[0] as string | undefined;
  }

  function getRequestedUrls(fetchMock: jest.Mock): string[] {
    return fetchMock.mock.calls.map((call) => call[0] as string);
  }

  it("derives the summary endpoint from the host root before anything else", async () => {
    const fetchMock = jest.fn(async () =>
      jsonResponse({
        incidents: [],
        status: {
          description: "All Systems Operational",
          indicator: "none",
        },
      })
    );
    global.fetch = fetchMock as typeof fetch;

    const service = createStatuspageService({
      pageUrl: "https://www.paypal-status.com/product/production",
      rssUrl: "https://www.paypal-status.com/feed/rss",
    });

    const status = await checkSingleService(service);

    expect(status.status).toBe("operational");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getFirstRequestedUrl(fetchMock)).toBe("https://www.paypal-status.com/api/v2/summary.json");
  });

  it("keeps summary.json as the source of truth when it succeeds", async () => {
    const fetchMock = jest.fn(async () =>
      jsonResponse({
        incidents: [
          {
            created_at: "2026-04-03T12:00:00.000Z",
            id: "incident-1",
            impact: "major",
            incident_updates: [],
            name: "Elevated errors",
            shortlink: "https://status.example.com/incidents/incident-1",
            status: "identified",
          },
        ],
        status: {
          description: "Partial System Outage",
          indicator: "major",
        },
      })
    );
    global.fetch = fetchMock as typeof fetch;

    const service = createStatuspageService({
      rssUrl: "https://status.example.com/feed/rss",
    });

    const status = await checkSingleService(service);

    expect(status.status).toBe("partial_outage");
    expect(status.incidents?.[0]?.name).toBe("Elevated errors");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getFirstRequestedUrl(fetchMock)).toBe("https://status.example.com/api/v2/summary.json");
  });

  it('uses the live incident name when summary text still says "All Systems Operational"', async () => {
    const fetchMock = jest.fn(async () =>
      jsonResponse({
        incidents: [
          {
            created_at: "2026-04-03T12:00:00.000Z",
            id: "incident-1",
            impact: "minor",
            incident_updates: [],
            name: "Cloudlets and NetStorage upload Issues",
            shortlink: "https://status.example.com/incidents/incident-1",
            status: "monitoring",
          },
        ],
        status: {
          description: "All Systems Operational",
          indicator: "none",
        },
      })
    );
    global.fetch = fetchMock as typeof fetch;

    const service = createStatuspageService();

    const status = await checkSingleService(service);

    expect(status.status).toBe("degraded_performance");
    expect(status.description).toBe("Cloudlets and NetStorage upload Issues");
    expect(status.incidents?.[0]?.name).toBe("Cloudlets and NetStorage upload Issues");
  });

  it("creates a fallback incident from impacted statuspage components when the summary is degraded", async () => {
    const fetchMock = jest.fn(async () =>
      jsonResponse({
        components: [
          {
            group: false,
            id: "component-1",
            name: "WARP connectivity",
            status: "degraded_performance",
            updated_at: "2026-04-04T16:45:00.000Z",
          },
        ],
        incidents: [],
        status: {
          description: "Minor Service Outage",
          indicator: "minor",
        },
      })
    );
    global.fetch = fetchMock as typeof fetch;

    const service = createStatuspageService({
      name: "Cloudflare",
      pageUrl: "https://www.cloudflarestatus.com/",
    });

    const status = await checkSingleService(service);

    expect(status.status).toBe("degraded_performance");
    expect(status.description).toBe("Minor Service Outage");
    expect(status.incidents).toHaveLength(1);
    expect(status.incidents?.[0]?.name).toBe("WARP connectivity");
  });

  it("keeps one canonical active incident when a statuspage service exposes multiple unresolved incidents", async () => {
    const fetchMock = jest.fn(async () =>
      jsonResponse({
        incidents: [
          {
            created_at: "2026-04-03T12:00:00.000Z",
            id: "incident-older",
            impact: "minor",
            incident_updates: [
              {
                body: "Older update",
                created_at: "2026-04-03T12:05:00.000Z",
              },
            ],
            name: "Older degraded incident",
            shortlink: "https://status.example.com/incidents/incident-older",
            status: "identified",
          },
          {
            created_at: "2026-04-04T16:00:00.000Z",
            id: "incident-newer",
            impact: "critical",
            incident_updates: [
              {
                body: "Newest update",
                created_at: "2026-04-04T16:10:00.000Z",
              },
            ],
            name: "Newer critical incident",
            shortlink: "https://status.example.com/incidents/incident-newer",
            status: "investigating",
          },
        ],
        status: {
          description: "Partial System Outage",
          indicator: "major",
        },
      })
    );
    global.fetch = fetchMock as typeof fetch;

    const service = createStatuspageService();
    const status = await checkSingleService(service);

    expect(status.incidents).toHaveLength(2);
    expect(status.incidents?.[0]?.id).toBe("incident-newer");
    expect(status.incidents?.[0]?.name).toBe("Newer critical incident");
  });

  it("does not add a fallback component incident when a real unresolved incident already exists", async () => {
    const fetchMock = jest.fn(async () =>
      jsonResponse({
        components: [
          {
            group: false,
            id: "component-1",
            name: "AI ChatBot (Chat with watsonx)",
            status: "major_outage",
            updated_at: "2026-04-04T16:45:00.000Z",
          },
        ],
        incidents: [
          {
            created_at: "2026-04-04T16:00:00.000Z",
            id: "incident-1",
            impact: "critical",
            incident_updates: [
              {
                body: "We are continuing to investigate this issue.",
                created_at: "2026-04-04T16:10:00.000Z",
              },
            ],
            name: "US & EU - Issues with AI Chatbot",
            shortlink: "https://status.example.com/incidents/incident-1",
            status: "investigating",
          },
        ],
        status: {
          description: "Partial System Outage",
          indicator: "major",
        },
      })
    );
    global.fetch = fetchMock as typeof fetch;

    const service = createStatuspageService({
      name: "IBM Security",
      pageUrl: "https://statuspage.ibmcloudsecurity.com/",
    });
    const status = await checkSingleService(service);

    expect(status.incidents).toHaveLength(1);
    expect(status.incidents?.[0]?.name).toBe("US & EU - Issues with AI Chatbot");
  });

  it("keeps statuspage services operational when only future scheduled maintenance exists", async () => {
    const fetchMock = jest.fn(async () =>
      jsonResponse({
        components: [
          {
            group: false,
            id: "component-1",
            name: "Dar Es Salaam, Tanzania - (DAR)",
            status: "under_maintenance",
            updated_at: "2026-04-04T16:45:00.000Z",
          },
        ],
        incidents: [
          {
            created_at: "2026-04-04T12:00:00.000Z",
            id: "maintenance-1",
            impact: "minor",
            incident_updates: [],
            name: "Future maintenance",
            scheduled_for: "2026-04-18T22:00:00.000Z",
            scheduled_until: "2026-04-19T00:30:00.000Z",
            shortlink: "https://status.example.com/incidents/maintenance-1",
            status: "scheduled",
          },
        ],
        status: {
          description: "Minor Service Outage",
          indicator: "minor",
        },
      })
    );
    global.fetch = fetchMock as typeof fetch;

    const service = createStatuspageService({
      name: "Cloudflare",
      pageUrl: "https://www.cloudflarestatus.com/",
    });

    const status = await checkSingleService(service);

    expect(status.status).toBe("operational");
    expect(status.description).toBe("");
    expect(status.incidents).toEqual([]);
  });

  it("uses RSS only as a backup when summary.json is unavailable", async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "server error" }, 500))
      .mockResolvedValueOnce(
        textResponse(`<?xml version="1.0" encoding="UTF-8"?>
          <rss>
            <channel>
              <title>Status</title>
              <item>
                <title>Major outage in progress</title>
                <pubDate>Fri, 03 Apr 2026 12:00:00 GMT</pubDate>
                <description>Major outage in progress</description>
                <link>https://status.example.com/incidents/incident-1</link>
              </item>
            </channel>
          </rss>`)
      );
    global.fetch = fetchMock as typeof fetch;

    const service = createStatuspageService({
      rssUrl: "https://status.example.com/feed/rss",
    });

    const status = await checkSingleService(service);

    expect(status.status).toBe("major_outage");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getFirstRequestedUrl(fetchMock)).toBe("https://status.example.com/api/v2/summary.json");
    expect(getSecondRequestedUrl(fetchMock)).toBe("https://status.example.com/feed/rss");
  });

  it("honors explicit RSS item status before descriptive boilerplate text", async () => {
    const fetchMock = jest.fn(async () =>
      textResponse(`<?xml version="1.0" encoding="utf-8"?>
        <rss version="2.0">
          <channel>
            <title>Microsoft Admin Center Status</title>
            <item>
              <title>Microsoft Admin Center</title>
              <description>This site is updated when service issues are preventing tenant administrators from accessing Service health. Customers can also reference additional insights into widespread, active incidents.</description>
              <pubDate>Sat, 04 Apr 2026 04:33:00 Z</pubDate>
              <status>Available</status>
            </item>
          </channel>
        </rss>`)
    );
    global.fetch = fetchMock as typeof fetch;

    const service = {
      id: "microsoft365",
      name: "Microsoft 365",
      pageUrl: "https://status.cloud.microsoft/",
      rssUrl: "https://status.cloud.microsoft/api/feed/mac",
      type: "generic",
    } satisfies ServiceConfig;

    const status = await checkSingleService(service);

    expect(status.status).toBe("operational");
    expect(status.description).toBe("");
    expect(status.incidents).toEqual([]);
  });

  it("treats boilerplate incident wording without live issue context as operational", async () => {
    const fetchMock = jest.fn(async () =>
      textResponse(`<?xml version="1.0" encoding="utf-8"?>
        <rss version="2.0">
          <channel>
            <title>Status Feed</title>
            <item>
              <title>Status Information</title>
              <description>This site is updated when service issues are preventing tenant administrators from accessing Service health. Customers can also reference additional insights into widespread, active incidents.</description>
              <pubDate>Sat, 04 Apr 2026 04:33:00 Z</pubDate>
            </item>
          </channel>
        </rss>`)
    );
    global.fetch = fetchMock as typeof fetch;

    const service = {
      id: "boilerplate-service",
      name: "Boilerplate Service",
      pageUrl: "https://status.example.com/",
      rssUrl: "https://status.example.com/feed/rss",
      type: "generic",
    } satisfies ServiceConfig;

    const status = await checkSingleService(service);

    expect(status.status).toBe("operational");
    expect(status.description).toBe("");
    expect(status.incidents).toEqual([]);
  });

  it("still flags live issue wording when a feed describes an active incident", async () => {
    const fetchMock = jest.fn(async () =>
      textResponse(`<?xml version="1.0" encoding="utf-8"?>
        <rss version="2.0">
          <channel>
            <title>Status Feed</title>
            <item>
              <title>Active issue</title>
              <description>Users are currently experiencing elevated errors affecting admin center access.</description>
              <pubDate>Sat, 04 Apr 2026 04:33:00 Z</pubDate>
            </item>
          </channel>
        </rss>`)
    );
    global.fetch = fetchMock as typeof fetch;

    const service = {
      id: "active-issue-service",
      name: "Active Issue Service",
      pageUrl: "https://status.example.com/",
      rssUrl: "https://status.example.com/feed/rss",
      type: "generic",
    } satisfies ServiceConfig;

    const status = await checkSingleService(service);

    expect(status.status).toBe("degraded_performance");
    expect(status.incidents?.length).toBe(1);
  });

  it("handles Fastly-style RSS feeds without falling back on parser entity limits", async () => {
    const repeatedNbsp = "&nbsp;".repeat(1005);
    const fetchMock = jest.fn(async () =>
      textResponse(`<?xml version="1.0" encoding="utf-8"?>
        <rss version="2.0">
          <channel>
            <title>Fastly RSS</title>
            <item>
              <title>Informational update</title>
              <description>All other services are unaffected by this informational update.${repeatedNbsp}</description>
              <pubDate>Sat, 04 Apr 2026 04:33:00 GMT</pubDate>
              <link>https://status.example.com/incidents/incident-1</link>
            </item>
          </channel>
        </rss>`)
    );
    global.fetch = fetchMock as typeof fetch;

    const service = {
      id: "fastly-like-service",
      name: "Fastly-like Service",
      pageUrl: "https://status.example.com/",
      rssUrl: "https://status.example.com/rss",
      type: "generic",
    } satisfies ServiceConfig;

    const status = await checkSingleService(service);

    expect(status.status).toBe("operational");
    expect(status.description).toBe("");
    expect(status.incidents).toEqual([]);
  });

  it("strips encoded HTML from RSS incident updates before they reach embeds", async () => {
    const fetchMock = jest.fn(async () =>
      textResponse(`<?xml version="1.0" encoding="utf-8"?>
        <rss version="2.0">
          <channel>
            <title>Fastly RSS</title>
            <item>
              <title>Ghana (ACC) Rerouted Traffic</title>
              <description>&lt;p&gt;&lt;span style="font-size: 14px; font-family: Helvetica"&gt;Traffic in Ghana (ACC) has been temporarily rerouted.&lt;/span&gt;&lt;/p&gt;</description>
              <pubDate>Sat, 04 Apr 2026 16:33:00 GMT</pubDate>
              <link>https://status.example.com/incidents/incident-1</link>
            </item>
          </channel>
        </rss>`)
    );
    global.fetch = fetchMock as typeof fetch;

    const service = {
      id: "fastly-html-service",
      name: "Fastly",
      pageUrl: "https://status.example.com/",
      rssUrl: "https://status.example.com/rss",
      type: "generic",
    } satisfies ServiceConfig;

    const status = await checkSingleService(service);

    expect(status.status).toBe("operational");
    expect(status.incidents).toEqual([]);
    expect(status.description).toBe("");
  });

  it("keeps non-operational RSS updates as plain text instead of raw HTML markup", async () => {
    const fetchMock = jest.fn(async () =>
      textResponse(`<?xml version="1.0" encoding="utf-8"?>
        <rss version="2.0">
          <channel>
            <title>Fastly RSS</title>
            <item>
              <title>Ghana (ACC) Rerouted Traffic</title>
              <description>&lt;p&gt;&lt;span style="font-size: 14px; font-family: Helvetica"&gt;Traffic in Ghana (ACC) has been temporarily rerouted.&lt;/span&gt;&lt;br /&gt;All other services are unaffected.&lt;/p&gt;</description>
              <pubDate>Sat, 04 Apr 2026 16:33:00 GMT</pubDate>
              <link>https://status.example.com/incidents/incident-1</link>
            </item>
            <item>
              <title>Active performance issue</title>
              <description>Users are currently experiencing elevated errors.</description>
              <pubDate>Sat, 04 Apr 2026 16:34:00 GMT</pubDate>
              <link>https://status.example.com/incidents/incident-1</link>
            </item>
          </channel>
        </rss>`)
    );
    global.fetch = fetchMock as typeof fetch;

    const service = {
      id: "fastly-html-incident-service",
      name: "Fastly",
      pageUrl: "https://status.example.com/",
      rssUrl: "https://status.example.com/rss",
      type: "generic",
    } satisfies ServiceConfig;

    const status = await checkSingleService(service);

    expect(status.status).toBe("degraded_performance");
    expect(status.incidents).toHaveLength(1);
    expect(status.incidents?.[0]?.incident_updates?.map((update) => update.body)).toEqual(
      expect.arrayContaining([
        "Users are currently experiencing elevated errors.",
        "Traffic in Ghana (ACC) has been temporarily rerouted.\nAll other services are unaffected.",
      ])
    );
  });

  it("treats future scheduled RSS maintenance as operational instead of active maintenance", async () => {
    const fetchMock = jest.fn(async () =>
      textResponse(`<?xml version="1.0" encoding="utf-8"?>
        <rss version="2.0">
          <channel>
            <title>Stripe RSS</title>
            <item>
              <title>Scheduled maintenance for TWINT</title>
              <description>THIS IS A SCHEDULED EVENT May 12, 18:00 - 19:00 UTC Scheduled - TWINT has an upcoming scheduled maintenance.</description>
              <pubDate>Sat, 04 Apr 2026 16:33:00 GMT</pubDate>
              <status>Scheduled</status>
              <link>https://status.example.com/incidents/maintenance-1</link>
            </item>
          </channel>
        </rss>`)
    );
    global.fetch = fetchMock as typeof fetch;

    const service = {
      id: "stripe-scheduled-service",
      name: "Stripe",
      pageUrl: "https://status.example.com/",
      rssUrl: "https://status.example.com/rss",
      type: "generic",
    } satisfies ServiceConfig;

    const status = await checkSingleService(service);

    expect(status.status).toBe("operational");
    expect(status.description).toBe("");
    expect(status.incidents).toEqual([]);
  });

  it("checks direct Steam endpoints instead of fetching the SteamStat.us page", async () => {
    const fetchMock = jest.fn(async (url: string) => {
      switch (url) {
        case "https://store.steampowered.com/":
        case "https://steamcommunity.com/":
          return htmlResponse();
        case "https://api.steampowered.com/ISteamWebAPIUtil/GetServerInfo/v1/?format=json":
          return jsonResponse({ servertime: 1780053787, servertimestring: "Fri May 29 04:23:07 2026" });
        default:
          throw new Error(`Unexpected Steam probe URL: ${url}`);
      }
    });
    global.fetch = fetchMock as typeof fetch;

    const status = await checkSingleService(createSteamService());

    expect(status.status).toBe("operational");
    expect(status.description).toBe("");
    expect(status.incidents).toEqual([]);
    expect(getRequestedUrls(fetchMock)).toEqual([
      "https://store.steampowered.com/",
      "https://steamcommunity.com/",
      "https://api.steampowered.com/ISteamWebAPIUtil/GetServerInfo/v1/?format=json",
    ]);
    expect(getRequestedUrls(fetchMock)).not.toContain("https://steamstat.us/");
  });

  it("reports a partial Steam outage when one direct core probe has a concrete failure", async () => {
    const fetchMock = jest.fn(async (url: string) => {
      switch (url) {
        case "https://store.steampowered.com/":
          return htmlResponse("Service unavailable", 503);
        case "https://steamcommunity.com/":
          return htmlResponse();
        case "https://api.steampowered.com/ISteamWebAPIUtil/GetServerInfo/v1/?format=json":
          return jsonResponse({ servertime: 1780053787 });
        default:
          throw new Error(`Unexpected Steam probe URL: ${url}`);
      }
    });
    global.fetch = fetchMock as typeof fetch;

    const status = await checkSingleService(createSteamService());

    expect(status.status).toBe("partial_outage");
    expect(status.description).toBe("Steam Store: HTTP 503");
    expect(status.incidents).toHaveLength(1);
    expect(status.incidents?.[0]?.name).toBe("Steam component probe failing");
    expect(status.incidents?.[0]?.incident_updates?.map((update) => update.body)).toEqual(["Steam Store: HTTP 503"]);
  });

  it("reports a major Steam outage when every direct core probe has a concrete HTTP failure", async () => {
    const fetchMock = jest.fn(async (url: string) => {
      switch (url) {
        case "https://store.steampowered.com/":
          return htmlResponse("Service unavailable", 503);
        case "https://steamcommunity.com/":
          return htmlResponse("Bad gateway", 502);
        case "https://api.steampowered.com/ISteamWebAPIUtil/GetServerInfo/v1/?format=json":
          return jsonResponse({ error: "server error" }, 500);
        default:
          throw new Error(`Unexpected Steam probe URL: ${url}`);
      }
    });
    global.fetch = fetchMock as typeof fetch;

    const status = await checkSingleService(createSteamService());

    expect(status.status).toBe("major_outage");
    expect(status.description).toBe("All Steam probes failed");
    expect(status.incidents).toHaveLength(1);
    expect(status.incidents?.[0]?.name).toBe("Steam probes failing");
    expect(status.incidents?.[0]?.incident_updates?.map((update) => update.body)).toEqual([
      "Steam Store: HTTP 503",
      "Steam Community: HTTP 502",
      "Steam Web API: HTTP 500",
    ]);
  });

  it("keeps all-network Steam probe failures as unknown unreachable instead of a real outage", async () => {
    const fetchMock = jest.fn(async () => {
      throw new Error("network blocked");
    });
    global.fetch = fetchMock as typeof fetch;

    const status = await checkSingleService(createSteamService());

    expect(status.status).toBe("unknown");
    expect(status.description).toBe("Unreachable");
    expect(status.incidents).toEqual([]);
  });
});
