import { LRUCache } from "lru-cache";

const SCOPE = "bright:mcp";
const COOKIE = "__Host-bright_byok";
const CODE_TTL_SECONDS = 5 * 60;
const ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_SECONDS = 365 * 24 * 60 * 60;

type Envelope = {
  kind: "client" | "request" | "code" | "access" | "refresh" | "cookie";
  exp: number;
  [key: string]: unknown;
};

export type OAuthService = ReturnType<typeof createOAuthService>;

export function createOAuthService(options: {
  issuer: URL;
  resourceUrls: Set<string>;
  encryptionKey: Uint8Array;
  validateApiKey(apiKey: string): Promise<boolean>;
}) {
  const issuer = new URL(options.issuer.origin);
  const rawKey = new Uint8Array(options.encryptionKey.byteLength);
  rawKey.set(options.encryptionKey);
  const key = crypto.subtle.importKey(
    "raw",
    rawKey,
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
  const usedCodes = new LRUCache<string, true>({
    max: 10_000,
    ttl: CODE_TTL_SECONDS * 1_000,
    ttlAutopurge: true,
  });
  // ponytail: process-local guards fit the single Render instance; use a shared
  // TTL store before scaling auth traffic across multiple instances.
  const rateLimits = new LRUCache<string, { count: number }>({
    max: 20_000,
    ttl: 60_000,
    ttlAutopurge: true,
  });

  return {
    async handle(request: Request): Promise<Response | undefined> {
      const url = new URL(request.url);
      if (
        request.method === "GET" &&
        (url.pathname === "/.well-known/oauth-protected-resource" ||
          url.pathname.startsWith("/.well-known/oauth-protected-resource/"))
      ) {
        const suffix = url.pathname.slice("/.well-known/oauth-protected-resource".length);
        const resource = suffix
          ? `${issuer.origin}${suffix}`
          : `${issuer.origin}/mcp`;
        if (!options.resourceUrls.has(resource)) return notFound();
        return json({
          resource,
          authorization_servers: [issuer.origin],
          bearer_methods_supported: ["header"],
          scopes_supported: [SCOPE],
          resource_name: "Bright MCP",
        });
      }
      if (
        request.method === "GET" &&
        url.pathname === "/.well-known/oauth-authorization-server"
      ) {
        return json({
          issuer: issuer.origin,
          authorization_endpoint: `${issuer.origin}/oauth/authorize`,
          token_endpoint: `${issuer.origin}/oauth/token`,
          registration_endpoint: `${issuer.origin}/oauth/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          scopes_supported: [SCOPE],
        });
      }
      if (url.pathname === "/oauth/register") {
        if (!allow(request, 60)) return tooManyRequests();
        return request.method === "POST" ? register(request) : methodNotAllowed("POST");
      }
      if (url.pathname === "/oauth/authorize") {
        if (!allow(request, request.method === "POST" ? 15 : 120)) {
          return tooManyRequests();
        }
        if (request.method === "GET") return authorizePage(request);
        if (request.method === "POST") return authorize(request);
        return methodNotAllowed("GET, POST");
      }
      if (url.pathname === "/oauth/token") {
        if (!allow(request, 120)) return tooManyRequests();
        return request.method === "POST" ? token(request) : methodNotAllowed("POST");
      }
      return undefined;
    },

    async authenticate(request: Request, resource: string) {
      const authorization = request.headers.get("authorization");
      const bearer = /^Bearer ([^\s]{1,8192})$/.exec(authorization ?? "")?.[1];
      if (!bearer) return undefined;
      const payload = await open(bearer, "access");
      if (
        !payload ||
        payload.resource !== resource ||
        payload.scope !== SCOPE ||
        typeof payload.apiKey !== "string" ||
        typeof payload.clientId !== "string"
      ) return undefined;
      return {
        apiKey: payload.apiKey,
        clientId: payload.clientId,
      };
    },

    challenge(resource: string) {
      const metadata = new URL("/.well-known/oauth-protected-resource", issuer);
      metadata.pathname += new URL(resource).pathname;
      return `Bearer resource_metadata="${metadata}", scope="${SCOPE}"`;
    },
  };

  async function register(request: Request) {
    if (!request.headers.get("content-type")?.startsWith("application/json")) {
      return oauthError("invalid_request", "Client registration requires JSON.");
    }
    const body = await readJson(request, 32_768);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return oauthError("invalid_client_metadata", "Client metadata must be a JSON object.");
    }
    const metadata = body as Record<string, unknown>;
    const redirectUris = metadata.redirect_uris;
    if (
      !Array.isArray(redirectUris) ||
      redirectUris.length < 1 ||
      redirectUris.length > 10 ||
      !redirectUris.every((value) => typeof value === "string" && validRedirect(value))
    ) {
      return oauthError("invalid_client_metadata", "Valid redirect_uris are required.");
    }
    if (
      metadata.token_endpoint_auth_method !== undefined &&
      metadata.token_endpoint_auth_method !== "none"
    ) {
      return oauthError(
        "invalid_client_metadata",
        "Only public clients with token_endpoint_auth_method=none are supported.",
      );
    }
    const clientName = typeof metadata.client_name === "string"
      ? metadata.client_name.trim().slice(0, 120)
      : "MCP client";
    const clientId = await seal({
      kind: "client",
      exp: epoch() + 10 * 365 * 24 * 60 * 60,
      clientName: clientName || "MCP client",
      redirectUris,
    });
    return json({
      client_id: clientId,
      client_id_issued_at: epoch(),
      client_name: clientName || "MCP client",
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }, 201);
  }

  async function authorizePage(request: Request) {
    const url = new URL(request.url);
    const validated = await validateAuthorizationRequest(url.searchParams);
    if ("response" in validated) return validated.response;
    const requestToken = await seal({
      kind: "request",
      exp: epoch() + CODE_TTL_SECONDS,
      ...validated,
    });
    const savedKey = await readCookie(request);
    return html(connectPage({
      clientName: validated.clientName,
      requestToken,
      hasSavedKey: Boolean(savedKey),
    }));
  }

  async function authorize(request: Request) {
    const form = await readForm(request);
    const requestToken = form ? single(form, "request") : undefined;
    const payload = typeof requestToken === "string"
      ? await open(requestToken, "request")
      : undefined;
    if (!payload) return oauthError("invalid_request", "The authorization request expired.");
    const apiKeyInput = form ? single(form, "api_key") : undefined;
    const apiKey = typeof apiKeyInput === "string" && apiKeyInput.trim()
      ? apiKeyInput.trim()
      : await readCookie(request);
    if (!apiKey || !/^[^\s]{1,4096}$/.test(apiKey)) {
      return html(connectPage({
        clientName: String(payload.clientName ?? "MCP client"),
        requestToken: requestToken!,
        hasSavedKey: false,
        error: "Paste a valid Bright Data API key.",
      }), 400);
    }
    if (!(await options.validateApiKey(apiKey))) {
      return html(connectPage({
        clientName: String(payload.clientName ?? "MCP client"),
        requestToken: requestToken!,
        hasSavedKey: false,
        error: "Bright Data rejected that key. Check it and try again.",
      }), 401);
    }
    const code = await seal({
      kind: "code",
      exp: epoch() + CODE_TTL_SECONDS,
      apiKey,
      clientId: payload.clientId,
      redirectUri: payload.redirectUri,
      codeChallenge: payload.codeChallenge,
      resource: payload.resource,
      scope: SCOPE,
      jti: crypto.randomUUID(),
    });
    const redirect = new URL(String(payload.redirectUri));
    redirect.searchParams.set("code", code);
    if (typeof payload.state === "string") redirect.searchParams.set("state", payload.state);
    const response = Response.redirect(redirect, 302);
    response.headers.set(
      "set-cookie",
      `${COOKIE}=${await seal({
        kind: "cookie",
        exp: epoch() + REFRESH_TTL_SECONDS,
        apiKey,
      })}; Path=/; Max-Age=${REFRESH_TTL_SECONDS}; Secure; HttpOnly; SameSite=Lax`,
    );
    response.headers.set("cache-control", "no-store");
    return response;
  }

  async function token(request: Request) {
    const form = await readForm(request);
    if (!form) return oauthError("invalid_request", "A form-encoded token request is required.");
    const grantType = single(form, "grant_type");
    if (grantType === "authorization_code") {
      const code = single(form, "code");
      const clientId = single(form, "client_id");
      const verifier = single(form, "code_verifier");
      const redirectUri = single(form, "redirect_uri");
      const resource = single(form, "resource");
      const payload = typeof code === "string" ? await open(code, "code") : undefined;
      if (
        !payload ||
        typeof clientId !== "string" ||
        clientId !== payload.clientId ||
        typeof verifier !== "string" ||
        typeof redirectUri !== "string" ||
        redirectUri !== payload.redirectUri ||
        typeof resource !== "string" ||
        resource !== payload.resource ||
        !options.resourceUrls.has(resource) ||
        typeof payload.codeChallenge !== "string" ||
        !constantTimeEqual(await pkceChallenge(verifier), payload.codeChallenge) ||
        typeof payload.jti !== "string" ||
        usedCodes.has(payload.jti) ||
        typeof payload.apiKey !== "string"
      ) {
        return oauthError("invalid_grant", "The authorization code is invalid or expired.");
      }
      usedCodes.set(payload.jti, true);
      return issueTokens(payload.apiKey, clientId, resource);
    }
    if (grantType === "refresh_token") {
      const refresh = single(form, "refresh_token");
      const clientId = single(form, "client_id");
      const resource = single(form, "resource");
      const payload = typeof refresh === "string"
        ? await open(refresh, "refresh")
        : undefined;
      if (
        !payload ||
        typeof clientId !== "string" ||
        clientId !== payload.clientId ||
        typeof resource !== "string" ||
        resource !== payload.resource ||
        !options.resourceUrls.has(resource) ||
        typeof payload.apiKey !== "string"
      ) {
        return oauthError("invalid_grant", "The refresh token is invalid or expired.");
      }
      return issueTokens(payload.apiKey, clientId, resource);
    }
    return oauthError("unsupported_grant_type", "Unsupported OAuth grant type.");
  }

  async function issueTokens(apiKey: string, clientId: string, resource: string) {
    const accessToken = await seal({
      kind: "access",
      exp: epoch() + ACCESS_TTL_SECONDS,
      apiKey,
      clientId,
      resource,
      scope: SCOPE,
    });
    const refreshToken = await seal({
      kind: "refresh",
      exp: epoch() + REFRESH_TTL_SECONDS,
      apiKey,
      clientId,
      resource,
      scope: SCOPE,
    });
    return json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: SCOPE,
    });
  }

  async function validateAuthorizationRequest(params: URLSearchParams) {
    const clientId = single(params, "client_id");
    const client = clientId ? await open(clientId, "client") : undefined;
    const redirectUri = single(params, "redirect_uri");
    const resource = single(params, "resource");
    const codeChallenge = single(params, "code_challenge");
    const scope = optionalSingle(params, "scope");
    const state = optionalSingle(params, "state");
    if (
      single(params, "response_type") !== "code" ||
      !client ||
      !Array.isArray(client.redirectUris) ||
      typeof redirectUri !== "string" ||
      !client.redirectUris.includes(redirectUri) ||
      typeof resource !== "string" ||
      !options.resourceUrls.has(resource) ||
      single(params, "code_challenge_method") !== "S256" ||
      typeof codeChallenge !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge) ||
      scope === undefined ||
      (scope ?? SCOPE) !== SCOPE ||
      state === undefined
    ) {
      return {
        response: oauthError("invalid_request", "The OAuth authorization request is invalid."),
      };
    }
    return {
      clientId,
      clientName: typeof client.clientName === "string" ? client.clientName : "MCP client",
      redirectUri,
      resource,
      codeChallenge,
      state: state ?? undefined,
    };
  }

  async function readCookie(request: Request) {
    const value = request.headers
      .get("cookie")
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1);
    const payload = value ? await open(value, "cookie") : undefined;
    return typeof payload?.apiKey === "string" ? payload.apiKey : undefined;
  }

  function allow(request: Request, limit: number) {
    const address = request.headers.get("cf-connecting-ip") ??
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      "direct";
    const name = `${address}:${new URL(request.url).pathname}:${request.method}`;
    const bucket = rateLimits.get(name) ?? { count: 0 };
    bucket.count += 1;
    rateLimits.set(name, bucket);
    return bucket.count <= limit;
  }

  async function seal(payload: Envelope) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key, plaintext),
    );
    return `brt1.${base64url(concat(iv, ciphertext))}`;
  }

  async function open(token: string, kind: Envelope["kind"]) {
    if (!token.startsWith("brt1.")) return undefined;
    try {
      const bytes = decodeBase64url(token.slice(5));
      if (bytes.byteLength <= 12) return undefined;
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes.slice(0, 12) },
        await key,
        bytes.slice(12),
      );
      const payload = JSON.parse(new TextDecoder().decode(plaintext)) as Envelope;
      if (payload.kind !== kind || payload.exp < epoch()) return undefined;
      return payload;
    } catch {
      return undefined;
    }
  }
}

export function readOAuthEncryptionKey(value: string | undefined) {
  if (!value) throw new Error("OAUTH_TOKEN_SECRET is required for hosted OAuth.");
  const key = decodeBase64url(value);
  if (key.byteLength !== 32) {
    throw new Error("OAUTH_TOKEN_SECRET must be a base64url-encoded 32-byte key.");
  }
  return key;
}

function validRedirect(value: string) {
  try {
    const url = new URL(value);
    if (url.hash || url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    if (url.protocol === "http:") {
      return url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "[::1]";
    }
    return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) &&
      url.protocol !== "javascript:" &&
      url.protocol !== "data:" &&
      url.protocol !== "file:";
  } catch {
    return false;
  }
}

async function readJson(request: Request, maxBytes: number) {
  const text = await readBody(request, maxBytes);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

async function readForm(request: Request) {
  if (
    !request.headers
      .get("content-type")
      ?.startsWith("application/x-www-form-urlencoded")
  ) return undefined;
  const text = await readBody(request, 32_768);
  if (text === undefined) return undefined;
  return new URLSearchParams(text);
}

function single(params: URLSearchParams, name: string) {
  const values = params.getAll(name);
  return values.length === 1 ? values[0]! : null;
}

function optionalSingle(params: URLSearchParams, name: string) {
  const values = params.getAll(name);
  return values.length <= 1 ? values[0] ?? null : undefined;
}

async function readBody(request: Request, maxBytes: number) {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) return undefined;
  const text = await request.text();
  return new TextEncoder().encode(text).byteLength <= maxBytes ? text : undefined;
}

async function pkceChallenge(verifier: string) {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return "";
  return base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let different = 0;
  for (let index = 0; index < left.length; index += 1) {
    different |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return different === 0;
}

function concat(left: Uint8Array, right: Uint8Array) {
  const value = new Uint8Array(left.length + right.length);
  value.set(left);
  value.set(right, left.length);
  return value;
}

function base64url(value: Uint8Array) {
  return Buffer.from(value).toString("base64url");
}

function decodeBase64url(value: string) {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

function epoch() {
  return Math.floor(Date.now() / 1_000);
}

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
    },
  });
}

function oauthError(error: string, errorDescription: string) {
  return json({ error, error_description: errorDescription }, 400);
}

function notFound() {
  return new Response("Not found", { status: 404 });
}

function methodNotAllowed(allow: string) {
  return new Response("Method not allowed", {
    status: 405,
    headers: { allow },
  });
}

function tooManyRequests() {
  return Response.json(
    {
      error: "temporarily_unavailable",
      error_description: "Too many authorization requests. Retry shortly.",
    },
    {
      status: 429,
      headers: {
        "cache-control": "no-store",
        "retry-after": "60",
      },
    },
  );
}

function html(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function connectPage(options: {
  clientName: string;
  requestToken: string;
  hasSavedKey: boolean;
  error?: string;
}) {
  const saved = options.hasSavedKey
    ? `<p class="saved">A saved Bright key is ready on this browser. Continue, or paste a replacement below.</p>`
    : "";
  const error = options.error ? `<p class="error" role="alert">${escapeHtml(options.error)}</p>` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Connect Bright MCP</title>
  <style>
    *{box-sizing:border-box}body{--bg:#141414;--line:#ffffff17;--muted:#aaa;background:var(--bg);color:#f2f2f2;font-family:Inter,Arial,sans-serif;margin:0;min-height:100vh}
    header{background:#151515;border-bottom:1px solid var(--line)}.rail{border-inline:1px solid var(--line);margin:auto;max-width:1280px;width:100%}
    .brand{align-items:center;display:flex;font-size:22px;font-weight:700;gap:16px;height:64px;padding:0 16px}.mark{background:#263348;border-radius:7px;display:grid;height:32px;place-items:center;width:32px}
    main{align-items:center;background-image:radial-gradient(#ffffff0c 1px,transparent 1px);background-size:16px 16px;display:grid;min-height:calc(100vh - 64px);padding:48px 20px}
    section{background:#202020;border:1px solid var(--line);border-radius:7px;margin:auto;max-width:480px;padding:32px;width:100%}
    .label{color:#8da8c7;font:500 11px/1.2 SFMono-Regular,Consolas,monospace;text-transform:uppercase}h1{font-size:28px;line-height:1.1;margin:12px 0}p{color:#c7c7c7;font-size:14px;line-height:1.5}
    label{display:block;font-size:13px;margin:24px 0 8px}input{background:#151515;border:1px solid #ffffff24;border-radius:7px;color:#fff;font:14px SFMono-Regular,Consolas,monospace;padding:12px;width:100%}
    input:focus{border-color:#8da8c7;outline:2px solid #8da8c733}button{background:#f4f4f4;border:0;border-radius:7px;color:#171717;cursor:pointer;font-size:14px;font-weight:600;margin-top:16px;padding:12px 16px;width:100%}
    button:hover{background:#fff}.saved{background:#263348;border:1px solid #8da8c744;border-radius:7px;padding:10px 12px}.error{color:#ffadad}.fine{color:#777;font-size:12px;margin:16px 0 0}
    @media(max-width:760px){.rail{border-inline:0}section{padding:24px}}
  </style>
</head>
<body>
  <header><div class="rail brand"><span class="mark">b</span>Bright MCP</div></header>
  <main class="rail">
    <section>
      <div class="label">Client-owned access</div>
      <h1>Connect ${escapeHtml(options.clientName)}</h1>
      <p>Paste your Bright Data API key once. Bright MCP validates it, then returns an encrypted OAuth credential to your MCP client.</p>
      ${saved}${error}
      <form method="post" action="/oauth/authorize">
        <input type="hidden" name="request" value="${escapeHtml(options.requestToken)}">
        <label for="api_key">${options.hasSavedKey ? "Replace Bright Data API key (optional)" : "Bright Data API key"}</label>
        <input id="api_key" name="api_key" type="password" ${options.hasSavedKey ? "" : "required"} autocomplete="off" spellcheck="false">
        <button type="submit">${options.hasSavedKey ? "Continue with saved key" : "Connect Bright"}</button>
      </form>
      <p class="fine">The service keeps no credential database. Your key is sealed into credentials stored by this browser and your MCP client.</p>
    </section>
  </main>
</body>
</html>`;
}

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
}
