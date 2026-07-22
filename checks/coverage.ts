import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { assert, testEnvironment } from "./compatibility-support";

const fixtureSchema = z.object({
  schemaVersion: z.literal(1),
  capabilities: z.array(
    z.object({
      id: z.string().regex(/^[a-z0-9-]+$/),
      referenceCapability: z.string().min(1),
      disposition: z.enum(["composed", "internalized", "excluded"]),
      routes: z.array(z.string().min(1)),
      verification: z.object({ gate: z.string().min(1), scenario: z.string().min(1) }),
      exclusionReason: z.string().min(1).optional(),
      userConsequence: z.string().min(1).optional(),
    }),
  ).min(1),
}).superRefine((fixture, context) => {
  const ids = new Set<string>();
  for (const [index, capability] of fixture.capabilities.entries()) {
    if (ids.has(capability.id)) {
      context.addIssue({ code: "custom", path: ["capabilities", index, "id"], message: "Capability IDs must be unique." });
    }
    ids.add(capability.id);
    if (capability.disposition === "excluded") {
      if (!capability.exclusionReason || !capability.userConsequence) {
        context.addIssue({ code: "custom", path: ["capabilities", index], message: "Excluded capabilities require a reason and user consequence." });
      }
    } else if (capability.routes.length === 0) {
      context.addIssue({ code: "custom", path: ["capabilities", index, "routes"], message: "Covered capabilities require at least one route." });
    }
  }
});

const projectRoot = new URL("../", import.meta.url).pathname;
const fixture = fixtureSchema.parse(
  await Bun.file(
    new URL("../fixtures/capability-coverage.v1.json", import.meta.url),
  ).json(),
);
const surfaces = await Promise.all([collectSurface("all"), collectSurface("browser")]);
const toolNames = new Set(surfaces.flatMap(({ tools }) => tools));
const resourceUris = new Set(surfaces.flatMap(({ resources }) => resources));

for (const capability of fixture.capabilities) {
  for (const route of capability.routes) {
    if (route.startsWith("tool:")) {
      const name = route.slice("tool:".length).split("#", 1)[0]!;
      assert(toolNames.has(name), `${capability.id} references missing tool ${name}.`);
    }
    if (route.startsWith("resource:")) {
      const uri = route.slice("resource:".length);
      assert(resourceUris.has(uri), `${capability.id} references missing resource ${uri}.`);
    }
  }
}

console.log(`Coverage fixture v${fixture.schemaVersion} passed for ${fixture.capabilities.length} capabilities.`);

async function collectSurface(profile: "all" | "browser") {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", "src/main.ts"],
    cwd: projectRoot,
    env: testEnvironment({
      MCP_TRANSPORT: "stdio",
      MCP_PROFILE: profile,
      MCP_BROWSER_PROFILE: "fixture",
    }),
    stderr: "pipe",
  });
  const client = new Client({
    name: `bright-${profile}-coverage-check`,
    version: "0.1.0",
  });
  await client.connect(transport);
  try {
    const [tools, resources, templates] = await Promise.all([
      client.listTools(),
      client.listResources(),
      client.listResourceTemplates(),
    ]);
    return {
      tools: tools.tools.map(({ name }) => name),
      resources: [
        ...resources.resources.map(({ uri }) => uri),
        ...templates.resourceTemplates.map(({ uriTemplate }) => uriTemplate),
      ],
    };
  } finally {
    await client.close();
  }
}
