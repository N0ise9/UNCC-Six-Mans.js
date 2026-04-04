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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
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

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function getFirstRequestedUrl(fetchMock: jest.Mock): string | undefined {
    return fetchMock.mock.calls[0]?.[0] as string | undefined;
  }

  function getSecondRequestedUrl(fetchMock: jest.Mock): string | undefined {
    return fetchMock.mock.calls[1]?.[0] as string | undefined;
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
});
