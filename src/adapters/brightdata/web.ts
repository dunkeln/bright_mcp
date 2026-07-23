import { LRUCache } from "lru-cache";
import { remark } from "remark";
import strip from "strip-markdown";
import { z } from "zod";
import { CapabilityError, type RequestContext } from "../../core/contracts";
import type {
  DiscoverPort,
  ItemFailure,
  ReadPort,
  SearchPort,
  SearchQuery,
  SingleSearchResponse,
} from "../../core/web";
import { BrightDataGateway, pollBrightData } from "./gateway";

const SEARCH_PAGE_SIZE = 10;
const MAX_SEARCH_OFFSET = 90;
const SEARCH_DEADLINE_MS = 21_000;
const SEARCH_RETRY_DELAYS_MS = [300, 900] as const;
const READ_LATENCY_SAMPLES = 20;
const READ_LATENCY_WARMUP = 3;
const READ_TIMEOUT_DEFAULT_MS = 15_000;
const READ_TIMEOUT_MIN_MS = 8_000;
const READ_TIMEOUT_MAX_MS = 30_000;
const organicResultSchema = z.object({
  title: z.string().optional(),
  link: z.url().optional(),
  url: z.url().optional(),
  description: z.string().optional(),
  snippet: z.string().optional(),
  type: z.string().optional(),
});

const searchEnvelopeSchema = z.object({
  organic: z.array(organicResultSchema).optional(),
  results: z.array(organicResultSchema).optional(),
});
const discoverTriggerSchema = z.object({ task_id: z.string().min(1) });
const discoverResultSchema = z.object({
  link: z.url(),
  title: z.string().optional(),
  description: z.string().optional(),
  relevance_score: z.number().optional(),
}).passthrough();
const discoverPollSchema = z.object({
  status: z.string().optional(),
  results: z.array(discoverResultSchema).optional(),
  error: z.string().optional(),
}).passthrough();
const activeZonesSchema = z.array(z.object({
  name: z.string().min(1).optional(),
  zone: z.string().min(1).optional(),
  type: z.string().optional(),
  zone_type: z.string().optional(),
  plan: z.object({ serp: z.boolean().optional() }).optional(),
}).transform((zone, context) => {
  const name = zone.name ?? zone.zone;
  const type = zone.type ?? zone.zone_type;
  if (!name || !type) {
    context.addIssue({ code: "custom", message: "Zone name and type are required." });
    return z.NEVER;
  }
  return { name, type, plan: zone.plan };
}));

