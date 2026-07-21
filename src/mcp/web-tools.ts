import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isPublicHttpUrl } from "../core/public-url";
import type { WebAdapter } from "../core/web";
import { reply, requestContext, runTool } from "./support";

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const searchResultSchema = z.object({
  title: z.string(),
  url: z.url(),
  summary: z.string(),
});

const itemFailureSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  nextAction: z.string().optional(),
});

const scrapeItemSchema = z.object({
  url: z.url(),
  content: z.string().optional(),
  truncated: z.boolean().optional(),
  error: itemFailureSchema.optional(),
});

const scrapeInputSchema = z.object({
  urls: z
    .array(z.url().refine(isPublicHttpUrl, "URL must be a public HTTP(S) URL."))
    .min(1)
    .max(5),
}).strict();

export function registerWebTools(
  server: McpServer,
  web: WebAdapter,
  principalId: string,
) {
  server.registerTool(
    "search_web",
    {
      title: "Search web",
      description:
        "Discover current public-web sources when the relevant pages are not yet known. Submit one to five distinct queries together when they investigate the same objective. Use fast to locate current sources, ranked to prioritize relevant evidence, and deep for broader source discovery. Results contain compact titles, URLs, and summaries; call scrape only for the selected pages whose full text is needed. Use returned cursors only to continue an incomplete result set. Do not use this tool for already-known URLs, structured dataset records, or unchanged queries that already returned useful results.",
      inputSchema: {
        queries: z.array(z.object({
          query: z.string().trim().min(1).max(500),
          engine: z.enum(["google", "bing", "duckduckgo"]).default("google"),
          locale: z.string().regex(/^[a-zA-Z]{2,3}(?:-[a-zA-Z]{2})?$/).default("en-US"),
          cursor: z.string().max(80).optional(),
        })).min(1).max(5),
        depth: z.enum(["fast", "ranked", "deep"]).default("fast"),
        intent: z.string().trim().min(1).max(3_000).optional(),
      },
      outputSchema: {
        searches: z.array(z.object({
          query: z.string(),
          results: z.array(searchResultSchema),
          nextCursor: z.string().optional(),
          error: itemFailureSchema.optional(),
        })),
      },
      annotations: {
        ...annotations,
        readOnlyHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, extra) => {
      const context = requestContext(principalId, extra.signal, extra.authInfo);
      return runTool(async () => {
        const structuredContent = await web.search.search(input, context);
        const resultCount = structuredContent.searches.reduce(
          (total, search) => total + search.results.length,
          0,
        );
        return reply(
          structuredContent,
          `Found ${resultCount} results across ${structuredContent.searches.length} searches.`,
        );
      });
    },
  );

  server.registerTool(
    "scrape",
    {
      title: "Scrape URLs",
      description:
        "Fetch readable Markdown from one to five known public URLs. Use when the user supplied URLs or search_web identified pages that must be read. Read the returned Markdown to answer questions or extract requested fields. Results preserve URL order and report failures independently, so continue with successful pages instead of repeating the whole batch. Use run_dataset for maintained structured records; do not use this tool to discover sources.",
      inputSchema: scrapeInputSchema,
      outputSchema: { results: z.array(scrapeItemSchema) },
      annotations: {
        ...annotations,
        readOnlyHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, extra) => {
      const context = requestContext(principalId, extra.signal, extra.authInfo);
      return runTool(async () => {
        const structuredContent = {
          results: await web.scrape.scrape(input, context),
        };
        const failures = structuredContent.results.filter((item) => item.error).length;
        return reply(
          structuredContent,
          `Scraped ${structuredContent.results.length - failures} of ${structuredContent.results.length} URLs.`,
        );
      });
    },
  );
}
