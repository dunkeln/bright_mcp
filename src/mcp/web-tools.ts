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

const searchInputSchema = z.object({
  queries: z.array(z.object({
    query: z.string().trim().min(1).max(500),
    engine: z.enum(["google", "bing", "duckduckgo"]).default("google"),
    locale: z.string().regex(/^[a-zA-Z]{2,3}(?:-[a-zA-Z]{2})?$/).default("en-US"),
    cursor: z.string().max(80).optional(),
  }).strict()).min(1).max(5),
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
        "Find current public-web sources when the relevant pages are not yet known. Submit one to five related queries together. Results contain compact titles, URLs, and summaries; scrape only selected pages whose full text is needed. Use a returned cursor only to continue that query. Do not repeat unchanged queries that already returned useful results, and do not use this tool for known URLs or structured dataset records.",
      inputSchema: searchInputSchema,
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
        const truncated = structuredContent.results.filter((item) => item.truncated).length;
        return reply(
          structuredContent,
          `Scraped ${structuredContent.results.length - failures} of ${structuredContent.results.length} URLs.${truncated ? ` ${truncated} result${truncated === 1 ? " was" : "s were"} truncated at 100 KB; use a more specific page URL if omitted content is required.` : ""}`,
        );
      });
    },
  );
}
