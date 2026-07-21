import { createBrightDataDatasetAdapter } from "../src/adapters/brightdata/datasets";
import {
  BrightDataGateway,
  type FetchFunction,
} from "../src/adapters/brightdata/gateway";
import { createBrightDataWebAdapter } from "../src/adapters/brightdata/web";
import { LocalResultStore } from "../src/adapters/result-store";
import { CapabilityError, type RequestContext } from "../src/core/contracts";
import { assert } from "./compatibility-support";

const secret = "fixture-secret-that-must-not-leak";
const context: RequestContext = {
  principalId: "adapter-check",
  requestId: "adapter-check-request",
};
const records: Array<Record<string, unknown>> = [];

await checkSearchShapes();
await checkBatchAndDiscover();
await checkSerpZoneCreation();
await checkDatasetPolling();
await checkMarketplaceAndDeepLookup();
await checkExpectedFailures();

assert(
  !JSON.stringify(records).includes(secret),
  "Adapter logs exposed the Bright Data credential.",
);
console.log("Bright Data adapter compatibility passed.");

async function checkSearchShapes() {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const organic = await searchWith({
    organic: [
      {
        title: "Bright Data",
        link: "https://brightdata.com/",
        description: "Web data platform",
      },
    ],
  }, requests);
  const results = await searchWith({
    results: [
      {
        title: "Bright Data",
        url: "https://brightdata.com/",
        snippet: "Web data platform",
      },
    ],
  }, requests);

  assert(
    JSON.stringify(organic) === JSON.stringify(results),
    "Equivalent upstream SERP envelopes changed the canonical search result.",
  );
  assert(
    requests.every(
      (request) =>
        request.authorization === `Bearer ${secret}` &&
        !request.url.includes(secret),
    ),
    "The gateway did not isolate credentials to the authorization header.",
  );
}

async function checkSerpZoneCreation() {
  const requests: Array<{ path: string; body?: unknown }> = [];
  const adapter = createBrightDataWebAdapter(
    gateway(async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push({
        path,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      if (path === "/zone/get_active_zones") {
        return json([{ name: "fixture-unlocker", type: "unblocker" }]);
      }
      if (path === "/zone") return json({ name: "bright_mcp_serp" });
      return json({ organic: [] });
    }),
    {},
  );

  await adapter.search.search(
    {
      queries: [{ query: "Bright Data", engine: "google", locale: "en-US" }],
      depth: "fast",
      includeContent: false,
    },
    context,
  );
  assert(
    requests.map(({ path }) => path).join(",") ===
      "/zone/get_active_zones,/zone,/request" &&
      (requests[2]?.body as { zone?: string })?.zone === "bright_mcp_serp",
    "Search did not create and use its deterministic SERP zone.",
  );
}

async function checkBatchAndDiscover() {
  const adapter = createBrightDataWebAdapter(
    gateway(async (input, init) => {
      const url = new URL(String(input));
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (url.pathname === "/request") {
        const query = new URL(body.url).searchParams.get("q") ?? "";
        return json({ organic: [{ title: query, link: `https://example.com/${query}` }] });
      }
      if (init?.method === "POST") return json({ task_id: "discover-task" });
      return json({
        status: "done",
        results: [{
          title: "Ranked result",
          link: "https://example.com/ranked",
          description: "Ranked summary",
          content: "# Full content",
        }],
      });
    }),
    { serp: "fixture-serp", unlocker: "fixture-unlocker" },
  );
  const batch = await adapter.search.search({
    queries: [
      { query: "one", engine: "google", locale: "en-US" },
      { query: "two", engine: "google", locale: "en-US" },
    ],
    depth: "fast",
    includeContent: false,
  }, context);
  assert(
    batch.searches.map(({ query }) => query).join(",") === "one,two",
    "Batch search did not preserve query order.",
  );
  const ranked = await adapter.search.search({
    queries: [{ query: "research", engine: "google", locale: "en-US" }],
    depth: "ranked",
    includeContent: true,
  }, context);
  assert(
    ranked.searches[0]?.results[0]?.content === "# Full content",
    "Discover research did not retain optional page content.",
  );
}

async function searchWith(
  envelope: unknown,
  requests: Array<{ url: string; authorization: string | null }>,
) {
  const adapter = createBrightDataWebAdapter(
    gateway(async (input, init) => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return json(envelope);
    }),
    { serp: "fixture-serp", unlocker: "fixture-unlocker" },
  );
  return adapter.search.search(
    {
      queries: [{ query: "Bright Data", engine: "google", locale: "en-US" }],
      depth: "fast",
      includeContent: false,
    },
    context,
  );
}

