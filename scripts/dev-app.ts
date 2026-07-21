import { watch } from "node:fs";
import { buildAppAssets } from "./app-build";

const outputDirectory = new URL("../.cache/app-preview/", import.meta.url);
const entrypoint = new URL("../src/app/dev.tsx", import.meta.url);
const sourceDirectory = new URL("../src/", import.meta.url);
const port = readPort(process.env.APP_PORT);
let assets = await buildAppAssets({
  entrypoint,
  outputDirectory,
  minify: false,
});

const reloadClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const encoder = new TextEncoder();
const server = Bun.serve({
  port,
  idleTimeout: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/") {
      return new Response(previewHtml(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (path === "/dataset-table.css") {
      return assetResponse(assets.css, "text/css; charset=utf-8");
    }
    if (path === "/dataset-table.js") {
      return assetResponse(assets.javascript, "text/javascript; charset=utf-8");
    }
    if (path === "/__reload") {
      let client: ReadableStreamDefaultController<Uint8Array>;
      return new Response(
        new ReadableStream({
          start(controller) {
            client = controller;
            reloadClients.add(controller);
            controller.enqueue(encoder.encode(": connected\n\n"));
          },
          cancel() {
            reloadClients.delete(client);
          },
        }),
        {
          headers: {
            "cache-control": "no-cache",
            "content-type": "text/event-stream",
          },
        },
      );
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`Dataset table preview: ${server.url}`);

let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
let building = false;
let rebuildQueued = false;
const sourceWatcher = watch(sourceDirectory, { recursive: true }, () => {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => void rebuild(), 75);
});

await new Promise<void>((resolve) => {
  process.once("SIGINT", resolve);
  process.once("SIGTERM", resolve);
});

if (rebuildTimer) clearTimeout(rebuildTimer);
sourceWatcher.close();
server.stop(true);
for (const client of reloadClients) client.close();

async function rebuild() {
  if (building) {
    rebuildQueued = true;
    return;
  }
  building = true;
  do {
    rebuildQueued = false;
    try {
      assets = await buildAppAssets({
        entrypoint,
        outputDirectory,
        minify: false,
      });
      for (const client of reloadClients) {
        client.enqueue(encoder.encode("data: reload\n\n"));
      }
      console.log("Rebuilt dataset table preview.");
    } catch (error) {
      console.error(error);
    }
  } while (rebuildQueued);
  building = false;
}

function assetResponse(file: URL, contentType: string) {
  return new Response(Bun.file(file), {
    headers: {
      "cache-control": "no-store",
      "content-type": contentType,
    },
  });
}

function previewHtml() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Bright MCP · Dataset table preview</title>
    <link rel="stylesheet" href="/dataset-table.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/dataset-table.js"></script>
    <script>new EventSource("/__reload").onmessage = () => location.reload();</script>
  </body>
</html>`;
}

function readPort(value: string | undefined) {
  const parsed = Number(value || "3000");
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("APP_PORT must be an integer between 1 and 65535.");
  }
  return parsed;
}
