import type { ReadPort, SearchPort } from "../core/web";

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
    read: {
      async read(input) {
        return input.urls.map((url) => ({
          url,
          content: `# Demo page\n\nLocally generated preview for ${url}`,
        }));
      },
    },
  };
}
