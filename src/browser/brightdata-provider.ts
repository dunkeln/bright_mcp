import pLimit from "p-limit";
import { chromium, type Browser, type Page } from "playwright-core";
import type { BrowserCredentialProvider } from "../connections/browser-credentials";
import { CapabilityError } from "../core/contracts";
import {
  isCredentialParameter,
  isPublicHttpUrl,
  isPublicNetworkHttpUrl,
} from "../core/public-url";
import type {
  BrowserAction,
  BrowserNetworkEntry,
  BrowserProvider,
  ProviderObservation,
} from "./contracts";

type RemoteSession = {
  browser: Browser;
  page: Page;
  network: BrowserNetworkEntry[];
};

const MAX_REDIRECTS = 10;
const MAX_PROVIDER_OBSERVATION_CHARS = 100_000;

export function createBrightDataBrowserProvider(
  credentials: BrowserCredentialProvider,
): BrowserProvider {
  const sessions = new Map<string, RemoteSession>();
  const runRemote = pLimit(4);

  return {
    async createAndNavigate(url, timeoutMs, context) {
      return runRemote(async () => {
        const credential = await credentials(context.principalId);
        const endpoint = browserEndpoint(credential);
        let browser: Browser | undefined;
        try {
          const connection = chromium.connectOverCDP(endpoint, {
            timeout: Math.min(timeoutMs, 20_000),
          });
          browser = await abortable(
            connection,
            context.signal,
            () => {
              void connection
                .then((connected) => connected.close())
                .catch(() => undefined);
            },
          );
          const page = await browser.newPage({ acceptDownloads: false });
          await page.route("**/*", async (route) => {
            const request = route.request();
            const mainNavigation =
              request.isNavigationRequest() && request.frame() === page.mainFrame();
            if (
              !isPublicNetworkHttpUrl(request.url()) ||
              (mainNavigation &&
                (!isPublicHttpUrl(request.url()) || redirectDepth(request) > MAX_REDIRECTS))
            ) {
              await route.abort("blockedbyclient");
              return;
            }
            await route.continue();
          });
          page.on("dialog", (dialog) => void dialog.dismiss());
          page.on("download", (download) => void download.cancel());
          const network: BrowserNetworkEntry[] = [];
          page.on("response", (response) => {
            network.push({
              method: response.request().method().slice(0, 20),
              url: redactBrowserUrl(response.url()).slice(0, 2_048),
              status: response.status(),
              contentType: response.headers()["content-type"]?.slice(0, 200),
            });
            if (network.length > 50) network.shift();
          });
          await abortable(
            page.goto(url, {
              waitUntil: "domcontentloaded",
              timeout: Math.min(timeoutMs, 120_000),
            }),
            context.signal,
            () => browser?.close().catch(() => undefined),
          );
          const providerSessionId = crypto.randomUUID();
          sessions.set(providerSessionId, { browser, page, network });
          return {
            providerSessionId,
            url: redactBrowserUrl(page.url()),
            title: await page.title(),
          };
        } catch (error) {
          await browser?.close().catch(() => undefined);
          throw normalizeBrowserError(error);
        }
      });
    },

    async navigateHistory(providerSessionId, direction, timeoutMs, context) {
      return runRemote(async () => {
        const session = requiredSession(sessions, providerSessionId);
        try {
          const response = await abortable(
            direction === "back"
              ? session.page.goBack({
                  waitUntil: "domcontentloaded",
                  timeout: Math.min(timeoutMs, 120_000),
                })
              : session.page.goForward({
                  waitUntil: "domcontentloaded",
                  timeout: Math.min(timeoutMs, 120_000),
                }),
            context.signal,
            () => closeSession(sessions, providerSessionId),
          );
          if (!response) {
            throw new CapabilityError(
              "browser_history_unavailable",
              `No ${direction} browser history is available.`,
              false,
            );
          }
          return {
            url: redactBrowserUrl(session.page.url()),
            title: await session.page.title(),
          };
        } catch (error) {
          throw normalizeBrowserError(error);
        }
      });
    },

    async observe(providerSessionId, kind, timeoutMs, context) {
      return runRemote(async (): Promise<ProviderObservation> => {
        const session = requiredSession(sessions, providerSessionId);
        try {
          if (kind === "screenshot") {
            const data = await abortable(
              session.page.screenshot({
                type: "png",
                fullPage: false,
                timeout: Math.min(timeoutMs, 15_000),
              }),
              context.signal,
              () => closeSession(sessions, providerSessionId),
            );
            return { kind, data };
          }
          if (kind === "network") {
            return { kind, entries: [...session.network] };
          }
          const content = await abortable(
            kind === "accessibility"
              ? session.page.ariaSnapshot({ mode: "ai", timeout: timeoutMs })
              : kind === "text"
                ? session.page.locator("body").innerText({ timeout: timeoutMs })
                : session.page.content(),
            context.signal,
            () => closeSession(sessions, providerSessionId),
          );
          return {
            kind,
            content: content.slice(0, MAX_PROVIDER_OBSERVATION_CHARS),
            truncated: content.length > MAX_PROVIDER_OBSERVATION_CHARS || undefined,
          };
        } catch (error) {
          throw normalizeBrowserError(error);
        }
      });
    },

    async interact(providerSessionId, action, timeoutMs, context) {
      return runRemote(async () => {
        const session = requiredSession(sessions, providerSessionId);
        try {
          await abortable(
            performAction(session.page, action, timeoutMs),
            context.signal,
            () => closeSession(sessions, providerSessionId),
          );
          return {
            url: redactBrowserUrl(session.page.url()),
            title: await session.page.title(),
          };
        } catch (error) {
          throw normalizeBrowserError(error);
        }
      });
    },

    close: (providerSessionId) => closeSession(sessions, providerSessionId),
  };
}