async function checkDatasetPolling() {
  const paths: string[] = [];
  const adapter = createBrightDataDatasetAdapter(
    gateway(async (input) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname === "/datasets/list") {
        return json([{ id: "gd_lwdb4vjm1ehb499uxs", name: "Amazon product search", size: 100 }]);
      }
      if (url.pathname === "/datasets/v3/trigger") {
        return json({ snapshot_id: "fixture-snapshot" }, 202);
      }
      if (url.pathname === "/datasets/snapshots/fixture-snapshot") {
        return json({
          id: "fixture-snapshot",
          status: "ready",
          dataset_size: 1,
        });
      }
      if (url.pathname === "/datasets/snapshots/fixture-snapshot/download") {
        return json([
          {
            title: "Fixture product",
            asin: "FIXTURE1",
            price: 12.5,
          },
        ]);
      }
      return new Response(null, { status: 404 });
    }),
    new LocalResultStore(),
  );

  const result = await adapter.runner.run(
    {
      datasetId: "collector:amazon-products-search",
      operation: "search",
      arguments: { query: "fixture", pages: 1, acknowledgeCost: true },
    },
    context,
  );

  assert(
    paths.join(",") ===
      "/datasets/list,/datasets/v3/trigger,/datasets/snapshots/fixture-snapshot,/datasets/snapshots/fixture-snapshot/download",
    "Dataset execution did not trigger, poll, and download in order.",
  );
  assert(
    result.rows[0]?.title === "Fixture product" &&
      result.rowRefs.length === result.rows.length,
    "Dataset polling did not produce the canonical bounded result.",
  );
}

