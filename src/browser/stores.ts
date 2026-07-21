import { LRUCache } from "lru-cache";
import { CapabilityError } from "../core/contracts";
import type {
  BrowserArtifactStore,
  BrowserProvider,
  BrowserSession,
  BrowserSessionStore,
} from "./contracts";

const SESSION_TTL_MS = 5 * 60_000;
const ARTIFACT_TTL_MS = 5 * 60_000;

export class LocalBrowserSessionStore implements BrowserSessionStore {
  private readonly sessions: LRUCache<string, BrowserSession>;

  constructor(
    provider: Pick<BrowserProvider, "close">,
    private readonly limits = { global: 10, perPrincipal: 2 },
    private readonly ttlMs = SESSION_TTL_MS,
  ) {
    this.sessions = new LRUCache({
      max: limits.global,
      ttl: ttlMs,
      ttlAutopurge: true,
      dispose: (session, _key, reason) => {
        if (reason !== "delete") void provider.close(session.providerSessionId);
      },
    });
  }

  create(providerSessionId: string, principalId: string) {
    this.sessions.purgeStale();
    const principalCount = [...this.sessions.values()].filter(
      (session) => session.principalId === principalId,
    ).length;
    if (
      this.sessions.size >= this.limits.global ||
      principalCount >= this.limits.perPrincipal
    ) {
      throw new CapabilityError(
        "browser_session_limit",
        "The browser session limit has been reached.",
        true,
        "Close an existing browser session and retry.",
      );
    }
    const session = {
      id: `browser_${crypto.randomUUID()}`,
      providerSessionId,
      principalId,
      expiresAt: new Date(Date.now() + this.ttlMs).toISOString(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  getOwned(sessionId: string, principalId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.principalId !== principalId) throw sessionNotFound();
    return session;
  }

  removeOwned(sessionId: string, principalId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.principalId !== principalId) return undefined;
    this.sessions.delete(sessionId);
    return session;
  }

  drain() {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    return sessions;
  }
}

export class LocalBrowserArtifactStore implements BrowserArtifactStore {
  private readonly artifacts = new LRUCache<
    string,
    { data: Uint8Array; principalId: string; mediaType: "image/png" }
  >({ max: 20, ttl: ARTIFACT_TTL_MS, ttlAutopurge: true });

  save(data: Uint8Array, principalId: string) {
    const id = `observation_${crypto.randomUUID()}`;
    this.artifacts.set(id, { data, principalId, mediaType: "image/png" });
    return {
      uri: `brightbrowser://observations/${id}`,
      mediaType: "image/png" as const,
      expiresAt: new Date(Date.now() + ARTIFACT_TTL_MS).toISOString(),
    };
  }

  read(artifactId: string, principalId: string) {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact || artifact.principalId !== principalId) {
      throw new CapabilityError(
        "browser_observation_not_found",
        "The browser observation is unavailable or expired.",
        false,
        "Create a new browser observation.",
      );
    }
    return { data: artifact.data, mediaType: artifact.mediaType };
  }
}

function sessionNotFound() {
  return new CapabilityError(
    "browser_session_not_found",
    "The browser session is unavailable, expired, or not owned by this principal.",
    false,
    "Start a new browser session with browser_navigate.",
  );
}
