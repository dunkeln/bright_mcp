import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BrowserUseCases } from "../browser/use-cases";
import { isPublicHttpUrl } from "../core/public-url";
import { reply, requestContext, runTool } from "./support";

const sessionId = z.string().min(1).max(100);
const selector = z.string().trim().min(1).max(500);
const timeoutMs = z.number().int().min(100).max(120_000).default(30_000);

const actionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("click"), selector }),
  z.object({
    kind: z.literal("type"),
    selector,
    text: z.string().max(2_000),
  }),
  z.object({
    kind: z.literal("select"),
    selector,
    value: z.string().max(500),
  }),
  z.object({
    kind: z.literal("press"),
    selector: selector.optional(),
    key: z.enum([
      "Enter",
      "Tab",
      "Escape",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "PageUp",
      "PageDown",
      "Home",
      "End",
      "Backspace",
      "Delete",
      "Space",
    ]),
  }),
  z.object({
    kind: z.literal("wait"),
    selector,
    state: z.enum(["attached", "visible", "hidden"]),
  }),
  z.object({
    kind: z.literal("scroll"),
    deltaY: z.number().int().min(-5_000).max(5_000),
  }),
]);

const navigationOutput = z.object({
  sessionId: z.string(),
  url: z.string(),
  title: z.string(),
  expiresAt: z.string(),
});

const networkEntry = z.object({
  method: z.string(),
  url: z.string(),
  status: z.number().int(),
  contentType: z.string().optional(),
});

const observationOutput = z.object({
  sessionId: z.string(),
  kind: z.enum(["accessibility", "text", "html", "screenshot", "network"]),
  content: z.string().optional(),
  truncated: z.boolean().optional(),
  entries: z.array(networkEntry).optional(),
  resource: z
    .object({
      uri: z.string(),
      mediaType: z.enum(["image/png", "text/plain", "text/html"]),
      expiresAt: z.string(),
    })
    .optional(),
});

export function registerBrowserTools(
  server: McpServer,
  browser: BrowserUseCases,
  principalId: string,
) {
  server.registerTool(
    "browser_navigate",
    {
      title: "Navigate remote browser",
      description:
        "Start a remote browser at one public URL, or move an owned session backward or forward through its history.",
      inputSchema: z.union([
        z.object({
          destination: z.object({
            kind: z.literal("url"),
            url: z
              .url()
              .max(2_048)
              .refine(isPublicHttpUrl, "URL must be a public HTTP(S) URL."),
          }),
          timeoutMs,
        }),
        z.object({
          sessionId,
          destination: z.object({ kind: z.enum(["back", "forward"]) }),
          timeoutMs,
        }),
      ]),
      outputSchema: navigationOutput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, extra) =>
      runTool(async () => {
        const structuredContent = await browser.navigate(
          input,
          requestContext(principalId, extra.signal, extra.authInfo),
        );
        return reply(structuredContent, `Browser is at ${structuredContent.url}.`);
      }),
  );

  server.registerTool(
    "browser_observe",
    {
      title: "Observe remote browser",
      description:
        "Read one bounded accessibility, text, HTML, screenshot, or network observation from an owned remote browser session.",
      inputSchema: z.object({
        sessionId,
        kind: z.enum(["accessibility", "text", "html", "screenshot", "network"]),
        timeoutMs: z.number().int().min(100).max(15_000).default(10_000),
      }),
      outputSchema: observationOutput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input, extra) =>
      runTool(async () => {
        const structuredContent = await browser.observe(
          input,
          requestContext(principalId, extra.signal, extra.authInfo),
        );
        if (structuredContent.resource) {
          return {
            structuredContent,
            content: [
              {
                type: "text" as const,
                text:
                  structuredContent.kind === "screenshot"
                    ? "Captured a bounded browser screenshot."
                    : `Captured a bounded ${structuredContent.kind} preview; the larger observation is available as a resource.`,
              },
              {
                type: "resource_link" as const,
                uri: structuredContent.resource.uri,
                name:
                  structuredContent.kind === "screenshot"
                    ? "Browser screenshot"
                    : `Browser ${structuredContent.kind} observation`,
                mimeType: structuredContent.resource.mediaType,
              },
            ],
          };
        }
        return reply(structuredContent, `Captured a ${structuredContent.kind} observation.`);
      }),
  );

  server.registerTool(
    "browser_interact",
    {
      title: "Interact with remote browser",
      description:
        "Perform exactly one bounded click, type, select, key press, wait, or scroll action in an owned remote browser session.",
      inputSchema: z.object({
        sessionId,
        action: actionSchema,
        timeoutMs: z.number().int().min(100).max(15_000).default(10_000),
      }),
      outputSchema: z.object({
        sessionId: z.string(),
        url: z.string(),
        title: z.string(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input, extra) =>
      runTool(async () => {
        const structuredContent = await browser.interact(
          input,
          requestContext(principalId, extra.signal, extra.authInfo),
        );
        return reply(structuredContent, `Browser action completed at ${structuredContent.url}.`);
      }),
  );

  server.registerTool(
    "browser_close",
    {
      title: "Close remote browser",
      description: "Idempotently close an owned remote browser session.",
      inputSchema: z.object({ sessionId }),
      outputSchema: z.object({ sessionId: z.string(), closed: z.boolean() }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ sessionId }, extra) =>
      runTool(async () => {
        const structuredContent = await browser.close(
          sessionId,
          requestContext(principalId, extra.signal, extra.authInfo),
        );
        return reply(
          structuredContent,
          structuredContent.closed ? "Browser session closed." : "Browser session was already closed.",
        );
      }),
  );

  server.registerResource(
    "browser-observation",
    new ResourceTemplate("brightbrowser://observations/{artifactId}", {
      list: undefined,
    }),
    { description: "Expiring bounded browser observation" },
    async (uri, { artifactId }, extra) => {
      const context = requestContext(principalId, extra.signal, extra.authInfo);
      const artifact = browser.readArtifact(String(artifactId), context.principalId);
      return {
        contents: [
          artifact.mediaType === "image/png"
            ? {
                uri: uri.href,
                mimeType: artifact.mediaType,
                blob: artifact.data.toBase64(),
              }
            : {
                uri: uri.href,
                mimeType: artifact.mediaType,
                text: new TextDecoder().decode(artifact.data),
              },
        ],
      };
    },
  );
}