export function createBrightDataWebAdapter(
  gateway: BrightDataGateway,
  zones: { serp?: string; unlocker?: string },
): { search: SearchPort; discover: DiscoverPort; read: ReadPort } {
  const activeZones = new LRUCache<string, z.infer<typeof activeZonesSchema>>({
    max: 1_000,
    ttl: 5 * 60_000,
  });
  // ponytail: process-local history; persist only if restarts measurably hurt timeout quality.
  const readLatencies = new LRUCache<string, number[]>({
    max: 5_000,
    ttl: 60 * 60_000,
  });
  return {
    search: {
      async search(input, context) {
        const serpZone = await resolveZone(
          gateway,
          activeZones,
          zones.serp,
          "serp",
          context,
        );
        return {
          searches: await Promise.all(input.queries.map(async (query) => {
            try {
              const result = await searchSerp(
                gateway,
                activeZones,
                serpZone,
                query,
                context,
              );
              return {
                query: query.query,
                retrievedAt: new Date().toISOString(),
                ...result,
              };
            } catch (error) {
              const failure = error instanceof CapabilityError
                ? error
                : new CapabilityError("upstream_unavailable", "Bright Data search failed.", true);
              if (failure.code === "brightdata_connection_required") throw failure;
              return {
                query: query.query,
                retrievedAt: new Date().toISOString(),
                results: [],
                error: failureRecord(failure),
              };
            }
          })),
        };
      },
    },
    discover: {
      async discover(input, context) {
        const trigger = parseDiscover(
          discoverTriggerSchema,
          (await gateway.requestJson({
            method: "POST",
            path: "/discover",
            body: {
              query: input.query,
              intent: input.intent,
              country: input.country?.toUpperCase(),
              city: input.city,
              language: input.language,
              num_results: input.limit,
              filter_keywords: input.requiredKeywords,
              start_date: input.publishedAfter,
              end_date: input.publishedBefore,
              remove_duplicates: true,
              format: "json",
            },
            timeoutMs: 30_000,
          }, context)).data,
        );
        const completed = await pollBrightData({
          context,
          deadlineMs: 60_000,
          intervalMs: 1_000,
          load: async () => parseDiscover(
            discoverPollSchema,
            (await gateway.requestJson({
              method: "GET",
              path: "/discover",
              query: { task_id: trigger.task_id },
              timeoutMs: 20_000,
            }, context)).data,
          ),
          state: (value) => value.status === "failed"
            ? "failed"
            : ["processing", "pending", "running", "queued", "starting"]
                .includes(value.status ?? "")
              ? "pending"
              : "ready",
          failed: (value) => new CapabilityError(
            "upstream_job_failed",
            value.error ?? "Bright Data Discover could not rank the requested sources.",
            false,
            "Narrow the discovery goal or constraints and retry once.",
          ),
          timeout: new CapabilityError(
            "upstream_timeout",
            "Bright Data Discover did not finish within one minute.",
            true,
            "Retry once with fewer requested results.",
          ),
        });
        return {
          results: (completed.results ?? []).slice(0, input.limit).map((result) => ({
            title: result.title ?? result.link,
            url: result.link,
            summary: result.description ?? "",
            relevanceScore: result.relevance_score,
          })),
        };
      },
    } satisfies DiscoverPort,
    read: {
      async read(input, context) {
        const zone = await resolveZone(
          gateway,
          activeZones,
          zones.unlocker,
          "unlocker",
          context,
        );
        return Promise.all(
          input.urls.map(async (url, itemIndex) => {
            const startedAt = performance.now();
            const hostname = new URL(url).hostname;
            const latencyKey = `${context.principalId}\0${hostname}`;
            const timeoutMs = readTimeout(readLatencies.get(latencyKey));
            let outcome = "success";
            let errorCode: string | undefined;
            try {
              const response = await gateway.requestText(
                {
                  method: "POST",
                  path: "/request",
                  body: {
                    zone,
                    url,
                    format: "raw",
                    ...(input.representation === "readable"
                      ? { data_format: "markdown" }
                      : {}),
                  },
                  timeoutMs,
                  maxAttempts: 1,
                },
                context,
              );
              const rawContent = unwrapBody(response.data);
              const content = input.representation === "readable"
                ? String(await remark().use(strip, {
                    keep: ["link", "linkReference", "code", "inlineCode"],
                  }).process(rawContent))
                : rawContent;
              if (/^this endpoint is not supported[.!]?$/i.test(content.trim())) {
                throw new CapabilityError(
                  "unsupported_upstream_endpoint",
                  "Bright Data could not read this URL with the configured Web Unlocker.",
                  false,
                  "Use the search result summary or verify the account's Web Unlocker zone.",
                );
              }
              return {
                url,
                representation: input.representation,
                mediaType: input.representation === "source"
                  ? "text/html" as const
                  : "text/markdown" as const,
                content,
              };
            } catch (error) {
              const failure = error instanceof CapabilityError
                ? error
                : new CapabilityError(
                    "upstream_unavailable",
                    "Bright Data could not scrape this URL.",
                    true,
                    "Retry the failed URL once.",
                  );
              outcome = "error";
              errorCode = failure.code;
              if (failure.code === "brightdata_connection_required") throw failure;
              return {
                url,
                representation: input.representation,
                mediaType: input.representation === "source"
                  ? "text/html" as const
                  : "text/markdown" as const,
                error: failureRecord(failure),
              };
            } finally {
              const durationMs = Math.round(performance.now() - startedAt);
              if (outcome === "success" || errorCode === "upstream_timeout") {
                observeReadLatency(
                  readLatencies,
                  latencyKey,
                  errorCode === "upstream_timeout" ? timeoutMs : durationMs,
                );
              }
              gateway.logInfo({
                operation: "read_web_item",
                requestId: context.requestId,
                itemIndex,
                hostname,
                urlHash: new Bun.CryptoHasher("sha256")
                  .update(url)
                  .digest("hex")
                  .slice(0, 16),
                durationMs,
                timeoutMs,
                outcome,
                errorCode,
              });
            }
          }),
        );
      },
    },
  };
}

