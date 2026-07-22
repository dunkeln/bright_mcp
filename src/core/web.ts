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

export type ReadItem = {
  url: string;
  content?: string;
  error?: ItemFailure;
};

export type SearchPort = {
  search(input: SearchRequest, context: RequestContext): Promise<SearchResponse>;
};

export type ReadPort = {
  read(
    input: { urls: string[] },
    context: RequestContext,
  ): Promise<ReadItem[]>;
};

export type WebContentStore = {
  save(
    url: string,
    content: string,
    context: RequestContext,
  ): { content: string; resourceUri: string; truncated: boolean };
  read(token: string, context: RequestContext): { url: string; content: string };
};

export type WebAdapter = {
  search: SearchPort;
  read: ReadPort;
};
