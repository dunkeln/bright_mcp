import { CapabilityError, type RequestContext } from "../core/contracts";
import type {
  BrowserAction,
  BrowserArtifactStore,
  BrowserProvider,
  BrowserSessionStore,
  ProviderObservation,
} from "./contracts";

const MAX_OBSERVATION_CHARS = 50_000;
const MAX_SCREENSHOT_BYTES = 5_000_000;

export function createBrowserUseCases(dependencies: {
  provider: BrowserProvider;
  sessions: BrowserSessionStore;
  artifacts: BrowserArtifactStore;
}) {
  return {
    async navigate(
      input:
        | { destination: { kind: "url"; url: string }; timeoutMs: number }
        | {
            sessionId: string;
            destination: { kind: "back" | "forward" };
            timeoutMs: number;
          },
      context: RequestContext,
    ) {
      if (!("sessionId" in input)) {
        const created = await dependencies.provider.createAndNavigate(
          input.destination.url,
          input.timeoutMs,
          context,
        );
        try {
          const session = dependencies.sessions.create(
            created.providerSessionId,
            context.principalId,
          );
          return {
            sessionId: session.id,
            ...boundedState(created),
            expiresAt: session.expiresAt,
          };
        } catch (error) {
          await dependencies.provider.close(created.providerSessionId);
          throw error;
        }
      }

      const session = dependencies.sessions.getOwned(
        input.sessionId,
        context.principalId,
      );
      const navigated = await dependencies.provider.navigateHistory(
        session.providerSessionId,
        input.destination.kind,
        input.timeoutMs,
        context,
      );
      return {
        sessionId: session.id,
        ...boundedState(navigated),
        expiresAt: session.expiresAt,
      };
    },

    async observe(
      input: {
        sessionId: string;
        kind: ProviderObservation["kind"];
        timeoutMs: number;
      },
      context: RequestContext,
    ) {
      const session = dependencies.sessions.getOwned(
        input.sessionId,
        context.principalId,
      );
      const observation = await dependencies.provider.observe(
        session.providerSessionId,
        input.kind,
        input.timeoutMs,
        context,
      );
      if (observation.kind === "screenshot") {
        if (observation.data.byteLength > MAX_SCREENSHOT_BYTES) {
          throw new CapabilityError(
            "browser_observation_too_large",
            "The browser screenshot exceeded the observation limit.",
            false,
            "Capture a smaller viewport or use a text observation.",
          );
        }
        return {
          sessionId: session.id,
          kind: observation.kind,
          resource: dependencies.artifacts.save(
            observation.data,
            context.principalId,
          ),
        };
      }
      if (observation.kind === "network") {
        return {
          sessionId: session.id,
          kind: observation.kind,
          entries: observation.entries.slice(-50),
        };
      }
      return {
        sessionId: session.id,
        kind: observation.kind,
        content: observation.content.slice(0, MAX_OBSERVATION_CHARS),
        truncated: observation.content.length > MAX_OBSERVATION_CHARS || undefined,
      };
    },

    async interact(
      input: { sessionId: string; action: BrowserAction; timeoutMs: number },
      context: RequestContext,
    ) {
      const session = dependencies.sessions.getOwned(
        input.sessionId,
        context.principalId,
      );
      const result = await dependencies.provider.interact(
        session.providerSessionId,
        input.action,
        input.timeoutMs,
        context,
      );
      return { sessionId: session.id, ...boundedState(result) };
    },

    async close(sessionId: string, context: RequestContext) {
      const session = dependencies.sessions.removeOwned(
        sessionId,
        context.principalId,
      );
      if (!session) return { sessionId, closed: false };
      await dependencies.provider.close(session.providerSessionId);
      return { sessionId, closed: true };
    },

    readArtifact: (artifactId: string, principalId: string) =>
      dependencies.artifacts.read(artifactId, principalId),

    async shutdown() {
      await Promise.allSettled(
        dependencies.sessions
          .drain()
          .map((session) => dependencies.provider.close(session.providerSessionId)),
      );
    },
  };
}

export type BrowserUseCases = ReturnType<typeof createBrowserUseCases>;

function boundedState(value: { url: string; title: string }) {
  return { url: value.url.slice(0, 2_048), title: value.title.slice(0, 500) };
}
