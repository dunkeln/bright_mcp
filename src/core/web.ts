import { z } from "zod";
import { CapabilityError, type JsonObject, type RequestContext } from "./contracts";

export type SearchRequest = {
  query: string;
  engine: "google" | "bing" | "duckduckgo";
  locale: string;
  cursor?: string;
};

export type SearchResponse = {
  results: Array<{ title: string; url: string; summary: string }>;
  nextCursor?: string;
};

export type ItemFailure = {
  code: string;
  message: string;
  retryable: boolean;
  nextAction?: string;
};

export type ScrapeItem = {
  url: string;
  format: "markdown" | "html";
  content?: string;
  truncated?: boolean;
  error?: ItemFailure;
  extraction?: {
    data: JsonObject;
    provenance: { provider: string; model?: string };
  };
  extractionError?: ItemFailure;
};

export type FieldProjection =
  | { kind: "string" | "number" | "boolean" }
  | { kind: "object"; fields: Record<string, FieldProjection> }
  | { kind: "array"; items: FieldProjection };

export type ExtractionRequest = {
  instructions: string;
  fields: Record<string, FieldProjection>;
};

export type SearchPort = {
  search(input: SearchRequest, context: RequestContext): Promise<SearchResponse>;
};

export type ScrapePort = {
  scrape(
    input: { urls: string[]; format: "markdown" | "html" },
    context: RequestContext,
  ): Promise<ScrapeItem[]>;
};

export type ExtractionProvider = {
  extract(input: {
    content: string;
    instructions: string;
    schema: z.ZodType<JsonObject>;
    context: RequestContext;
  }): Promise<{
    data: unknown;
    provenance: { provider: string; model?: string };
  }>;
};

export function createWebUseCases(dependencies: {
  search: SearchPort;
  scrape: ScrapePort;
  extraction?: ExtractionProvider;
}) {
  return {
    searchWeb: (input: SearchRequest, context: RequestContext) =>
      dependencies.search.search(input, context),
    async scrape(
      input: {
        urls: string[];
        format: "markdown" | "html";
        extraction?: ExtractionRequest;
      },
      context: RequestContext,
    ) {
      const extraction = input.extraction;
      const provider = dependencies.extraction;
      if (extraction && !provider) {
        throw new CapabilityError(
          "extraction_provider_unavailable",
          "Structured extraction is not configured for this deployment.",
          false,
          "Retry without extraction or configure an ExtractionProvider.",
        );
      }

      const schema = extraction ? compileProjection(extraction.fields) : undefined;
      const items = await dependencies.scrape.scrape(input, context);
      if (!extraction || !provider || !schema) return { results: items };
      const results = await Promise.all(
        items.map(async (item): Promise<ScrapeItem> => {
          if (!item.content || item.error) return item;
          try {
            const extracted = await provider.extract({
              content: item.content,
              instructions: extraction.instructions,
              schema,
              context,
            });
            const parsed = schema.safeParse(extracted.data);
            if (!parsed.success) {
              return {
                ...item,
                extractionError: {
                  code: "extraction_validation_failed",
                  message: "The extraction provider returned data outside the requested projection.",
                  retryable: false,
                  nextAction: "Simplify the projection or retry without extraction.",
                },
              };
            }
            return {
              ...item,
              extraction: { data: parsed.data, provenance: extracted.provenance },
            };
          } catch (error) {
            const failure = error instanceof CapabilityError
              ? error
              : new CapabilityError(
                  "extraction_failed",
                  "The extraction provider failed.",
                  true,
                  "Retry once or request the scraped content without extraction.",
                );
            return {
              ...item,
              extractionError: failureRecord(failure),
            };
          }
        }),
      );
      return { results };
    },
  };
}

export type WebUseCases = ReturnType<typeof createWebUseCases>;

function compileProjection(
  fields: Record<string, FieldProjection>,
): z.ZodType<JsonObject> {
  return z.object(
    Object.fromEntries(
      Object.entries(fields).map(([key, projection]) => [
        key,
        compileField(projection),
      ]),
    ),
  ) as z.ZodType<JsonObject>;
}

function compileField(projection: FieldProjection): z.ZodType {
  if (projection.kind === "array") return z.array(compileField(projection.items));
  if (projection.kind === "object") return compileProjection(projection.fields);
  if (projection.kind === "string") return z.string();
  if (projection.kind === "number") return z.number();
  return z.boolean();
}

function failureRecord(error: CapabilityError): ItemFailure {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    nextAction: error.nextAction,
  };
}