async function performAction(page: Page, action: BrowserAction, timeoutMs: number) {
  const timeout = Math.min(timeoutMs, 15_000);
  if (action.kind === "click") {
    await targetLocator(page, action.ref).then((locator) => locator.click({ timeout }));
  } else if (action.kind === "type") {
    await targetLocator(page, action.ref).then((locator) => locator.fill(action.text, { timeout }));
  } else if (action.kind === "select") {
    await targetLocator(page, action.ref).then((locator) =>
      locator.selectOption(action.value, { timeout }),
    );
  } else if (action.kind === "press") {
    if (action.ref) {
      await targetLocator(page, action.ref).then((locator) =>
        locator.press(action.key, { timeout }),
      );
    } else {
      await page.keyboard.press(action.key);
    }
  } else if (action.kind === "wait") {
    await targetLocator(page, action.ref).then((locator) =>
      locator.waitFor({ state: action.state, timeout }),
    );
  } else {
    await page.mouse.wheel(0, action.deltaY);
  }
}

async function targetLocator(page: Page, ref: string) {
  const locator = page.locator(`aria-ref=${ref}`);
  try {
    await locator.normalize();
  } catch {
    throw new CapabilityError(
      "browser_ref_stale",
      `Ref ${ref} was not found in the current page snapshot.`,
      false,
      "Capture a fresh accessibility observation and use one of its refs.",
    );
  }
  return locator;
}

function requiredSession(
  sessions: Map<string, RemoteSession>,
  providerSessionId: string,
) {
  const session = sessions.get(providerSessionId);
  if (!session) {
    throw new CapabilityError(
      "browser_provider_session_lost",
      "The remote browser session is no longer available.",
      false,
      "Start a new browser session.",
    );
  }
  return session;
}

async function closeSession(
  sessions: Map<string, RemoteSession>,
  providerSessionId: string,
) {
  const session = sessions.get(providerSessionId);
  if (!session) return;
  sessions.delete(providerSessionId);
  await session.browser.close().catch(() => undefined);
}

function browserEndpoint(credential: { username: string; password: string }) {
  return `wss://${encodeURIComponent(credential.username)}:${encodeURIComponent(credential.password)}@brd.superproxy.io:9222`;
}

export function redactBrowserUrl(value: string) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (isCredentialParameter(key)) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    return url.href;
  } catch {
    return "about:blank";
  }
}

async function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort: () => void | Promise<void>,
) {
  if (!signal) return operation;
  if (signal.aborted) {
    await onAbort();
    throw new CapabilityError("cancelled", "Browser operation was cancelled.");
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      void onAbort();
      reject(new CapabilityError("cancelled", "Browser operation was cancelled."));
    };
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

export function normalizeBrowserError(error: unknown) {
  if (error instanceof CapabilityError) return error;
  const message = error instanceof Error ? error.message : "";
  if (/timeout/i.test(message)) {
    return new CapabilityError(
      "browser_timeout",
      "The remote browser did not finish before the bounded timeout.",
      true,
      "Retry once or simplify the browser action.",
    );
  }
  if (/(?:401|403|407|authentication)/i.test(message)) {
    return new CapabilityError(
      "browser_authentication_failed",
      "Bright Data rejected the configured Browser API credentials.",
      false,
      "Replace the Browser API username and password.",
    );
  }
  if (/ERR_BLOCKED_BY_CLIENT/i.test(message)) {
    return new CapabilityError(
      "browser_navigation_blocked",
      "The remote browser blocked a non-public request, credential-bearing navigation, or excessive redirect chain.",
      false,
      "Navigate to a public HTTP(S) URL without embedded credentials.",
    );
  }
  return new CapabilityError(
    "browser_upstream_unavailable",
    "The Bright Data remote browser operation failed.",
    true,
    "Retry once or start a new browser session.",
  );
}

function redirectDepth(request: import("playwright-core").Request) {
  let depth = 0;
  let redirected = request.redirectedFrom();
  while (redirected) {
    depth += 1;
    redirected = redirected.redirectedFrom();
  }
  return depth;
}
