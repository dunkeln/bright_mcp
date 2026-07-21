import { discoverAuthorizationServerMetadata } from "@modelcontextprotocol/sdk/client/auth.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { ACCESS_SCOPE, missingScopes } from "./scopes";

export type HttpAuthorization = Awaited<ReturnType<typeof createOidcAuthorization>>;

const asymmetricJwtAlgorithms: string[] = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
];

export async function createOidcAuthorization(options: {
  issuer: URL;
  resource: URL;
  maxTokenAgeSeconds?: number;
}) {
  requireHttps(options.issuer, "OIDC issuer");
  requireHttps(options.resource, "MCP public URL");
  if (options.issuer.search) throw new Error("OIDC issuer must not contain a query.");
  if (options.resource.search) throw new Error("MCP public URL must not contain a query.");

  const metadata = await discoverAuthorizationServerMetadata(options.issuer, {
    fetchFn: fetchWithTimeout,
  });
  if (
    !metadata ||
    metadata.issuer.replace(/\/$/, "") !== options.issuer.href.replace(/\/$/, "")
  ) {
    throw new Error("OIDC discovery failed or returned a different issuer.");
  }
  const issuer = metadata.issuer;
  if (!metadata.code_challenge_methods_supported?.includes("S256")) {
    throw new Error("The authorization server must advertise PKCE S256 support.");
  }
  const authorizationEndpoint = requiredEndpoint(
    metadata.authorization_endpoint,
    "authorization_endpoint",
  );
  const tokenEndpoint = requiredEndpoint(metadata.token_endpoint, "token_endpoint");
  const jwksUri = "jwks_uri" in metadata ? metadata.jwks_uri : undefined;
  if (typeof jwksUri !== "string") {
    throw new Error("The authorization server metadata omitted jwks_uri.");
  }
  const jwksUrl = new URL(jwksUri);
  requireHttps(jwksUrl, "JWKS URL");
  const keySet = createRemoteJWKSet(jwksUrl, {
    timeoutDuration: 5_000,
    cooldownDuration: 30_000,
  });
  const resourceMetadataUrl = protectedResourceMetadataUrl(options.resource);
  const maxTokenAgeSeconds = options.maxTokenAgeSeconds ?? 3_600;

  async function verifyToken(token: string): Promise<AuthInfo> {
    const verified = await jwtVerify(token, keySet, {
      issuer,
      audience: options.resource.href,
      algorithms: asymmetricJwtAlgorithms,
      requiredClaims: ["sub", "exp", "iat"],
      clockTolerance: 5,
    });
    const { payload } = verified;
    if (
      typeof payload.sub !== "string" ||
      !payload.sub ||
      typeof payload.exp !== "number" ||
      typeof payload.iat !== "number" ||
      payload.exp <= payload.iat ||
      payload.exp - payload.iat > maxTokenAgeSeconds ||
      payload.iat > Date.now() / 1_000 + 5
    ) {
      throw new Error("Access token lifetime exceeds the configured maximum.");
    }
    const subject = payload.sub;
    const tenant = stringClaim(payload.tid) ?? stringClaim(payload.org_id) ?? "";
    return {
      token,
      clientId:
        stringClaim(payload.client_id) ?? stringClaim(payload.azp) ?? subject,
      scopes: readScopes(payload.scope, payload.scp),
      expiresAt: payload.exp,
      resource: options.resource,
      extra: {
        principalId: principalId(issuer, tenant, subject),
      },
    };
  }

  return {
    metadataPath: new URL(resourceMetadataUrl).pathname,
    protectedResourceMetadata: {
      resource: options.resource.href,
      authorization_servers: [issuer],
      bearer_methods_supported: ["header"],
      scopes_supported: [ACCESS_SCOPE],
      resource_name: "Bright MCP",
    },
    authorizationEndpoint,
    tokenEndpoint,

    async authenticateToken(token: string) {
      try {
        const authInfo = await verifyToken(token);
        return missingScopes(authInfo, [ACCESS_SCOPE]).length
          ? undefined
          : authInfo;
      } catch {
        return undefined;
      }
    },

    async authenticate(request: Request): Promise<AuthInfo | Response> {
      const authorization = request.headers.get("authorization");
      const match = /^Bearer ([^\s]+)$/.exec(authorization ?? "");
      if (!match) {
        return challenge(401, "invalid_token", "A Bearer access token is required.", [ACCESS_SCOPE], resourceMetadataUrl);
      }
      try {
        const authInfo = await verifyToken(match[1]!);
        const missing = missingScopes(authInfo, [ACCESS_SCOPE]);
        return missing.length
          ? challenge(403, "insufficient_scope", "Additional authorization is required.", [ACCESS_SCOPE], resourceMetadataUrl)
          : authInfo;
      } catch {
        return challenge(401, "invalid_token", "The access token is invalid or expired.", [ACCESS_SCOPE], resourceMetadataUrl);
      }
    },

    requireScopes(authInfo: AuthInfo, scopes: string[]) {
      const missing = missingScopes(authInfo, scopes);
      return missing.length
        ? challenge(403, "insufficient_scope", "Additional authorization is required.", scopes, resourceMetadataUrl)
        : undefined;
    },
  };
}

function challenge(
  status: 401 | 403,
  error: "invalid_token" | "insufficient_scope",
  description: string,
  scopes: string[],
  resourceMetadataUrl: string,
) {
  const header = [
    `Bearer error="${error}"`,
    `error_description="${description}"`,
    `scope="${scopes.join(" ")}"`,
    `resource_metadata="${resourceMetadataUrl}"`,
  ].join(", ");
  return Response.json(
    { error, error_description: description },
    { status, headers: { "www-authenticate": header, "cache-control": "no-store" } },
  );
}

function readScopes(scope: unknown, scp: unknown) {
  if (typeof scope === "string") return scope.split(/\s+/).filter(Boolean);
  if (Array.isArray(scp)) return scp.filter((value): value is string => typeof value === "string");
  if (typeof scp === "string") return scp.split(/\s+/).filter(Boolean);
  return [];
}

function principalId(issuer: string, tenant: string, subject: string) {
  const digest = new Bun.CryptoHasher("sha256")
    .update(`${issuer}\0${tenant}\0${subject}`)
    .digest("hex");
  return `principal_${digest.slice(0, 32)}`;
}

function stringClaim(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}

function requireHttps(url: URL, label: string) {
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS.`);
  if (url.hash) throw new Error(`${label} must not contain a hash.`);
}

function requiredEndpoint(value: string | undefined, name: string) {
  if (!value) throw new Error(`The authorization server metadata omitted ${name}.`);
  const url = new URL(value);
  requireHttps(url, name);
  return url;
}

function protectedResourceMetadataUrl(resource: URL) {
  const path = resource.pathname === "/" ? "" : resource.pathname;
  return new URL(`/.well-known/oauth-protected-resource${path}`, resource).href;
}

const fetchWithTimeout: FetchLike = (input, init) => {
  const timeout = AbortSignal.timeout(5_000);
  const signal = init?.signal
    ? AbortSignal.any([init.signal, timeout])
    : timeout;
  return fetch(input, { ...init, signal });
};
