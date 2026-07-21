import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { CapabilityError, type RequestContext } from "../core/contracts";

export function requestContext(
  principalId: string,
  signal?: AbortSignal,
  authInfo?: AuthInfo,
): RequestContext {
  const authenticatedPrincipal = authInfo?.extra?.principalId;
  return {
    principalId:
      typeof authenticatedPrincipal === "string"
        ? authenticatedPrincipal
        : principalId,
    requestId: crypto.randomUUID(),
    signal,
  };
}

export function reply<T extends Record<string, unknown>>(
  structuredContent: T,
  text: string,
) {
  return {
    structuredContent,
    content: [{ type: "text" as const, text }],
  };
}

export async function runTool<T>(
  operation: () => Promise<T>,
  onError?: (
    error: unknown,
  ) => CapabilityError | undefined | Promise<CapabilityError | undefined>,
) {
  try {
    return await operation();
  } catch (error) {
    const replacement = await onError?.(error);
    const failure = replacement ?? (error instanceof CapabilityError
      ? error
      : new CapabilityError(
          "internal_error",
          "The capability failed unexpectedly.",
          true,
          "Retry once. If it fails again, inspect the server logs with the request ID.",
        ));
    return {
      isError: true as const,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            code: failure.code,
            message: failure.message,
            retryable: failure.retryable,
            nextAction: failure.nextAction,
            requestId: failure.requestId,
          }),
        },
      ],
    };
  }
}

export function jsonResourceReply(uri: URL, value: unknown) {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(value),
      },
    ],
  };
}
