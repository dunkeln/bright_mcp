import {
  normalizeBrowserError,
  redactBrowserUrl,
} from "../src/browser/brightdata-provider";
import type {
  BrowserAction,
  BrowserProvider,
  ProviderObservation,
} from "../src/browser/contracts";
import {
  LocalBrowserArtifactStore,
  LocalBrowserSessionStore,
} from "../src/browser/stores";
import { createBrowserUseCases } from "../src/browser/use-cases";
import { CapabilityError, type RequestContext } from "../src/core/contracts";
import { assert } from "./compatibility-support";

const probe = createProbeProvider();
const browser = createBrowserUseCases({
  provider: probe.provider,
  sessions: new LocalBrowserSessionStore(
    probe.provider,
    { global: 3, perPrincipal: 2 },
    100,
  ),
  artifacts: new LocalBrowserArtifactStore(),
});
const alpha = requestContext("alpha");
const beta = requestContext("beta");

const first = await browser.navigate(
  {
    destination: { kind: "url", url: "https://example.com/?token=fixture" },
    timeoutMs: 1_000,
  },
  alpha,
);
const firstProviderSession = probe.created.at(-1);
assert(firstProviderSession, "Browser creation omitted its provider session.");
await expectCode(
  browser.observe(
    { sessionId: first.sessionId, kind: "text", timeoutMs: 1_000 },
    beta,
  ),
  "browser_session_not_found",
);

const observed = await browser.observe(
  { sessionId: first.sessionId, kind: "text", timeoutMs: 1_000 },
  alpha,
);
assert(
  observed.kind === "text" && observed.content === "Fixture page",
  "Owned browser observation lost its canonical shape.",
);
const large = await browser.observe(
  { sessionId: first.sessionId, kind: "html", timeoutMs: 1_000 },
  alpha,
);
assert(
  large.kind === "html" && large.truncated && large.resource,
  "A large browser observation did not retain its bounded resource.",
);
if (large.kind === "html" && large.resource) {
  const artifactId = large.resource.uri.split("/").at(-1);
  assert(artifactId, "Large observation resource omitted its opaque ID.");
  const artifact = browser.readArtifact(artifactId, alpha.principalId);
  assert(
    artifact.mediaType === "text/html" && artifact.data.byteLength === 60_000,
    "The large observation resource lost its bounded content or media type.",
  );
}
await browser.interact(
  {
    sessionId: first.sessionId,
    action: { kind: "scroll", deltaY: 250 },
    timeoutMs: 1_000,
  },
  alpha,
);
assert(
  probe.actions[0]?.kind === "scroll" && probe.actions[0].deltaY === 250,
  "The typed browser action changed at the provider boundary.",
);

const screenshot = await browser.observe(
  { sessionId: first.sessionId, kind: "screenshot", timeoutMs: 1_000 },
  alpha,
);
assert(
  screenshot.kind === "screenshot",
  "Screenshot observation did not become a resource.",
);
if (screenshot.kind === "screenshot") {
  const artifactId = screenshot.resource.uri.split("/").at(-1);
  assert(artifactId, "Screenshot resource omitted its opaque ID.");
  await expectCode(
    Promise.resolve().then(() => browser.readArtifact(artifactId, beta.principalId)),
    "browser_observation_not_found",
  );
  assert(
    browser.readArtifact(artifactId, alpha.principalId).data.byteLength === 4,
    "The screenshot resource was not readable by its owner.",
  );
}

await Bun.sleep(120);
await expectCode(
  browser.observe(
    { sessionId: first.sessionId, kind: "text", timeoutMs: 1_000 },
    alpha,
  ),
  "browser_session_not_found",
);
await Bun.sleep(0);
assert(
  probe.closed.includes(firstProviderSession),
  "Session expiry did not attempt provider cleanup.",
);

const controller = new AbortController();
const cancellable = await browser.navigate(
  {
    destination: { kind: "url", url: "https://example.com/cancel" },
    timeoutMs: 1_000,
  },
  { ...alpha, signal: controller.signal },
);
const cancellableProviderSession = probe.created.at(-1);
assert(
  cancellableProviderSession,
  "Cancellable browser creation omitted its provider session.",
);
const cancellation = browser.observe(
  { sessionId: cancellable.sessionId, kind: "network", timeoutMs: 1_000 },
  { ...alpha, signal: controller.signal },
);
controller.abort();
await expectCode(cancellation, "cancelled");
assert(
  probe.closed.includes(cancellableProviderSession),
  "Cancellation did not attempt provider cleanup.",
);

