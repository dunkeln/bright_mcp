import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { LRUCache } from "lru-cache";
import type { HttpAuthorization } from "../auth/oidc";
import { requiredScopesForRequest } from "../auth/scopes";
import type { createBrightMcpServer } from "./server";

type McpServer = ReturnType<typeof createBrightMcpServer>;

export function startHttpServer(options: {
  port: number;
  publicUrl?: URL;
  allowedOrigins: Set<string>;
  authorization?: HttpAuthorization;
  connection?: { handle(request: Request): Promise<Response | undefined> };
  widgetHtml: string;
  localPrincipalId: string;
  createServer(): McpServer;
}) {
  const sessions = new LRUCache<
    string,
    {
      principalId: string;
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
    async fetch(request) {
      const url = new URL(request.url);
      const rejectedEdgeRequest = validateHostedEdge(
        request,
        options.publicUrl,
        options.allowedOrigins,
      );
      if (rejectedEdgeRequest) return rejectedEdgeRequest;
      const connectionResponse = await options.connection?.handle(request);
      if (connectionResponse) return connectionResponse;
      if (
        options.authorization &&
        request.method === "GET" &&
        url.pathname === options.authorization.metadataPath
      ) {
        return withCors(
          Response.json(options.authorization.protectedResourceMetadata, {
            headers: { "cache-control": "public, max-age=300" },
          }),
          request,
          true,
          options.allowedOrigins,
        );
      }
      if (request.method === "GET" && url.pathname === "/") {
        return new Response("Bright MCP", { status: 200 });
      }
      if (request.method === "GET" && url.pathname === "/widget") {
        return new Response(options.widgetHtml, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (request.method === "OPTIONS" && url.pathname === "/mcp") {
        return withCors(
          new Response(null, { status: 204 }),
          request,
          options.authorization !== undefined,
          options.allowedOrigins,
        );
      }
      if (url.pathname !== "/mcp") {
        return new Response("Not found", { status: 404 });
      }

      let authInfo: AuthInfo | undefined;
      if (options.authorization) {
        const authenticated = await options.authorization.authenticate(request);
        if (authenticated instanceof Response) {
          return withCors(authenticated, request, true, options.allowedOrigins);
        }
        authInfo = authenticated;
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
            options.authorization !== undefined,
            options.allowedOrigins,
          );
        }
      }
      if (options.authorization && authInfo) {
        const insufficient = options.authorization.requireScopes(
          authInfo,
          requiredScopesForRequest(parsedBody),
        );
        if (insufficient) {
          return withCors(insufficient, request, true, options.allowedOrigins);
        }
      }

      const sessionId = request.headers.get("mcp-session-id");
      let session = sessionId ? sessions.get(sessionId) : undefined;
      const requestPrincipal = authenticatedPrincipal(
        authInfo,
        options.localPrincipalId,
      );
      if (sessionId && (!session || session.principalId !== requestPrincipal)) {
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
          options.authorization !== undefined,
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
            options.authorization !== undefined,
            options.allowedOrigins,
          );
        }
        const server = options.createServer();
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized(id) {
            sessions.set(id, {
              principalId: requestPrincipal,
              server,
              transport,
            });
          },
          onsessionclosed(id) {
            sessions.delete(id);
          },
        });
        session = { principalId: requestPrincipal, server, transport };
        await server.connect(transport);
      }
      const response = await session.transport.handleRequest(request, {
        authInfo,
        parsedBody,
      });
      return withCors(
        response,
        request,
        options.authorization !== undefined,
        options.allowedOrigins,
      );
    },
  });

  console.error(`Bright MCP listening on http://localhost:${options.port}/mcp`);
  return {
    close() {
      sessions.clear();
      httpServer.stop(true);
    },
  };
}

function authenticatedPrincipal(
  authInfo: AuthInfo | undefined,
  localPrincipalId: string,
) {
  const authenticated = authInfo?.extra?.principalId;
  return typeof authenticated === "string" ? authenticated : localPrincipalId;
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
    "authorization, content-type, mcp-protocol-version, mcp-session-id",
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
