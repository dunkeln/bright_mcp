import type { ServerId } from "./mcp";

type ToolPath = Record<ServerId, string[][]>;

export const workflowCases = [
  {
    id: "acquire-current-search",
    pillar: "Acquire",
    shortLabel: "Current search",
    prompt:
      'Find Tesla\'s current stock price. Return JSON only with keys "price", "currency", "asOf", and "sourceUrl".',
    toolPath: {
      bright: [["search_web"]],
      upstream: [["search_engine"]],
    } satisfies ToolPath,
    requiredKeys: ["price", "currency", "asOf", "sourceUrl"],
    minimumUrls: 1,
  },
  {
    id: "acquire-known-pages",
    pillar: "Acquire",
    shortLabel: "Known pages",
    prompt:
      'Read https://example.com and https://www.iana.org/help/example-domains in that order. Return a JSON array only; each item must have "url", "title", and "summary".',
    toolPath: {
      bright: [["scrape"]],
      upstream: [["scrape_batch", "scrape_as_markdown"]],
    } satisfies ToolPath,
    requiredKeys: ["url", "title", "summary"],
    minimumUrls: 2,
  },
  {
    id: "extract-npm-package",
    pillar: "Extract",
    shortLabel: "npm record",
    prompt:
      'Read https://www.npmjs.com/package/express and extract one record. Return JSON only with keys "name", "version", "license", and "sourceUrl".',
    toolPath: {
      bright: [["scrape"]],
      upstream: [["scrape_as_markdown"]],
    } satisfies ToolPath,
    requiredKeys: ["name", "version", "license", "sourceUrl"],
    minimumUrls: 1,
  },
  {
    id: "extract-pypi-package",
    pillar: "Extract",
    shortLabel: "PyPI record",
    prompt:
      'Read https://pypi.org/project/langchain-brightdata/ and extract one record. Return JSON only with keys "name", "version", "summary", and "sourceUrl".',
    toolPath: {
      bright: [["scrape"]],
      upstream: [["scrape_as_markdown"]],
    } satisfies ToolPath,
    requiredKeys: ["name", "version", "summary", "sourceUrl"],
    minimumUrls: 1,
  },
  {
    id: "research-local-options",
    pillar: "Research",
    shortLabel: "Local research",
    prompt:
      'Research three highly rated ramen restaurants in Tokyo using at least two sources, and open the relevant pages before answering. Return a JSON array only; each item must have "restaurant", "rating", "area", and "sourceUrl".',
    toolPath: {
      bright: [["search_web"]],
      upstream: [["search_engine"], ["scrape_as_markdown", "scrape_batch"]],
    } satisfies ToolPath,
    requiresOpenedSources: true,
    requiredKeys: ["restaurant", "rating", "area", "sourceUrl"],
    minimumUrls: 2,
  },
  {
    id: "research-current-events",
    pillar: "Research",
    shortLabel: "Current events",
    prompt:
      'Research this week\'s major movie releases and today\'s leading topic on X using at least three sources, and open the relevant pages before answering. Return a JSON array only; each item must have "topic", "finding", "asOf", and "sourceUrl".',
    toolPath: {
      bright: [["search_web"]],
      upstream: [["search_engine"], ["scrape_as_markdown", "scrape_batch"]],
    } satisfies ToolPath,
    requiresOpenedSources: true,
    requiredKeys: ["topic", "finding", "asOf", "sourceUrl"],
    minimumUrls: 3,
  },
  {
    id: "operate-product-snapshot",
    pillar: "Operate",
    shortLabel: "Product snapshot",
    prompt:
      'Get structured Amazon product search data for wireless earbuds from Amazon.com. Do not explain which product to use; execute the available data capability. Return JSON only with keys "dataset", "rowCount", "fields", and "continuation".',
    upstreamProfile: "ecommerce",
    toolPath: {
      bright: [["find_datasets"], ["run_dataset"]],
      upstream: [["web_data_amazon_product_search"]],
    } satisfies ToolPath,
    requiredKeys: ["dataset", "rowCount", "fields", "continuation"],
  },
  {
    id: "operate-recurring-delivery",
    pillar: "Operate",
    shortLabel: "Recurring delivery",
    prompt:
      'Set up a weekly delivery of a refreshed wireless-earbud dataset. If the available tools cannot actually create that schedule, do not pretend they did. Return JSON only with keys "supported", "reason", and "nextStep".',
    toolPath: { bright: [], upstream: [] } satisfies ToolPath,
    requiredKeys: ["supported", "reason", "nextStep"],
    mustRefuse: true,
  },
] as const;

export type WorkflowCase = (typeof workflowCases)[number];