const closeable = await browser.navigate(
  {
    destination: { kind: "url", url: "https://example.com/close" },
    timeoutMs: 1_000,
  },
  alpha,
);
assert(
  (await browser.close(closeable.sessionId, alpha)).closed,
  "Owned browser close did not release its provider session.",
);
assert(
  !(await browser.close(closeable.sessionId, alpha)).closed,
  "Browser close is not idempotent.",
);

const unsafeUrl =
  "https://user:password@example.com/path?token=secret&visible=yes#private";
const safeUrl = redactBrowserUrl(unsafeUrl);
assert(
  safeUrl === "https://example.com/path?token=%5Bredacted%5D&visible=yes",
  "Browser URL redaction exposed credentials, a secret query, or a fragment.",
);
const safeError = normalizeBrowserError(
  new Error("connect wss://user:password@brd.superproxy.io:9222 failed"),
);
assert(
  !safeError.message.includes("password") &&
    !safeError.message.includes("brd.superproxy.io") &&
    safeError.code === "browser_upstream_unavailable",
  "Browser error normalization exposed the CDP endpoint or credential.",
);
assert(
  normalizeBrowserError(new Error("net::ERR_BLOCKED_BY_CLIENT")).code ===
    "browser_navigation_blocked",
  "Blocked redirect navigation did not retain an actionable error code.",
);

await browser.shutdown();
console.log("Browser ownership, lifecycle, and redaction compatibility passed.");

function createProbeProvider() {
  const sessions = new Set<string>();
  const created: string[] = [];
  const actions: BrowserAction[] = [];
  const closed: string[] = [];
  const provider: BrowserProvider = {
    async createAndNavigate(url) {
      const providerSessionId = `provider_${crypto.randomUUID()}`;
      sessions.add(providerSessionId);
      created.push(providerSessionId);
      return { providerSessionId, url, title: "Fixture page" };
    },
    async navigateHistory(providerSessionId) {
      required(providerSessionId);
      return { url: "https://example.com/history", title: "Fixture history" };
    },
    async observe(providerSessionId, kind, _timeoutMs, context) {
      required(providerSessionId);
      if (kind === "network") {
        await waitForCancellation(providerSessionId, context.signal);
      }
      if (kind === "screenshot") {
        return { kind, data: new Uint8Array([137, 80, 78, 71]) };
      }
      if (kind === "network") return { kind, entries: [] };
      if (kind === "html") return { kind, content: "x".repeat(60_000) };
      return { kind, content: "Fixture page" } as ProviderObservation;
    },
    async interact(providerSessionId, action) {
      required(providerSessionId);
      actions.push(action);
      return { url: "https://example.com/", title: "Fixture page" };
    },
    async close(providerSessionId) {
      sessions.delete(providerSessionId);
      closed.push(providerSessionId);
    },
  };

  function required(providerSessionId: string) {
    if (!sessions.has(providerSessionId)) {
      throw new CapabilityError(
        "browser_provider_session_lost",
        "Fixture browser session is unavailable.",
      );
    }
  }

  async function waitForCancellation(
    providerSessionId: string,
    signal: AbortSignal | undefined,
  ) {
    if (!signal) throw new Error("Cancellation probe requires a signal.");
    if (!signal.aborted) {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    }
    await provider.close(providerSessionId);
    throw new CapabilityError("cancelled", "Browser operation was cancelled.");
  }

  return { provider, actions, closed, created };
}

function requestContext(principalId: string): RequestContext {
  return { principalId, requestId: `browser-check-${principalId}` };
}

async function expectCode(operation: Promise<unknown>, expected: string) {
  try {
    await operation;
  } catch (error) {
    assert(error instanceof CapabilityError, `${expected} was not actionable.`);
    assert(error.code === expected, `Expected ${expected}, received ${error.code}.`);
    return;
  }
  throw new Error(`Expected ${expected}, but the operation succeeded.`);
}
