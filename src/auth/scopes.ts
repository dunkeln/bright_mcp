import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

export const ACCESS_SCOPE = "mcp:access";
export const WEB_SCOPE = "bright:web";
export const DATASET_RUN_SCOPE = "bright:datasets:run";
export const BROWSER_SCOPE = "bright:browser";

export function requiredScopesForRequest(value: unknown) {
  const scopes = new Set([ACCESS_SCOPE]);
  for (const request of Array.isArray(value) ? value : [value]) {
    if (!isRecord(request) || !isRecord(request.params)) continue;
    if (request.method === "tools/call") {
      const name = request.params.name;
      if (name === "search_web" || name === "scrape") scopes.add(WEB_SCOPE);
      if (name === "run_dataset") scopes.add(DATASET_RUN_SCOPE);
      if (typeof name === "string" && name.startsWith("browser_")) {
        scopes.add(BROWSER_SCOPE);
      }
    }
    if (request.method === "resources/read") {
      const uri = request.params.uri;
      if (
        typeof uri === "string" &&
        (uri.startsWith("brightdata://results/") ||
          uri.startsWith("brightdata://pages/"))
      ) {
        scopes.add(DATASET_RUN_SCOPE);
      }
      if (typeof uri === "string" && uri.startsWith("brightbrowser://")) {
        scopes.add(BROWSER_SCOPE);
      }
    }
  }
  return [...scopes];
}

export function missingScopes(authInfo: AuthInfo, required: string[]) {
  return required.filter((scope) => !authInfo.scopes.includes(scope));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
