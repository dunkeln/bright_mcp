import type { SearchPort, ScrapePort } from "../core/web";

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
  scrape: ScrapePort;
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
    scrape: {
      async scrape(input) {
        return input.urls.map((url) => ({
          url,
          format: input.format,
          content:
            input.format === "markdown"
              ? `# Demo page\n\nLocally generated preview for ${url}`
              : `<main><h1>Demo page</h1><p>Locally generated preview for ${Bun.escapeHTML(url)}</p></main>`,
        }));
      },
    },
  };
}
