import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CapabilityError,
  jsonValueSchema,
} from "../core/contracts";
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
        "Find current public web resources with Google, Bing, or DuckDuckGo. Returns canonical organic results rather than engine-specific response data. On first use, Bright MCP may create the required SERP zone in the caller's Bright Data account.",
      inputSchema: {
        query: z.string().trim().min(1).max(500),
        engine: z.enum(["google", "bing", "duckduckgo"]).default("google"),
        locale: z
          .string()
          .regex(/^[a-zA-Z]{2,3}(?:-[a-zA-Z]{2})?$/)
          .default("en-US"),
        cursor: z.string().max(80).optional(),
      },
      outputSchema: {
        results: z.array(searchResultSchema),
        nextCursor: z.string().optional(),
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
        return reply(
          structuredContent,
          `Found ${structuredContent.results.length} web results.`,
        );
      });
    },
  );

  server.registerTool(
    "scrape",
    {
      title: "Scrape URLs",
      description:
        "Use this to retrieve readable content from one to five known public HTTP(S) URLs. Results preserve input order and isolate per-URL failures. On first use, Bright MCP may create the required Web Unlocker zone in the caller's Bright Data account.",
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
