import { z } from "zod";
import type { BrightDataGateway } from "../adapters/brightdata/gateway";
import { CapabilityError, type RequestContext } from "../core/contracts";
import type { CredentialProvider } from "./credentials";

export type BrowserCredentialProvider = (
  context: RequestContext,
) => Promise<{ username: string; password: string }>;

const zonesSchema = z.array(z.object({
  name: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  type: z.string(),
  status: z.string(),
}));
const accountSchema = z.object({
  customer: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
});
const zoneSchema = z.object({
  password: z.array(z.string().min(1).max(4096)).min(1),
});

export function createApiKeyBrowserCredentialProvider(
  gateway: BrightDataGateway,
  apiCredentials: CredentialProvider,
): BrowserCredentialProvider {
  return async (context) => {
    const { browserZone } = await apiCredentials(context.principalId);
    const zones = parse(
      zonesSchema,
      (await gateway.requestJson(
        { method: "GET", path: "/zone/get_all_zones" },
        context,
      )).data,
    ).filter(({ type, status }) => type === "browser_api" && status === "active");
    const selected = browserZone
      ? zones.find(({ name }) => name === browserZone)
      : zones.length === 1
        ? zones[0]
        : undefined;

    if (!zones.length) {
      throw new CapabilityError(
        "browser_zone_unavailable",
        "No active Bright Data Browser API zone is available.",
        false,
        "Enable Browser API in Bright Data, then retry.",
      );
    }
    if (!selected) {
      throw new CapabilityError(
        "browser_zone_selection_required",
        browserZone
          ? `Browser API zone ${browserZone} is not active.`
          : "Multiple active Browser API zones are available.",
        false,
        `Set the browser MCP URL query to ?zone=<name>. Available zones: ${zones
          .map(({ name }) => name)
          .join(", ")}.`,
      );
    }

    const [account, zone] = await Promise.all([
      gateway.requestJson({ method: "GET", path: "/status" }, context),
      gateway.requestJson({
        method: "GET",
        path: "/zone",
        query: { zone: selected.name },
      }, context),
    ]);
    const customer = parse(accountSchema, account.data).customer;
    const password = parse(zoneSchema, zone.data).password[0]!;
    const credential = {
      username: `brd-customer-${customer}-zone-${selected.name}`,
      password,
    };
    return credential;
  };
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new CapabilityError(
    "malformed_upstream_response",
    "Bright Data returned incomplete Browser API access details.",
    false,
    "Verify that the API key can read the selected Browser API zone.",
  );
}
