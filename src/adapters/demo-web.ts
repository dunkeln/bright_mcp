import type { DiscoverPort, ReadPort, SearchPort } from "../core/web";

const pages = [
  {
    title: "Bright Data documentation",
    url: "https://docs.brightdata.com/",
    summary: "Product and API documentation for Bright Data.",
  },
  {
    title: "Model Context Protocol",
    url: "https://modelcontextprotocol.io/",
    summary: "Protocol documentation for connecting models to tools and data.",
  },
];

export function createDemoWebAdapter(): {
  search: SearchPort;
  discover: DiscoverPort;
  read: ReadPort;
} {
  return {
    search: {
      async search(input) {
        return {
          searches: input.queries.map(({ query }) => ({
            query,
            results: pages.filter((page) =>
              `${page.title} ${page.summary}`.toLowerCase().includes(query.toLowerCase()),
            ),
          })),
        };
      },
    },
    discover: {
      async discover(input) {
        return {
          results: pages.slice(0, input.limit).map((page, index) => ({
            ...page,
            relevanceScore: 1 - index * 0.1,
          })),
        };
      },
    },
    read: {
      async read(input) {
        return input.urls.map((url) => ({
          url,
          representation: input.representation,
          mediaType: input.representation === "source"
            ? "text/html" as const
            : "text/markdown" as const,
          content: input.representation === "source"
            ? `<!doctype html><html><body>Demo page for ${url}</body></html>`
            : `# Demo page\n\nLocally generated preview for ${url}`,
        }));
      },
    },
  };
}
