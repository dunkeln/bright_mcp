import type {
  DatasetResult,
  DatasetUnavailable,
  SearchResponse,
} from "../core/contracts";
import { profileDataset } from "../core/profiles";

const columns = [
  { key: "title", label: "Product", type: "string" },
  { key: "brand", label: "Brand", type: "string" },
  { key: "price", label: "Price", type: "number" },
  { key: "rating", label: "Rating", type: "number" },
  { key: "inStock", label: "In stock", type: "boolean" },
  { key: "released", label: "Released", type: "date" },
  { key: "source", label: "Source", type: "string" },
];

const rows = [
  {
    title: "QuietBuds Pro",
    brand: "Auralite",
    price: 79.99,
    rating: 4.7,
    inStock: true,
    released: "2026-04-11",
    source: "https://example.com/quietbuds-pro",
  },
  {
    title: "Commuter Mini",
    brand: "Northstar Audio",
    price: 49,
    rating: 4.4,
    inStock: true,
    released: "2026-02-18",
    source: "https://example.com/commuter-mini",
  },
  {
    title: "Studio Air 2",
    brand: "Kindred Sound",
    price: 129.5,
    rating: 4.8,
    inStock: false,
    released: "2026-06-02",
    source: "https://example.com/studio-air-2",
  },
  {
    title: "Everyday Pods",
    brand: null,
    price: 34.95,
    rating: 4.1,
    inStock: true,
    released: "2025-11-09",
    source: "https://example.com/everyday-pods",
  },
  {
    title: "TrailBeat Sport",
    brand: "Summit",
    price: 64,
    rating: "4.5",
    inStock: true,
    released: "2026-01-27",
    source: "https://example.com/trailbeat-sport",
  },
];

export const devDatasetResult = {
  schemaVersion: 1,
  resultId: "preview-products-1",
  dataset: {
    id: "preview-products",
    title: "Wireless earbuds",
  },
  operation: "search",
  columns,
  profiles: profileDataset(columns, rows),
  rows,
  rowRefs: [
    "preview-row-1",
    "preview-row-2",
    "preview-row-3",
    "preview-row-4",
    "preview-row-5",
  ],
  page: {
    truncated: false,
    totalRows: 5,
  },
  artifact: {
    uri: "bright://results/preview-products-1",
    mediaType: "application/json",
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  },
} satisfies DatasetResult;

export const devUnavailable = {
  schemaVersion: 1,
  status: "unavailable",
  title: "Access limited",
  message: "Deep Lookup is not available for this connection.",
  nextAction:
    "Use search_web to find sources, then read_web only for pages that need exact evidence.",
  fallbackTools: ["search_web", "read_web"],
} satisfies DatasetUnavailable;

export const devSearchResult = {
  searches: [
    {
      query: "open source TypeScript MCP SDKs",
      retrievedAt: "2026-07-23T07:58:32.117Z",
      providerQuery: "open source TypeScript MCP SDKs",
      detectedQuery: "open source TypeScript MCP SDKs",
      results: [
        {
          rank: 1,
          title: "Model Context Protocol TypeScript SDK",
          url: "https://github.com/modelcontextprotocol/typescript-sdk",
          summary: "The official TypeScript SDK for Model Context Protocol.",
          siteLinks: [
            {
              text: "Documentation",
              url: "https://github.com/modelcontextprotocol/typescript-sdk#readme",
            },
          ],
        },
        {
          rank: 2,
          title: "Model Context Protocol servers",
          url: "https://github.com/modelcontextprotocol/servers",
          summary: "Reference MCP server implementations and community examples.",
        },
        {
          rank: 3,
          title: "MCP Apps",
          url: "https://github.com/modelcontextprotocol/ext-apps",
          summary: "Interactive user interfaces for Model Context Protocol tools.",
        },
        {
          rank: 4,
          title: "MCP Inspector",
          url: "https://github.com/modelcontextprotocol/inspector",
          summary: "Developer tools for testing and debugging MCP servers.",
        },
        {
          rank: 5,
          title: "MCP Registry",
          url: "https://github.com/modelcontextprotocol/registry",
          summary: "A community registry for discoverable MCP servers.",
        },
      ],
      topStories: [
        {
          title: "New MCP tools arrive for TypeScript developers",
          url: "https://example.com/mcp-typescript",
          source: "Example News",
          published: "2 hours ago",
          imageUrl: "https://example.com/mcp-typescript.png",
        },
      ],
      nextCursor: "search_10",
    },
  ],
} satisfies SearchResponse;
