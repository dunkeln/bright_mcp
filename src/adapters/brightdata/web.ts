import { z } from "zod";
import { CapabilityError } from "../../core/contracts";
import type {
  ItemFailure,
  ScrapePort,
  SearchPort,
  SearchRequest,
} from "../../core/web";
import { BrightDataGateway } from "./gateway";

const SEARCH_PAGE_SIZE = 10;
const MAX_SEARCH_OFFSET = 90;
const MAX_SCRAPE_BYTES = 100_000;

const organicResultSchema = z.object({
  title: z.string(),
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

export function createBrightDataWebAdapter(
  gateway: BrightDataGateway,
  zones: { serp?: string; unlocker?: string },
): { search: SearchPort; scrape: ScrapePort } {
  return {
    search: {
      async search(input, context) {
        const zone = requiredZone(zones.serp, "SERP API");
        const offset = parseCursor(input.cursor);
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
            timeoutMs: 20_000,
          },
          context,
        );
        const parsed = searchEnvelopeSchema.safeParse(response.data);
        if (!parsed.success || (!parsed.data.organic && !parsed.data.results)) {
          throw malformedSearch();
        }
        const candidates = parsed.data.organic ?? parsed.data.results ?? [];
        const results = candidates
          .filter((item) => !item.type || item.type === "organic")
          .flatMap((item) => {
            const url = item.link ?? item.url;
            return url
              ? [{ title: item.title, url, summary: item.description ?? item.snippet ?? "" }]
              : [];
          })
          .slice(0, SEARCH_PAGE_SIZE);
        return {
          results,
          nextCursor:
            results.length === SEARCH_PAGE_SIZE && offset < MAX_SEARCH_OFFSET
              ? `search_${offset + SEARCH_PAGE_SIZE}`
              : undefined,
        };
      },
    },
    scrape: {
      async scrape(input, context) {
        const zone = requiredZone(zones.unlocker, "Web Unlocker API");
        return Promise.all(
          input.urls.map(async (url) => {
            try {
              const response = await gateway.requestText(
                {
                  method: "POST",
                  path: "/request",
                  body: {
                    zone,
                    url,
                    format: "raw",
                    ...(input.format === "markdown"
                      ? { data_format: "markdown" }
                      : {}),
                  },
                  timeoutMs: 30_000,
                },
                context,
              );
              const content = unwrapBody(response.data);
              const bounded = boundText(content);
              return {
                url,
                format: input.format,
                content: bounded.content,
                truncated: bounded.truncated || undefined,
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
              if (failure.code === "brightdata_connection_required") throw failure;
              return {
                url,
                format: input.format,
                error: failureRecord(failure),
              };
            }
          }),
        );
      },
    },
  };
}

function requiredZone(value: string | undefined, product: string) {
  if (value) return value;
  throw new CapabilityError(
    "brightdata_zone_required",
    `${product} requires a configured Bright Data zone.`,
    false,
    "Configure the deployment's product zone and retry.",
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

function searchUrl(input: SearchRequest, offset: number) {
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

function boundText(value: string) {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= MAX_SCRAPE_BYTES) {
    return { content: value, truncated: false };
  }
  return {
    content: new TextDecoder().decode(bytes.slice(0, MAX_SCRAPE_BYTES)),
    truncated: true,
  };
}

function malformedSearch() {
  return new CapabilityError(
    "malformed_upstream_response",
    "Bright Data returned an unexpected SERP response shape.",
    false,
    "Retry once. If this persists, verify the SERP zone output format.",
  );
}

function failureRecord(error: CapabilityError): ItemFailure {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    nextAction: error.nextAction,
  };
}
