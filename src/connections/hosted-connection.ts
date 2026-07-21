import { LRUCache } from "lru-cache";
import { z } from "zod";
import type { HttpAuthorization } from "../auth/oidc";
import type { EncryptedCredentialVault } from "./encrypted-vault";

const STATE_TTL_MS = 10 * 60_000;
const tokenResponseSchema = z.object({
  access_token: z.string().min(1).max(16_384),
  token_type: z.string().toLowerCase().pipe(z.literal("bearer")),
});

type LoginState = {
  verifier: string;
  expectedPrincipal?: string;
  intent: "connect" | "revoke";
  complete?: () => Promise<void>;
};

type FetchFunction = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function createHostedConnectionService(options: {
  authorization: Pick<
    HttpAuthorization,
    "authorizationEndpoint" | "tokenEndpoint" | "authenticateToken"
  >;
  publicMcpUrl: URL;
  clientId: string;
  clientSecret?: string;
  vault: EncryptedCredentialVault;
  validateCredential(
    apiKey: string,
  ): Promise<"rejected_or_expired" | "permission" | "unavailable" | undefined>;
  fetch?: FetchFunction;
  audit(event: {
    operation: string;
    principalId?: string;
    terminalState: string;
  }): void;
}) {
  const loginStates = new LRUCache<string, LoginState>({
    max: 1_000,
    ttl: STATE_TTL_MS,
  });
  const formStates = new LRUCache<
    string,
    { csrf: string; principalId: string; complete?: () => Promise<void> }
  >({ max: 1_000, ttl: STATE_TTL_MS });
  const baseUrl = new URL("/connections/brightdata", options.publicMcpUrl);
  const callbackUrl = new URL("/connections/brightdata/callback", baseUrl);
  const fetcher = options.fetch ?? fetch;

  return {
    manualUrl: baseUrl.href,

    async createElicitation(
      principalId: string,
      completion: (elicitationId: string) => () => Promise<void>,
    ) {
      const elicitationId = `brightdata_${crypto.randomUUID()}`;
      const state = createLoginState(
        principalId,
        "connect",
        completion(elicitationId),
      );
      return {
        elicitationId,
        url: `${baseUrl.href}?state=${encodeURIComponent(state)}`,
      };
    },

    async handle(request: Request): Promise<Response | undefined> {
      const url = new URL(request.url);
      if (
        url.pathname !== baseUrl.pathname &&
        !url.pathname.startsWith(`${baseUrl.pathname}/`)
      ) {
        return undefined;
      }
      if (request.method === "GET" && url.pathname === baseUrl.pathname) {
        const suppliedState = url.searchParams.get("state");
        const state = suppliedState ?? createLoginState(undefined, "connect");
        return beginAuthorization(state);
      }
      if (
        request.method === "GET" &&
        url.pathname === `${baseUrl.pathname}/revoke`
      ) {
        return beginAuthorization(createLoginState(undefined, "revoke"));
      }
      if (
        request.method === "GET" &&
        url.pathname === callbackUrl.pathname
      ) {
        return finishAuthorization(url);
      }
      if (
        request.method === "POST" &&
        url.pathname === baseUrl.pathname
      ) {
        return storeCredential(request);
      }
      return page(
        404,
        "Connection page not found",
        "Start the connection again from the MCP client.",
      );
    },
  };

  function createLoginState(
    expectedPrincipal: string | undefined,
    intent: LoginState["intent"],
    complete?: () => Promise<void>,
  ) {
    const state = randomToken();
    loginStates.set(state, {
      verifier: randomToken(),
      expectedPrincipal,
      intent,
      complete,
    });
    options.audit({
      operation: `brightdata_connection_${intent}_started`,
      principalId: expectedPrincipal,
      terminalState: "pending",
    });
    return state;
  }

  async function beginAuthorization(state: string) {
    const login = loginStates.get(state);
    if (!login) {
      return page(
        410,
        "Connection expired",
        "Return to the MCP client and retry the request.",
      );
    }
    const authorizationUrl = new URL(options.authorization.authorizationEndpoint);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("client_id", options.clientId);
    authorizationUrl.searchParams.set("redirect_uri", callbackUrl.href);
    authorizationUrl.searchParams.set("scope", "mcp:access");
    authorizationUrl.searchParams.set("resource", options.publicMcpUrl.href);
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    authorizationUrl.searchParams.set(
      "code_challenge",
      base64url(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(login.verifier),
        ),
      ),
    );
    return new Response(null, {
      status: 303,
      headers: {
        location: authorizationUrl.href,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  }

  async function finishAuthorization(url: URL) {
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code") ?? "";
    const login = loginStates.get(state);
    if (!login || !code) {
      return page(
        400,
        "Authorization failed",
        "The connection state or authorization code is missing.",
      );
    }
    loginStates.delete(state);

    const token = await exchangeCode(code, login.verifier);
    if (!token) {
      options.audit({
        operation: "brightdata_connection_authorization",
        principalId: login.expectedPrincipal,
        terminalState: "error",
      });
      return page(
        401,
        "Authorization failed",
        "The identity provider rejected or could not complete the login. Start again.",
      );
    }
    const authInfo = await options.authorization.authenticateToken(token);
    const principalId = authInfo?.extra?.principalId;
    if (
      typeof principalId !== "string" ||
      (login.expectedPrincipal && principalId !== login.expectedPrincipal)
    ) {
      options.audit({
        operation: "brightdata_connection_authorization",
        principalId: login.expectedPrincipal,
        terminalState: "principal_mismatch",
      });
      return page(
        403,
        "Account mismatch",
        "Sign in with the same account that initiated the MCP request.",
      );
    }

    if (login.intent === "revoke") {
      const revoked = options.vault.revoke(principalId);
      options.audit({
        operation: "brightdata_connection_revoked",
        principalId,
        terminalState: revoked ? "success" : "not_found",
      });
      await notifyCompletion(login.complete, principalId);
      return page(
        200,
        "Connection removed",
        "The stored Bright Data token is no longer available to this MCP account.",
      );
    }

    const session = randomToken();
    const csrf = randomToken();
    formStates.set(session, { csrf, principalId, complete: login.complete });
    return tokenForm(session, csrf);
  }

  async function exchangeCode(code: string, verifier: string) {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: options.clientId,
      redirect_uri: callbackUrl.href,
      resource: options.publicMcpUrl.href,
    });
    const headers = new Headers({
      "content-type": "application/x-www-form-urlencoded",
    });
    if (options.clientSecret) {
      headers.set(
        "authorization",
        `Basic ${btoa(`${encodeURIComponent(options.clientId)}:${encodeURIComponent(options.clientSecret)}`)}`,
      );
      body.delete("client_id");
    }
    try {
      const response = await fetcher(options.authorization.tokenEndpoint, {
        method: "POST",
        headers,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return undefined;
      }
      const parsed = tokenResponseSchema.safeParse(
        JSON.parse(await readBoundedText(response, 100_000)),
      );
      return parsed.success ? parsed.data.access_token : undefined;
    } catch {
      return undefined;
    }
  }

  async function storeCredential(request: Request) {
    const session = cookie(
      request.headers.get("cookie"),
      "__Host-bright_mcp_connection",
    );
    let form: URLSearchParams;
    try {
      form = await readBoundedForm(request, 8_192);
    } catch {
      return page(
        400,
        "Invalid submission",
        "Start the Bright Data connection again.",
      );
    }
    const pending = session ? formStates.get(session) : undefined;
    if (!pending || form.get("csrf") !== pending.csrf) {
      return page(
        403,
        "Connection expired",
        "Start the Bright Data connection again.",
      );
    }
    formStates.delete(session!);
    const apiKey = form.get("apiToken")?.trim() ?? "";
    if (!apiKey || apiKey.length > 4_096) {
      return page(
        400,
        "Token rejected",
        "Provide a valid Bright Data API token and start again.",
      );
    }

    const validation = await options.validateCredential(apiKey);
    if (validation) {
      options.audit({
        operation: "brightdata_connection_validation",
        principalId: pending.principalId,
        terminalState: validation,
      });
      return page(400, "Token rejected", validationMessage(validation));
    }
    await options.vault.store(pending.principalId, apiKey);
    options.audit({
      operation: "brightdata_connection_stored",
      principalId: pending.principalId,
      terminalState: "success",
    });
    await notifyCompletion(pending.complete, pending.principalId);
    return page(200, "Bright Data connected", "Return to the MCP client and retry the original request.");
  }

  function tokenForm(session: string, csrf: string) {
    return html(
      200,
      `
        <h1>Connect Bright Data</h1>
        <p>Paste the API token directly into this secure server page. It is validated before encrypted storage and never enters the MCP conversation.</p>
        <form method="post" action="${baseUrl.pathname}">
          <input type="hidden" name="csrf" value="${csrf}">
          <label>Bright Data API token<input name="apiToken" type="password" required maxlength="4096" autocomplete="off"></label>
          <button type="submit">Validate and connect</button>
        </form>
      `,
      { "set-cookie": `__Host-bright_mcp_connection=${session}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600` },
    );
  }

  async function notifyCompletion(
    complete: (() => Promise<void>) | undefined,
    principalId: string,
  ) {
    if (!complete) return;
    try {
      await complete();
    } catch {
      options.audit({
        operation: "brightdata_connection_notification",
        principalId,
        terminalState: "error",
      });
    }
  }
}

function validationMessage(reason: string) {
  if (reason === "rejected_or_expired") {
    return "Bright Data couldn't accept this token. Check that it's current and copied correctly, then try again.";
  }
  if (reason === "permission") {
    return "The token lacks permission for the Bright Data account status check.";
  }
  return "Bright Data could not be reached for validation. Retry the connection later.";
}

function page(status: number, title: string, message: string) {
  return html(status, `<h1>${title}</h1><p>${message}</p>`);
}

function html(status: number, body: string, extraHeaders: HeadersInit = {}) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bright MCP connection</title><style>body{font:16px system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;color:#202124}form,label{display:grid;gap:.75rem}input,button{font:inherit;padding:.75rem}button{cursor:pointer}</style></head><body>${body}</body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        ...Object.fromEntries(new Headers(extraHeaders)),
      },
    },
  );
}

async function readBoundedText(response: Response, maxBytes: number) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error("Response too large.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new Error("Response too large.");
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

async function readBoundedForm(request: Request, maxBytes: number) {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/x-www-form-urlencoded")
  ) {
    throw new Error("Unsupported form content type.");
  }
  const text = await readBoundedText(new Response(request.body), maxBytes);
  return new URLSearchParams(text);
}

function cookie(header: string | null, name: string) {
  return header
    ?.split(";")
    .map((part) => part.trim().split("=", 2))
    .find(([key]) => key === name)?.[1];
}

function randomToken() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

function base64url(value: ArrayBuffer | Uint8Array) {
  return Buffer.from(value instanceof Uint8Array ? value : new Uint8Array(value))
    .toString("base64url");
}