function readTimeout(samples: number[] | undefined) {
  if (!samples || samples.length < READ_LATENCY_WARMUP) {
    return READ_TIMEOUT_DEFAULT_MS;
  }
  const sorted = samples.toSorted((left, right) => left - right);
  const p90 = sorted[Math.ceil(sorted.length * 0.9) - 1]!;
  return Math.min(
    READ_TIMEOUT_MAX_MS,
    Math.max(READ_TIMEOUT_MIN_MS, Math.ceil(p90 * 1.5)),
  );
}

function observeReadLatency(
  cache: LRUCache<string, number[]>,
  key: string,
  durationMs: number,
) {
  cache.set(key, [
    ...(cache.get(key) ?? []).slice(-(READ_LATENCY_SAMPLES - 1)),
    durationMs,
  ]);
}

function parseDiscover<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new CapabilityError(
      "malformed_upstream_response",
      "Bright Data returned an unexpected Discover response.",
      false,
      "Retry once. If this persists, report the request ID.",
    );
  }
  return parsed.data;
}

async function searchSerp(
  gateway: BrightDataGateway,
  cache: LRUCache<string, z.infer<typeof activeZonesSchema>>,
  configuredZone: string | undefined,
  input: SearchQuery,
  context: RequestContext,
): Promise<SingleSearchResponse> {
  const zone = await resolveZone(gateway, cache, configuredZone, "serp", context);
  const offset = parseCursor(input.cursor);
  const deadline = Date.now() + SEARCH_DEADLINE_MS;
  let envelope: z.infer<typeof searchEnvelopeSchema> | undefined;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw searchTimeout();
      const response = await gateway.requestJson(
        {
          method: "POST",
          path: "/request",
          body: {
            zone,
            url: searchUrl(input, offset),
            format: "raw",
            data_format: "parsed_light",
          },
          timeoutMs: remainingMs,
          maxAttempts: 1,
        },
        context,
        parseSearchEnvelope,
      );
      envelope = response.data;
      break;
    } catch (error) {
      if (
        !(error instanceof CapabilityError) ||
        error.code !== "malformed_upstream_response"
      ) throw error;
      if (attempt === 3) throw malformedSearch(true, context.requestId);
      await waitForSearchRetry(attempt, deadline, context);
    }
  }
  if (!envelope) throw malformedSearch(true, context.requestId);
  const results = (envelope.organic ?? envelope.results ?? [])
    .filter((item) => !item.type || item.type === "organic")
    .flatMap((item) => {
      const url = item.link ?? item.url;
      return url && item.title
        ? [{ title: item.title, url, summary: item.description ?? item.snippet ?? "" }]
        : [];
    })
    .slice(0, SEARCH_PAGE_SIZE);
  return {
    results,
    nextCursor: results.length === SEARCH_PAGE_SIZE && offset < MAX_SEARCH_OFFSET
      ? `search_${offset + SEARCH_PAGE_SIZE}`
      : undefined,
  };
}

function parseSearchEnvelope(value: unknown) {
  const parsed = searchEnvelopeSchema.safeParse(unwrapJsonBody(value));
  if (!parsed.success || (!parsed.data.organic && !parsed.data.results)) {
    throw malformedSearch();
  }
  return parsed.data;
}

async function waitForSearchRetry(
  attempt: number,
  deadline: number,
  context: RequestContext,
) {
  const baseDelay = SEARCH_RETRY_DELAYS_MS[attempt - 1]!;
  const delayMs = Math.round(baseDelay * (0.8 + Math.random() * 0.4));
  const remainingMs = deadline - Date.now();
  if (remainingMs <= delayMs) throw malformedSearch(true, context.requestId);
  await Bun.sleep(delayMs);
  if (context.signal?.aborted) {
    throw new CapabilityError("cancelled", "The Bright Data search was cancelled.");
  }
}

