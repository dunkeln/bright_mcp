import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { jsonValueSchema } from "../core/contracts";
import { isPublicHttpUrl } from "../core/public-url";
import type { FieldProjection, WebUseCases } from "../core/web";
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
  content: z.string().optional(),
});

const itemFailureSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  nextAction: z.string().optional(),
});

const fieldProjectionSchema: z.ZodType<FieldProjection> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.enum(["string", "number", "boolean"]) }),
    z.object({
      kind: z.literal("object"),
      fields: z.record(z.string().min(1).max(80), fieldProjectionSchema),
    }),
    z.object({ kind: z.literal("array"), items: fieldProjectionSchema }),
  ]),
);

const extractionSchema = z
  .object({
    instructions: z.string().trim().min(1).max(1_000),
    fields: z
      .record(z.string().min(1).max(80), fieldProjectionSchema)
      .refine((fields) => Object.keys(fields).length > 0, "At least one field is required."),
  })
  .superRefine((value, context) => {
    let fieldCount = 0;
    const visit = (field: FieldProjection, depth: number) => {
      if (depth > 4) {
        context.addIssue({
          code: "custom",
          message: "Extraction projections support at most four nested levels.",
        });
        return;
      }
      fieldCount += 1;
      if (field.kind === "object") {
        Object.values(field.fields).forEach((item) => visit(item, depth + 1));
      } else if (field.kind === "array") {
        visit(field.items, depth + 1);
      }
    };
    Object.values(value.fields).forEach((field) => visit(field, 1));
    if (fieldCount > 20) {
      context.addIssue({
        code: "custom",
        message: "Extraction projections support at most 20 fields.",
      });
    }
  });

const scrapeItemSchema = z.object({
  url: z.url(),
  format: z.enum(["markdown", "html"]),
  content: z.string().optional(),
  truncated: z.boolean().optional(),
  error: itemFailureSchema.optional(),
  extraction: z
    .object({
      data: z.record(z.string(), jsonValueSchema),
      provenance: z.object({ provider: z.string(), model: z.string().optional() }),
    })
    .optional(),
  extractionError: itemFailureSchema.optional(),
});

export function registerWebTools(
  server: McpServer,
  web: WebUseCases,
  principalId: string,
) {
  server.registerTool(
    "search_web",
    {
      title: "Search web",
      description:
        "Discover current public-web information when the relevant pages are not yet known. Submit one to five distinct queries together when they investigate the same objective. Use fast to locate current sources, ranked to prioritize relevant evidence, and deep for broader source discovery. With ranked or deep, set includeContent=true when the answer requires page-level evidence; this can complete research without a separate scrape. Use returned cursors only to continue an incomplete result set. Do not use this tool for already-known URLs, structured dataset records, or unchanged queries that already returned useful results. After successful discovery, answer from included content or scrape only the selected sources whose full text is still needed.",
      inputSchema: {
        queries: z.array(z.object({
          query: z.string().trim().min(1).max(500),
          engine: z.enum(["google", "bing", "duckduckgo"]).default("google"),
          locale: z.string().regex(/^[a-zA-Z]{2,3}(?:-[a-zA-Z]{2})?$/).default("en-US"),
          cursor: z.string().max(80).optional(),
        })).min(1).max(5),
        depth: z.enum(["fast", "ranked", "deep"]).default("fast"),
        includeContent: z.boolean().default(false),
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
        const structuredContent = await web.searchWeb(input, context);
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
        "Acquire readable content from one to five known public URLs. Use when the user supplied the URLs or search_web identified specific pages that must be opened. Choose markdown for reading and synthesis, or html when document structure or markup matters. Provide an extraction projection only when the required fields and their types are already known. Results preserve URL order and report failures independently, so continue with successful pages instead of repeating the whole batch. Do not use this tool to discover sources or retrieve maintained structured datasets.",
      inputSchema: {
        urls: z
          .array(z.url().refine(isPublicHttpUrl, "URL must be a public HTTP(S) URL."))
          .min(1)
          .max(5),
        format: z.enum(["markdown", "html"]).default("markdown"),
        extraction: extractionSchema.optional(),
      },
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
        const structuredContent = await web.scrape(input, context);
        const failures = structuredContent.results.filter((item) => item.error).length;
        return reply(
          structuredContent,
          `Scraped ${structuredContent.results.length - failures} of ${structuredContent.results.length} URLs.`,
        );
      });
    },
  );
}
