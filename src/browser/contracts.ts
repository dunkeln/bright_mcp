import type { RequestContext } from "../core/contracts";

export type BrowserAction =
  | { kind: "click"; ref: string }
  | { kind: "type"; ref: string; text: string }
  | { kind: "select"; ref: string; value: string }
  | { kind: "press"; ref?: string; key: string }
  | {
      kind: "wait";
      ref: string;
      state: "attached" | "visible" | "hidden";
    }
  | { kind: "scroll"; deltaY: number };

export type BrowserNetworkEntry = {
  method: string;
  url: string;
  status: number;
  contentType?: string;
};

export type ProviderObservation =
  | {
      kind: "accessibility" | "text" | "html";
      content: string;
      truncated?: boolean;
    }
  | { kind: "network"; entries: BrowserNetworkEntry[] }
  | { kind: "screenshot"; data: Uint8Array };

export type BrowserArtifactMediaType =
  | "image/png"
  | "text/plain"
  | "text/html";

export type BrowserProvider = {
  createAndNavigate(
    url: string,
    timeoutMs: number,
    context: RequestContext,
  ): Promise<{ providerSessionId: string; url: string; title: string }>;
  navigateHistory(
    providerSessionId: string,
    direction: "back" | "forward",
    timeoutMs: number,
    context: RequestContext,
  ): Promise<{ url: string; title: string }>;
  observe(
    providerSessionId: string,
    kind: ProviderObservation["kind"],
    timeoutMs: number,
    context: RequestContext,
  ): Promise<ProviderObservation>;
  interact(
    providerSessionId: string,
    action: BrowserAction,
    timeoutMs: number,
    context: RequestContext,
  ): Promise<{ url: string; title: string }>;
  close(providerSessionId: string): Promise<void>;
};

export type BrowserSession = {
  id: string;
  providerSessionId: string;
  principalId: string;
  expiresAt: string;
};

export type BrowserSessionStore = {
  create(providerSessionId: string, principalId: string): BrowserSession;
  getOwned(sessionId: string, principalId: string): BrowserSession;
  removeOwned(sessionId: string, principalId: string): BrowserSession | undefined;
  drain(): BrowserSession[];
};

export type BrowserArtifactStore = {
  save(
    data: Uint8Array,
    principalId: string,
    mediaType: BrowserArtifactMediaType,
  ): {
    uri: string;
    mediaType: BrowserArtifactMediaType;
    expiresAt: string;
  };
  read(artifactId: string, principalId: string): {
    data: Uint8Array;
    mediaType: BrowserArtifactMediaType;
  };
};
