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
await checkBatchSearch();
await checkSearchCreatesSerpZone();
await checkDiscoverAndSourceRead();
await checkDatasetPolling();
await checkPackageCollector();
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
      { link: "https://example.com/incomplete" },
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

async function checkSearchCreatesSerpZone() {
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
      return json({ organic: [] });
    }),
    {},
  );

  await adapter.search.search(
    {
      queries: [{ query: "Bright Data", engine: "google", locale: "en-US" }],
    },
    context,
  );
  assert(
    requests.map(({ path }) => path).join(",") ===
      "/zone/get_active_zones,/zone,/request" &&
      (requests[1]?.body as { zone?: { name?: string } })?.zone?.name ===
        "bright_mcp_serp" &&
      (requests[2]?.body as { zone?: string })?.zone === "bright_mcp_serp",
    "Search did not create and use a dedicated SERP zone.",
  );
}

async function checkBatchSearch() {
  const adapter = createBrightDataWebAdapter(
    gateway(async (input, init) => {
      const url = new URL(String(input));
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (url.pathname === "/request") {
        const query = new URL(body.url).searchParams.get("q") ?? "";
        return json({ organic: [{ title: query, link: `https://example.com/${query}` }] });
      }
      return new Response(null, { status: 404 });
    }),
    { serp: "fixture-serp", unlocker: "fixture-unlocker" },
  );
  const batch = await adapter.search.search({
    queries: [
      { query: "one", engine: "google", locale: "en-US" },
      { query: "two", engine: "google", locale: "en-US" },
    ],
  }, context);
  assert(
    batch.searches.map(({ query }) => query).join(",") === "one,two",
    "Batch search did not preserve query order.",
  );
}

async function checkDiscoverAndSourceRead() {
  const requests: Array<{ path: string; method?: string; body?: unknown }> = [];
  const adapter = createBrightDataWebAdapter(
    gateway(async (input, init) => {
      const url = new URL(String(input));
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      requests.push({ path: url.pathname, method: init?.method, body });
      if (url.pathname === "/discover" && init?.method === "POST") {
        return json({ task_id: "discover-task" }, 202);
      }
      if (url.pathname === "/discover") {
        return json({
          status: "completed",
          results: [{
            link: "https://example.com/source",
            title: "Primary source",
            description: "Relevant documentation",
            relevance_score: 0.91,
          }],
        });
      }
      if (url.pathname === "/request") {
        return new Response("<!doctype html><title>Source</title>");
      }
      return new Response(null, { status: 404 });
    }),
    { serp: "fixture-serp", unlocker: "fixture-unlocker" },
  );

  const discovered = await adapter.discover.discover({
    query: "documentation",
    intent: "Find the primary source",
    limit: 1,
    country: "us",
    publishedAfter: "2026-01-01",
  }, context);
  assert(
    discovered.results[0]?.relevanceScore === 0.91 &&
      requests[0]?.path === "/discover" &&
      (requests[0]?.body as { country?: string })?.country === "US",
    "Discover did not trigger, poll, and normalize the ranked shortlist.",
  );

  const source = await adapter.read.read({
    urls: ["https://example.com/source"],
    representation: "source",
  }, context);
  const readBody = requests.find(({ path }) => path === "/request")?.body as
    | { data_format?: string }
    | undefined;
  assert(
    source[0]?.mediaType === "text/html" &&
      source[0]?.content?.startsWith("<!doctype html>") &&
      readBody?.data_format === undefined,
    "Source reading did not preserve exact HTML through Web Unlocker.",
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
      if (url.pathname === "/datasets/gd_lwdb4vjm1ehb499uxs/metadata") {
        return json({ id: "gd_lwdb4vjm1ehb499uxs", fields: { title: { type: "text" } } });
      }
      if (url.pathname === "/datasets/v3/trigger") {
        return json({ snapshot_id: "fixture-snapshot" }, 202);
      }
      if (url.pathname === "/datasets/v3/progress/fixture-snapshot") {
        return json({
          snapshot_id: "fixture-snapshot",
          status: "ready",
          dataset_size: 1,
        });
      }
      if (url.pathname === "/datasets/v3/snapshot/fixture-snapshot") {
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
      datasetId: "marketplace:gd_lwdb4vjm1ehb499uxs",
      operation: "collect",
      arguments: { query: "fixture", pages: 1, acknowledgeCost: true },
    },
    context,
  );

  assert(
    paths.join(",") ===
      "/datasets/list,/datasets/gd_lwdb4vjm1ehb499uxs/metadata,/datasets/v3/trigger,/datasets/v3/progress/fixture-snapshot,/datasets/v3/snapshot/fixture-snapshot",
    "Dataset execution did not trigger, poll, and download in order.",
  );
  assert(
    result.rows[0]?.title === "Fixture product" &&
      result.rowRefs.length === result.rows.length,
    "Dataset polling did not produce the canonical bounded result.",
  );
}