async function resolveZone(
  gateway: BrightDataGateway,
  cache: LRUCache<string, z.infer<typeof activeZonesSchema>>,
  configured: string | undefined,
  kind: "serp" | "unlocker",
  context: RequestContext,
) {
  if (configured) return configured;
  let zones = cache.get(context.principalId);
  if (!zones) {
    const response = await gateway.requestJson(
      { method: "GET", path: "/zone/get_active_zones" },
      context,
    );
    const parsed = activeZonesSchema.safeParse(response.data);
    if (!parsed.success) throw malformedZones();
    zones = parsed.data;
    cache.set(context.principalId, zones);
  }
  const zone = zones.find((candidate) =>
    kind === "serp"
      ? candidate.plan?.serp === true || /serp/i.test(candidate.type)
      : /unblocker|unlocker/i.test(candidate.type) && candidate.plan?.serp !== true,
  )?.name;
  if (zone) return zone;
  const name = kind === "serp" ? "bright_mcp_serp" : "bright_mcp_unlocker";
  await gateway.requestJson({
    method: "POST",
    path: "/zone",
    body: {
      zone: { name, type: "unblocker" },
      plan: {
        type: "unblocker",
        serp: kind === "serp",
        domain_whitelist: "",
        ips_type: "shared",
        bandwidth: "bandwidth",
        ip_alloc_preset: "shared_block",
        ips: 0,
        country: "",
        country_city: "",
        mobile: false,
        city: false,
        asn: false,
        vip: false,
        vips_type: "shared",
        vips: 0,
        vip_country: "",
        vip_country_city: "",
        pool_ip_type: "",
        ub_premium: false,
        solve_captcha_disable: true,
      },
    },
    timeoutMs: 20_000,
  }, context);
  cache.delete(context.principalId);
  return name;
}

function malformedZones() {
  return new CapabilityError(
    "malformed_upstream_response",
    "Bright Data returned an unexpected active-zone response.",
    false,
    "Retry once. If this persists, inspect the account's active products.",
  );
}

function parseCursor(cursor: string | undefined) {
  if (!cursor) return 0;
  const match = /^search_(\d+)$/.exec(cursor);
  const offset = Number(match?.[1]);
  if (
    !match ||
    !Number.isInteger(offset) ||
    offset < SEARCH_PAGE_SIZE ||
    offset > MAX_SEARCH_OFFSET ||
    offset % SEARCH_PAGE_SIZE !== 0
  ) {
    throw new CapabilityError(
      "invalid_search_cursor",
      "The search cursor is invalid or expired.",
      false,
      "Start a new search without a cursor.",
    );
  }
  return offset;
}

function searchUrl(input: SearchQuery, offset: number) {
  const [language = "en", country = "US"] = input.locale.split("-");
  if (input.engine === "bing") {
    const url = new URL("https://www.bing.com/search");
    url.searchParams.set("q", input.query);
    url.searchParams.set("setlang", input.locale);
    if (offset) url.searchParams.set("first", String(offset + 1));
    return url.href;
  }
  if (input.engine === "duckduckgo") {
    const url = new URL("https://duckduckgo.com/");
    url.searchParams.set("q", input.query);
    url.searchParams.set("kl", `${country.toLowerCase()}-${language.toLowerCase()}`);
    if (offset) url.searchParams.set("s", String(offset));
    return url.href;
  }
  const url = new URL("https://www.google.com/search");
  url.searchParams.set("q", input.query);
  url.searchParams.set("hl", language.toLowerCase());
  url.searchParams.set("gl", country.toLowerCase());
  if (offset) url.searchParams.set("start", String(offset));
  return url.href;
}

function unwrapBody(value: string) {
  try {
    const parsed = JSON.parse(value) as { body?: unknown };
    return typeof parsed.body === "string" ? parsed.body : value;
  } catch {
    return value;
  }
}

function unwrapJsonBody(value: unknown) {
  if (!value || typeof value !== "object" || !("body" in value)) return value;
  const body = (value as { body?: unknown }).body;
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    return value;
  }
}

function malformedSearch(exhausted = false, requestId?: string) {
  return new CapabilityError(
    "malformed_upstream_response",
    exhausted
      ? "Bright Data returned malformed SERP responses after three attempts."
      : "Bright Data returned an unexpected SERP response shape.",
    !exhausted,
    exhausted
      ? "The server exhausted bounded recovery; verify the SERP zone and report the request ID."
      : undefined,
    requestId,
  );
}

function searchTimeout() {
  return new CapabilityError(
    "upstream_timeout",
    "Bright Data did not return a valid SERP response within 21 seconds.",
    true,
    "Retry once or use another search engine.",
  );
}

function failureRecord(error: CapabilityError): ItemFailure {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    nextAction: error.nextAction,
    requestId: error.requestId,
  };
}