async function checkMarketplaceAndDeepLookup() {
  let deepTriggers = 0;
  let previewCount = 0;
  const adapter = createBrightDataDatasetAdapter(
    gateway(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/datasets/list") return json([
        { id: "gd_l1vikfnt1wgvvqz95w", name: "LinkedIn companies", size: 100 },
        { id: "gd_custom", name: "Custom marketplace records", size: 1_000 },
      ]);
      if (path.endsWith("/metadata")) return json({
        id: path.includes("gd_custom") ? "gd_custom" : "gd_l1vikfnt1wgvvqz95w",
        fields: { name: { type: "text", active: true, description: "Record name" } },
      });
      if (path.startsWith("/datasets/search/")) return json({
        hits: [{ name: "Synchronous company" }], total_hits: 1,
      });
      if (path === "/datasets/filter") return json({ snapshot_id: "filtered-snapshot" });
      if (path === "/datasets/snapshots/filtered-snapshot") return json({
        id: "filtered-snapshot", status: "ready", dataset_size: 1, cost: 0.01,
      });
      if (path === "/datasets/snapshots/filtered-snapshot/download") {
        return json([{ name: "Filtered record" }]);
      }
      if (path === "/datasets/deep_lookup/v1/preview" && init?.method === "POST") {
        previewCount += 1;
        return json({ preview_id: `preview-${previewCount}`, columns: [] });
      }
      if (path.startsWith("/datasets/deep_lookup/v1/preview/")) return json({
        preview_id: path.split("/").at(-1),
        status: "completed",
        sample_data: [{ company: "Preview company" }],
        columns: Array.from({ length: 11 }, (_, index) => ({ name: `field_${index}` })),
      });
      if (path === "/datasets/deep_lookup/v1/trigger") {
        deepTriggers += 1;
        return json({ request_id: "deep-request", max_cost: "$2.10" });
      }
      if (path === "/datasets/deep_lookup/v1/request/deep-request") return json({
        request_id: "deep-request",
        status: "completed",
        step: "done",
        matched_records: 1,
        total_cost: "$1.00",
        data: [{ company: "Full company" }],
      });
      return new Response(null, { status: 404 });
    }),
    new LocalResultStore(),
  );

  const found = await adapter.catalog.find("custom marketplace records", 10, context);
  assert(
    found.some(({ id }) => id === "marketplace:gd_custom"),
    "The live account catalog was not searchable.",
  );
  const definition = await adapter.catalog.describe("marketplace:gd_custom", context);
  assert(
    definition.description.includes("name (text)"),
    "Marketplace metadata did not reach the executable definition.",
  );
  const sync = await adapter.runner.run({
    datasetId: "marketplace:gd_l1vikfnt1wgvvqz95w",
    operation: "search",
    arguments: {
      filter: { name: "name", operator: "includes", value: "company" },
      limit: 10,
      acknowledgeCost: true,
    },
  }, context);
  assert(sync.rows[0]?.name === "Synchronous company", "Marketplace Search was not routed synchronously.");
  const filtered = await adapter.runner.run({
    datasetId: "marketplace:gd_custom",
    operation: "search",
    arguments: {
      filter: { name: "name", operator: "includes", value: "record" },
      limit: 10,
      acknowledgeCost: true,
    },
  }, context);
  assert(
    filtered.rows[0]?.name === "Filtered record" && filtered.page.totalRows === 1,
    "Marketplace Filter did not produce an upstream-backed snapshot result.",
  );
  const preview = await adapter.runner.run({
    datasetId: "deep-web-research",
    operation: "search",
    arguments: { query: "AI companies", limit: 2, preview: true },
  }, context);
  assert(preview.rows[0]?.company === "Preview company", "Deep Lookup preview failed.");
  await expectCode(adapter.runner.run({
    datasetId: "deep-web-research",
    operation: "search",
    arguments: {
      query: "AI companies", limit: 2, preview: false,
      acknowledgeCost: true, maxCostUsd: 2,
    },
  }, context), "cost_cap_too_low");
  const full = await adapter.runner.run({
    datasetId: "deep-web-research",
    operation: "search",
    arguments: {
      query: "AI companies", limit: 2, preview: false,
      acknowledgeCost: true, maxCostUsd: 3,
    },
  }, context);
  assert(
    full.rows[0]?.company === "Full company" && deepTriggers === 1,
    "Deep Lookup full execution ignored its pre-trigger cost gate.",
  );
}

async function checkExpectedFailures() {
  await expectCode(
    gateway(async () => new Response("not-json")).requestJson(
      { method: "GET", path: "/fixture" },
      context,
    ),
    "malformed_upstream_response",
  );
  await expectCode(
    gateway(async () => new Response(null, { status: 402 })).requestJson(
      { method: "GET", path: "/fixture" },
      context,
    ),
    "brightdata_quota_exhausted",
  );
  await expectCode(
    gateway(async () => new Response(null, { status: 401 })).requestJson(
      { method: "GET", path: "/fixture" },
      context,
    ),
    "brightdata_authentication_failed",
  );
  await expectCode(
    gateway(abortOnlyFetch).requestJson(
      { method: "GET", path: "/fixture", timeoutMs: 10 },
      context,
    ),
    "upstream_timeout",
  );

  const controller = new AbortController();
  controller.abort();
  await expectCode(
    gateway(abortOnlyFetch).requestJson(
      { method: "GET", path: "/fixture", timeoutMs: 1_000 },
      { ...context, signal: controller.signal },
    ),
    "cancelled",
  );
}

function gateway(fetcher: FetchFunction) {
  return new BrightDataGateway({
    credentials: async () => ({ apiKey: secret }),
    fetch: fetcher,
    logger: {
      info: (record) => records.push(record),
      error: (record) => records.push(record),
    },
  });
}

async function abortOnlyFetch(
  _input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const signal = init?.signal;
  if (!signal) throw new Error("The gateway omitted its bounded signal.");
  if (signal.aborted) throw signal.reason;
  return new Promise<Response>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status });
}

async function expectCode(operation: Promise<unknown>, expected: string) {
  try {
    await operation;
  } catch (error) {
    assert(error instanceof CapabilityError, `${expected} was not actionable.`);
    assert(
      error.code === expected,
      `Expected ${expected}, received ${error.code}.`,
    );
    return;
  }
  throw new Error(`Expected ${expected}, but the operation succeeded.`);
}