async function checkPackageCollector() {
  let triggerBody: unknown;
  const adapter = createBrightDataDatasetAdapter(
    gateway(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/datasets/list") return json([]);
      if (path === "/datasets/v3/trigger") {
        triggerBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        return json({ snapshot_id: "package-snapshot" }, 202);
      }
      if (path === "/datasets/v3/progress/package-snapshot") {
        return json({ status: "ready", dataset_size: 1 });
      }
      if (path === "/datasets/v3/snapshot/package-snapshot") {
        return json([{ name: "langchain-brightdata", version: "1.0.0" }]);
      }
      return new Response(null, { status: 404 });
    }),
    new LocalResultStore(),
  );

  const found = await adapter.catalog.find("Python PyPI package", 3, context);
  const definition = found.find(({ id }) => id === "marketplace:gd_mk57kc3t1wwgmnepp9");
  assert(
    JSON.stringify(definition?.operations[0]?.inputSchema).includes("packageName"),
    "Marketplace discovery omitted the executable PyPI package schema.",
  );
  const result = await adapter.runner.run({
    datasetId: "marketplace:gd_mk57kc3t1wwgmnepp9",
    operation: "collect",
    arguments: { packageName: "langchain-brightdata", acknowledgeCost: true },
  }, context);
  assert(
    (triggerBody as Array<{ package_name?: string }>)?.[0]?.package_name ===
      "langchain-brightdata" && result.rows[0]?.version === "1.0.0",
    "PyPI package discovery did not execute its exact upstream collector schema.",
  );
}

async function checkMarketplaceAndDeepLookup() {
  let deepTriggers = 0;
  let previewCount = 0;
  const searchBodies: Array<{ search_after?: unknown[] }> = [];
  const resultStore = new LocalResultStore();
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
      if (path.startsWith("/datasets/search/")) {
        const body = typeof init?.body === "string"
          ? JSON.parse(init.body) as { search_after?: unknown[] }
          : {};
        searchBodies.push(body);
        const offset = body.search_after ? 10 : 0;
        return json({
          hits: Array.from(
            { length: offset ? 8 : 10 },
            (_, index) => ({ name: `Synchronous company ${offset + index + 1}` }),
          ),
          total_hits: 18,
          search_after: offset ? undefined : ["next-page"],
        });
      }
      if (path === "/datasets/filter") return json({ snapshot_id: "filtered-snapshot" });
      if (path === "/datasets/v3/progress/filtered-snapshot") return json({
        snapshot_id: "filtered-snapshot", status: "ready", dataset_size: 1, cost: 0.01,
      });
      if (path === "/datasets/v3/snapshot/filtered-snapshot") {
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
    resultStore,
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
  const known = await adapter.catalog.describe(
    "marketplace:gd_l1vikfnt1wgvvqz95w",
    context,
  );
  assert(
    known.operations.map(({ kind }) => kind).join(",") === "collect,search",
    "Known live datasets did not merge collection and Marketplace search under one ID.",
  );
  const searched = await adapter.runner.run({
    datasetId: "marketplace:gd_l1vikfnt1wgvvqz95w",
    operation: "search",
    arguments: {
      filter: { name: "name", operator: "includes", value: "company" },
      limit: 10,
      acknowledgeCost: true,
    },
  }, context);
  assert(
    searched.rows[0]?.name === "Synchronous company 1" &&
      searched.page.totalRows === 18 &&
      searched.page.nextResourceUri,
    "Supported Marketplace search did not retain its upstream continuation.",
  );
  const firstPageToken = searched.page.nextResourceUri.split("/").at(-1)!;
  const firstPage = await resultStore.readPage(firstPageToken, context);
  assert(
    firstPage.rows.length === 2 && firstPage.page.nextResourceUri,
    "Marketplace continuation did not finish the cached upstream page.",
  );
  const secondPage = await resultStore.readPage(
    firstPage.page.nextResourceUri.split("/").at(-1)!,
    context,
  );
  assert(
    secondPage.rows.length === 8 &&
      secondPage.page.totalRows === 18 &&
      !secondPage.page.nextResourceUri &&
      JSON.stringify(searchBodies[1]?.search_after) === JSON.stringify(["next-page"]),
    "Marketplace continuation did not fetch the next upstream cursor page.",
  );
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
