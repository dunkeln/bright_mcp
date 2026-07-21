import { CapabilityError } from "../core/contracts";
import type {
  BrowserAction,
  BrowserProvider,
  ProviderObservation,
} from "./contracts";

type FakeSession = { history: string[]; index: number };

export function createFakeBrowserProvider(): BrowserProvider {
  const sessions = new Map<string, FakeSession>();
  return {
    async createAndNavigate(url) {
      const providerSessionId = crypto.randomUUID();
      sessions.set(providerSessionId, { history: ["about:blank", url], index: 1 });
      return { providerSessionId, url, title: titleFor(url) };
    },
    async navigateHistory(providerSessionId, direction) {
      const session = requiredSession(sessions, providerSessionId);
      const next = session.index + (direction === "back" ? -1 : 1);
      if (next < 0 || next >= session.history.length) {
        throw new CapabilityError(
          "browser_history_unavailable",
          `No ${direction} browser history is available.`,
          false,
        );
      }
      session.index = next;
      const url = session.history[session.index]!;
      return { url, title: titleFor(url) };
    },
    async observe(providerSessionId, kind): Promise<ProviderObservation> {
      const session = requiredSession(sessions, providerSessionId);
      const url = session.history[session.index]!;
      if (kind === "screenshot") {
        return {
          kind,
          data: Uint8Array.fromBase64(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zs5sAAAAASUVORK5CYII=",
          ),
        };
      }
      if (kind === "network") {
        return {
          kind,
          entries: [{ method: "GET", url, status: 200, contentType: "text/html" }],
        };
      }
      const content = kind === "html"
        ? `<main><h1>Demo browser</h1><p>${Bun.escapeHTML(url)}</p></main>`
        : kind === "accessibility"
          ? `- main:\n  - heading "Demo browser"\n  - paragraph "${url}"`
          : `Demo browser\n${url}`;
      return { kind, content };
    },
    async interact(providerSessionId, _action: BrowserAction) {
      const session = requiredSession(sessions, providerSessionId);
      const url = session.history[session.index]!;
      return { url, title: titleFor(url) };
    },
    async close(providerSessionId) {
      sessions.delete(providerSessionId);
    },
  };
}

function requiredSession(sessions: Map<string, FakeSession>, id: string) {
  const session = sessions.get(id);
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

function titleFor(url: string) {
  return url === "about:blank" ? "Blank page" : new URL(url).hostname;
}
