import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isPublicHttpUrl } from "../core/public-url";
import type { WebAdapter, WebContentStore } from "../core/web";
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

const readItemSchema = z.object({
  url: z.url(),
  content: z.string().optional(),
  resourceUri: z.string().optional(),
  truncated: z.boolean(),
  error: itemFailureSchema.optional(),
});

const readInputSchema = z.object({
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
  contentStore: WebContentStore,
  principalId: string,
) {
  server.registerTool(
    "search_web",
    {
      title: "Search web",
      description:
        "Find current public-web sources when the relevant pages are not yet known. Submit one to five related queries together. Results contain compact titles, URLs, and summaries; use read_web only for selected pages whose exact text is needed. Use a returned cursor only to continue that query. Do not repeat unchanged queries that already returned useful results, and do not use this tool for known URLs, ad hoc extraction, or structured dataset records.",
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
    "read_web",
    {
      title: "Read web pages",
      description:
        "Read exact evidence from one to five known public URLs as Markdown. Use when the user supplied URLs or search_web identified pages that must be inspected or quoted. Results preserve URL order and isolate failures. Each result includes a bounded inline preview plus a principal-bound resource containing the complete page; read that resource when the preview is truncated. Use extract_web for requested fields, research_web for an open-ended objective, and run_dataset for maintained records.",
      inputSchema: readInputSchema,
      outputSchema: { results: z.array(readItemSchema) },
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
          results: (await web.read.read(input, context)).map((item) => {
            if (item.content === undefined) return { ...item, truncated: false };
            return { url: item.url, ...contentStore.save(item.url, item.content, context) };
          }),
        };
        const failures = structuredContent.results.filter(
          (item) => "error" in item && item.error,
        ).length;
        const truncated = structuredContent.results.filter((item) => item.truncated).length;
        return {
          structuredContent,
          content: [
            {
              type: "text" as const,
              text: `Read ${structuredContent.results.length - failures} of ${structuredContent.results.length} URLs.${truncated ? ` ${truncated} inline preview${truncated === 1 ? " is" : "s are"} truncated; the linked resource contains the complete Markdown.` : ""}`,
            },
            ...structuredContent.results.flatMap((item) =>
              "resourceUri" in item && item.resourceUri ? [{
                type: "resource_link" as const,
                uri: item.resourceUri,
                name: item.url,
                description: "Complete page Markdown",
                mimeType: "text/markdown",
              }] : []),
          ],
        };
      });
    },
  );

  server.registerResource(
    "web-page",
    new ResourceTemplate("brightdata://web/{token}", { list: undefined }),
    { mimeType: "text/markdown", description: "Complete transient web page" },
    async (uri, { token }, extra) => {
      const page = contentStore.read(
        String(token),
        requestContext(principalId, extra.signal, extra.authInfo),
      );
      return {
        contents: [{ uri: uri.href, mimeType: "text/markdown", text: page.content }],
      };
    },
  );
}
