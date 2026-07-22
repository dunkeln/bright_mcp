import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { LRUCache } from "lru-cache";
import {
  MCP_PROFILE_PATHS,
  type McpProfile,
  type createBrightMcpServer,
} from "./server";
import { schemaCompatibleTransport } from "./schema-transport";

type McpServer = ReturnType<typeof createBrightMcpServer>;

export function startHttpServer(options: {
  port: number;
  publicUrl?: URL;
  allowedOrigins: Set<string>;
  requestCredentials?: {
    bind(apiKey: string | null, browserZone?: string): {
      principalId: string;
      run<T>(operation: () => Promise<T>): Promise<T>;
    } | undefined;
  };
  browserAvailable: boolean;
  widgetHtml: string;
  localPrincipalId: string;
  createServer(principalId: string, profile: McpProfile): McpServer;
}) {
  const sessions = new LRUCache<
    string,
    {
      principalId: string;
      profile: McpProfile;
      server: McpServer;
      transport: WebStandardStreamableHTTPServerTransport;
    }
  >({
    max: 1_000,
    ttl: 60 * 60_000,
    updateAgeOnGet: true,
    ttlAutopurge: true,
    dispose: ({ server }) => void server.close().catch(() => undefined),
  });

  const httpServer = Bun.serve({
    port: options.port,
    idleTimeout: 40,
    async fetch(request) {
      const url = new URL(request.url);
      const rejectedEdgeRequest = validateHostedEdge(
        request,
        options.publicUrl,
        options.allowedOrigins,
      );
      if (rejectedEdgeRequest) return rejectedEdgeRequest;
      if (request.method === "GET" && url.pathname === "/") {
        return new Response("Bright MCP", { status: 200 });
      }
      if (request.method === "GET" && url.pathname === "/widget") {
        return new Response(options.widgetHtml, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      const profile = MCP_PROFILE_PATHS[url.pathname];
      if (profile === "browser" && !options.browserAvailable) {
        return new Response("Not found", { status: 404 });
      }
      if (request.method === "OPTIONS" && profile) {
        return withCors(
          new Response(null, { status: 204 }),
          request,
          isProtected(profile, options),
          options.allowedOrigins,
        );
      }
      if (!profile) {
        return new Response("Not found", { status: 404 });
      }

      const protectedMode = isProtected(profile, options);
      let credentialBinding: ReturnType<
        NonNullable<typeof options.requestCredentials>["bind"]
      > = undefined;
      if (protectedMode) {
        const browserZone = profile === "browser"
          ? url.searchParams.get("zone")?.trim() || undefined
          : undefined;
        if (browserZone && !/^[A-Za-z0-9_-]{1,128}$/.test(browserZone)) {
          return withCors(
            Response.json(
              {
                error: "invalid_request",
                error_description: "The Browser API zone preference is invalid.",
              },
              { status: 400 },
            ),
            request,
            true,
            options.allowedOrigins,
          );
        }
        credentialBinding = options.requestCredentials?.bind(
          request.headers.get("x-bright-api-key"),
          browserZone,
        );
        if (!credentialBinding) {
          return withCors(
            new Response("Bright Data API key required", {
              status: 401,
              headers: {
                "cache-control": "no-store",
              },
            }),
            request,
            true,
            options.allowedOrigins,
          );
        }
      }

      let parsedBody: unknown;
      if (request.method === "POST") {
        try {
          parsedBody = await readBoundedJson(request, 1_000_000);
        } catch {
          return withCors(
            Response.json(
              {
                error: "invalid_request",
                error_description: "The MCP request body is invalid or too large.",
              },
              { status: 400 },
            ),
            request,
            protectedMode,
            options.allowedOrigins,
          );
        }
      }
      const sessionId = request.headers.get("mcp-session-id");
      let session = sessionId ? sessions.get(sessionId) : undefined;
      const requestPrincipal = credentialBinding?.principalId ?? options.localPrincipalId;
      if (
        sessionId &&
        (!session ||
          session.principalId !== requestPrincipal ||
          session.profile !== profile)
      ) {
        return withCors(
          Response.json(
            {
              jsonrpc: "2.0",
              error: { code: -32_000, message: "Session not found." },
              id: null,
            },
            { status: 404 },
          ),
          request,
          protectedMode,
          options.allowedOrigins,
        );
      }
      if (!session) {
        if (!isInitializeRequest(parsedBody)) {
          return withCors(
            Response.json(
              {
                jsonrpc: "2.0",
                error: {
                  code: -32_000,
                  message: "Initialize an MCP session first.",
                },
                id: null,
              },
              { status: 400 },
            ),
            request,
            protectedMode,
            options.allowedOrigins,
          );
        }
        const server = options.createServer(requestPrincipal, profile);
        const transport = schemaCompatibleTransport(
          new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            enableJsonResponse: true,
            onsessioninitialized(id) {
              sessions.set(id, {
                principalId: requestPrincipal,
                profile,
                server,
                transport,
              });
            },
            onsessionclosed(id) {
              sessions.delete(id);
            },
          }),
        );
        session = { principalId: requestPrincipal, profile, server, transport };
        await server.connect(transport);
      }
      const handleRequest = () => session.transport.handleRequest(request, { parsedBody });
      const response = credentialBinding
        ? await credentialBinding.run(handleRequest)
        : await handleRequest();
      return withCors(
        response,
        request,
        protectedMode,
        options.allowedOrigins,
      );
    },
  });

  console.error(
    `Bright MCP listening on http://localhost:${options.port}/mcp{/web,/deep-lookup,/marketplace,/browser}`,
  );
  return {
    close() {
      sessions.clear();
      httpServer.stop(true);
    },
  };
}

function isProtected(
  profile: McpProfile,
  options: {
    requestCredentials?: unknown;
  },
) {
  return Boolean(options.requestCredentials);
}

function validateHostedEdge(
  request: Request,
  publicUrl: URL | undefined,
  origins: Set<string>,
) {
  if (!publicUrl) return undefined;
  if (request.headers.get("host") !== publicUrl.host) {
    return new Response("Misdirected request", { status: 421 });
  }
  const origin = request.headers.get("origin");
  if (origin && !origins.has(origin)) {
    return new Response("Origin not allowed", { status: 403 });
  }
  return undefined;
}

function withCors(
  response: Response,
  request: Request,
  protectedMode: boolean,
  origins: Set<string>,
) {
  const headers = new Headers(response.headers);
  const origin = request.headers.get("origin");
  if (!protectedMode) {
    headers.set("access-control-allow-origin", "*");
  } else if (origin && origins.has(origin)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "origin");
  }
  headers.set("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  headers.set(
    "access-control-allow-headers",
    "content-type, mcp-protocol-version, mcp-session-id, x-bright-api-key",
  );
  headers.set("access-control-expose-headers", "mcp-session-id, www-authenticate");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function readBoundedJson(request: Request, maxBytes: number) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("Request body too large.");
  }
  if (!request.body) throw new Error("Request body is required.");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new Error("Request body too large.");
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();
  return JSON.parse(text) as unknown;
}
