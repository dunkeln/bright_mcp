import type { ServerId } from "./mcp";

type ToolPath = Record<ServerId, string[][]>;

export const benchmarkProfile = "current-entitlements";

export const workflowCases = [
  {
    id: "acquire-current-search",
    pillar: "Acquire",
    shortLabel: "Current search",
    brightProfile: "web",
    prompt:
      'Find Tesla\'s current stock price. Return one JSON object with keys "price", "currency", "asOf", and "sourceUrl". A single Markdown JSON fence and brief surrounding text are allowed.',
    turns: [
      'Find Tesla\'s current stock price. Return one JSON object with keys "price", "currency", "asOf", and "sourceUrl". A single Markdown JSON fence and brief surrounding text are allowed.',
      'Verify the quote against another current source. Return the best-supported answer in the same JSON shape, updating the source and timestamp if needed.',
      'Check whether the selected quote is delayed, real-time, or unspecified. Keep the same JSON shape and do not invent a precision the source does not provide.',
      'Resolve any remaining disagreement using the freshest evidence available. Return the revised answer in the same JSON shape.',
      'Give the final concise, best-supported answer in the same JSON shape with a working source URL.',
    ],
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
    brightProfile: "web",
    prompt:
      'Read https://example.com and https://www.iana.org/help/example-domains in that order. Return one JSON array; each item must have "url", "title", and "summary". A single Markdown JSON fence and brief surrounding text are allowed.',
    turns: [
      'Read https://example.com and https://www.iana.org/help/example-domains in that order. Return one JSON array; each item must have "url", "title", and "summary". A single Markdown JSON fence and brief surrounding text are allowed.',
      'Verify both summaries against the page evidence. Return the complete revised two-item array in the same JSON shape.',
      'Make the different purpose of each page explicit without adding unsupported detail. Return the complete array again.',
      'Check that each title and URL corresponds to the correct page. Return the corrected complete array.',
      'Give the final concise two-item array in the same JSON shape.',
    ],
    toolPath: {
      bright: [["read_web"]],
      upstream: [["scrape_batch", "scrape_as_markdown"]],
    } satisfies ToolPath,
    requiredKeys: ["url", "title", "summary"],
    minimumUrls: 2,
  },
  /* Disabled in the current-entitlements profile: extract_web and research_web
     require general Deep Lookup, but this account is restricted to business-email
     queries. Re-enable these four cases only after both preview probes pass.
  {
    id: "extract-npm-package",
    pillar: "Extract",
    shortLabel: "npm record",
    prompt:
      'Read https://www.npmjs.com/package/express and extract one record. Return JSON only with keys "name", "version", "license", and "sourceUrl".',
    toolPath: {
      bright: [["extract_web"]],
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
      bright: [["extract_web"]],
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
      bright: [["research_web"]],
      upstream: [["search_engine"], ["scrape_as_markdown", "scrape_batch"]],
    } satisfies ToolPath,
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
      bright: [["research_web"]],
      upstream: [["search_engine"], ["scrape_as_markdown", "scrape_batch"]],
    } satisfies ToolPath,
    requiredKeys: ["topic", "finding", "asOf", "sourceUrl"],
    minimumUrls: 3,
  },
  */
  {
    id: "operate-product-snapshot",
    pillar: "Operate",
    shortLabel: "Marketplace data retrieval",
    brightProfile: "marketplace",
    prompt:
      'Get structured Amazon product search data for wireless earbuds from Amazon.com. Do not explain which product to use; execute the available data capability. Return one JSON object with keys "dataset", "rowCount", "fields", and "continuation". A single Markdown JSON fence and brief surrounding text are allowed.',
    turns: [
      'Get structured Amazon product search data for wireless earbuds from Amazon.com. Do not explain which product to use; execute the available data capability. Return one JSON object with keys "dataset", "rowCount", "fields", and "continuation". A single Markdown JSON fence and brief surrounding text are allowed.',
      'Verify that the dataset, row count, and fields are supported by the tool result. Rerun only if evidence is missing, then return the complete object in the same JSON shape.',
      'Determine whether a continuation or pagination value is actually available. Return the complete revised object and do not invent one.',
      'Remove any fields or claims that are inferred rather than present in the result. Return the complete object again.',
      'Give the final concise, evidence-grounded object in the same JSON shape.',
    ],
    upstreamProfile: "ecommerce",
    toolPath: {
      bright: [["find_datasets"], ["run_dataset"]],
      upstream: [["web_data_amazon_product_search"]],
    } satisfies ToolPath,
    requiredKeys: ["dataset", "rowCount", "fields", "continuation"],
  },
  /* WIP capability: neither MCP can create a durable delivery schedule. Keep this
     case out of scored runs until the workflow can execute rather than only
     describe the capability boundary.
  {
    id: "operate-recurring-delivery",
    pillar: "Operate",
    shortLabel: "Recurring delivery",
    prompt:
      'Set up a weekly delivery of a refreshed wireless-earbud dataset. If the available tools cannot actually create that schedule, do not pretend they did. Return JSON only with keys "supported", "reason", and "nextStep".',
    toolPath: { bright: [], upstream: [] } satisfies ToolPath,
    requiredKeys: ["supported", "reason", "nextStep"],
  },
  */
] as const;

export type WorkflowCase = (typeof workflowCases)[number];

if (import.meta.main) {
  if (workflowCases.some(({ turns }) => turns.length < 5)) throw new Error("Every active workflow must author five turns.");
  console.log(`${workflowCases.length} workflows author at least five turns.`);
}
