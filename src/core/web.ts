import type { RequestContext } from "./contracts";

export type SearchQuery = {
  query: string;
  engine: "google" | "bing" | "duckduckgo";
  locale: string;
  cursor?: string;
};

export type SearchRequest = {
  queries: SearchQuery[];
};

export type SearchResponse = {
  searches: Array<{
    query: string;
    results: Array<{
      title: string;
      url: string;
      summary: string;
    }>;
    nextCursor?: string;
    error?: ItemFailure;
  }>;
};

export type SingleSearchResponse = {
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
  content?: string;
  truncated?: boolean;
  error?: ItemFailure;
};

export type SearchPort = {
  search(input: SearchRequest, context: RequestContext): Promise<SearchResponse>;
};

export type ScrapePort = {
  scrape(
    input: { urls: string[] },
    context: RequestContext,
  ): Promise<ScrapeItem[]>;
};

export type WebAdapter = {
  search: SearchPort;
  scrape: ScrapePort;
};
