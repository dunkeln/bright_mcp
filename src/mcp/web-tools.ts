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
  representation: z.enum(["readable", "source"]),
  mediaType: z.enum(["text/markdown", "text/html"]),
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
  representation: z.enum(["readable", "source"]).default("readable"),
}).strict();

const searchInputSchema = z.object({
  queries: z.array(z.object({
    query: z.string().trim().min(1).max(500),
    engine: z.enum(["google", "bing", "duckduckgo"]).default("google"),
    locale: z.string().regex(/^[a-zA-Z]{2,3}(?:-[a-zA-Z]{2})?$/).default("en-US"),
    cursor: z.string().max(80).optional(),
  }).strict()).min(1).max(5),
}).strict();

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const discoverInputSchema = z.object({
  query: z.string().trim().min(1).max(500),
  intent: z.string().trim().min(1).max(500).optional(),
  limit: z.number().int().min(1).max(20).default(10),
  country: z.string().regex(/^[A-Za-z]{2}$/).optional(),
  city: z.string().trim().min(1).max(120).optional(),
  language: z.string().regex(/^[A-Za-z]{2,3}$/).optional(),
  requiredKeywords: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
  publishedAfter: dateSchema.optional(),
  publishedBefore: dateSchema.optional(),
}).strict().superRefine((input, context) => {
  if (
    input.publishedAfter &&
    input.publishedBefore &&
    input.publishedAfter > input.publishedBefore
  ) {
    context.addIssue({
      code: "custom",
      path: ["publishedAfter"],
      message: "publishedAfter must not be later than publishedBefore.",
    });
  }
});

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
        "Find current public-web sources through a fast ordinary lookup when the relevant pages are not yet known. Submit one to five related queries together. Results contain compact titles, URLs, and summaries; answer from them when they already contain the requested fact. On first use, Bright MCP may create the deterministic bright_mcp_serp zone in the caller's Bright Data account when no compatible SERP zone exists. Use discover_web instead when sources must be ranked against an explicit goal or constrained by geography, language, keywords, or dates. Use read_web only when page-level text is missing or explicitly required, not merely to verify a useful summary. Use a returned cursor only to continue that query. Do not repeat unchanged queries, and do not use this tool for known URLs, ad hoc extraction, or structured dataset records.",
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
    "discover_web",
    {
      title: "Discover web sources",
      description:
        "Build an intent-ranked shortlist of public-web sources before deeper reading or research. Use when relevance must be judged against a stated goal or constrained by geography, language, keywords, or publication dates. Results contain URLs, summaries, and upstream relevance scores—not page evidence or a completed research answer. Use search_web for a fast ordinary lookup, read_web to inspect selected URLs, and research_web when the requested outcome is already a sourced structured table. This invokes Bright Data Discover and may have different latency and billing from SERP search.",
      inputSchema: discoverInputSchema,
      outputSchema: {
        results: z.array(z.object({
          title: z.string(),
          url: z.url(),
          summary: z.string(),
          relevanceScore: z.number().optional(),
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
        const structuredContent = await web.discover.discover(input, context);
        return reply(
          structuredContent,
          `Discovered ${structuredContent.results.length} intent-ranked sources. Select only the sources needed for the next step.`,
        );
      });
    },
  );

  server.registerTool(
    "read_web",
    {
      title: "Read web pages",
      description:
        "Read exact evidence from one to five known public URLs. The default readable representation returns Markdown; request source only when exact HTML, DOM attributes, metadata, or embedded markup is required. On first use, Bright MCP may create the deterministic bright_mcp_unlocker zone in the caller's Bright Data account when no compatible Web Unlocker zone exists. Results preserve URL order and isolate failures. Each result includes a bounded inline preview plus a principal-bound resource containing the complete representation; read that resource when the preview is truncated. Use extract_web for requested fields, research_web for an open-ended objective, and run_dataset for maintained records.",
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
            return {
              url: item.url,
              representation: item.representation,
              mediaType: item.mediaType,
              ...contentStore.save(item.url, item.content, item.mediaType, context),
            };
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
              text: `Read ${structuredContent.results.length - failures} of ${structuredContent.results.length} URLs.${truncated ? ` ${truncated} inline preview${truncated === 1 ? " is" : "s are"} truncated; the linked resource contains the complete representation.` : ""}`,
            },
            ...structuredContent.results.flatMap((item) =>
              "resourceUri" in item && item.resourceUri ? [{
                type: "resource_link" as const,
                uri: item.resourceUri,
                name: item.url,
                description: `Complete page ${item.representation}`,
                mimeType: item.mediaType,
              }] : []),
          ],
        };
      });
    },
  );

  server.registerResource(
    "web-page",
    new ResourceTemplate("brightdata://web/{token}", { list: undefined }),
    { description: "Complete transient web page representation" },
    async (uri, { token }, extra) => {
      const page = contentStore.read(
        String(token),
        requestContext(principalId, extra.signal, extra.authInfo),
      );
      return {
        contents: [{ uri: uri.href, mimeType: page.mediaType, text: page.content }],
      };
    },
  );
}
