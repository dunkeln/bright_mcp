import type {
  ItemFailure as ContractItemFailure,
  RequestContext,
  SearchResponse as ContractSearchResponse,
} from "./contracts";

export type SearchQuery = {
  query: string;
  engine: "google" | "bing" | "duckduckgo";
  locale: string;
  cursor?: string;
};

export type SearchRequest = {
  queries: SearchQuery[];
};

export type DiscoverRequest = {
  query: string;
  intent?: string;
  limit: number;
  country?: string;
  city?: string;
  language?: string;
  requiredKeywords?: string[];
  publishedAfter?: string;
  publishedBefore?: string;
};

export type DiscoverResponse = {
  results: Array<{
    title: string;
    url: string;
    summary: string;
    relevanceScore?: number;
  }>;
};

export type SearchResponse = ContractSearchResponse;
export type SingleSearchResponse = Omit<
  SearchResponse["searches"][number],
  "query" | "retrievedAt" | "error"
>;
export type ItemFailure = ContractItemFailure;

export type ReadItem = {
  url: string;
  representation: "readable" | "source";
  mediaType: "text/markdown" | "text/html";
  content?: string;
  error?: ItemFailure;
};

export type SearchPort = {
  search(input: SearchRequest, context: RequestContext): Promise<SearchResponse>;
};

export type DiscoverPort = {
  discover(
    input: DiscoverRequest,
    context: RequestContext,
  ): Promise<DiscoverResponse>;
};

export type ReadPort = {
  read(
    input: { urls: string[]; representation: "readable" | "source" },
    context: RequestContext,
  ): Promise<ReadItem[]>;
};

export type WebContentStore = {
  save(
    url: string,
    content: string,
    mediaType: "text/markdown" | "text/html",
    context: RequestContext,
  ): { content: string; resourceUri: string; truncated: boolean };
  read(token: string, context: RequestContext): {
    url: string;
    content: string;
    mediaType: "text/markdown" | "text/html";
  };
};

export type WebAdapter = {
  search: SearchPort;
  discover: DiscoverPort;
  read: ReadPort;
};
