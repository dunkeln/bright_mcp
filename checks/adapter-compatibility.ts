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
await checkZoneCreation();
await checkDatasetPolling();
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

async function checkZoneCreation() {
  const requests: Array<{ path: string; body?: unknown }> = [];
  const adapter = createBrightDataWebAdapter(
    gateway(async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push({
        path,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      if (path === "/zone/get_active_zones") return json([]);
      if (path === "/zone") return json({});
      return json({ organic: [] });
    }),
    {},
  );

  await adapter.search.search(
    { query: "Bright Data", engine: "google", locale: "en-US" },
    context,
  );
  const creation = requests.find(({ path }) => path === "/zone")?.body as {
    zone?: { name?: string };
    plan?: { serp?: boolean };
  } | undefined;
  assert(
    requests.map(({ path }) => path).join(",") ===
      "/zone/get_active_zones,/zone,/request" &&
      creation?.zone?.name === "bright_mcp_serp" &&
      creation.plan?.serp === true,
    "Missing SERP zones were not created before search.",
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
    { query: "Bright Data", engine: "google", locale: "en-US" },
    context,
  );
}

async function checkDatasetPolling() {
  const paths: string[] = [];
  const adapter = createBrightDataDatasetAdapter(
    gateway(async (input) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname === "/datasets/v3/scrape") {
        return json({ snapshot_id: "fixture-snapshot" }, 202);
      }
      if (url.pathname === "/datasets/v3/progress/fixture-snapshot") {
        return json({
          snapshot_id: "fixture-snapshot",
          dataset_id: "fixture-dataset",
          status: "ready",
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
      datasetId: "amazon-products-search",
      operation: "search",
      arguments: { query: "fixture", pages: 1 },
    },
    context,
  );

  assert(
    paths.join(",") ===
      "/datasets/v3/scrape,/datasets/v3/progress/fixture-snapshot,/datasets/v3/snapshot/fixture-snapshot",
    "Dataset execution did not trigger, poll, and download in order.",
  );
  assert(
    result.rows[0]?.title === "Fixture product" &&
      result.rowRefs.length === result.rows.length,
    "Dataset polling did not produce the canonical bounded result.",
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
