import { CapabilityError, type RequestContext } from "../../core/contracts";
import {
  CredentialResolutionError,
  type CredentialProvider,
} from "../../connections/credentials";

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RESPONSE_BYTES = 2_000_000;

type LogRecord = Record<string, string | number | boolean | undefined>;
type Logger = {
  info(record: LogRecord): void;
  error(record: LogRecord): void;
};

export type FetchFunction = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class BrightDataGateway {
  constructor(
    private readonly options: {
      credentials: CredentialProvider;
      logger: Logger;
      baseUrl?: string;
      fetch?: FetchFunction;
    },
  ) {}

  async requestJson(
    request: GatewayRequest,
    context: RequestContext,
  ): Promise<{ status: number; data: unknown }> {
    return this.request(request, context, (text) => {
      try {
        return text.length ? JSON.parse(text) : null;
      } catch {
        throw new CapabilityError(
          "malformed_upstream_response",
          "Bright Data returned a response that was not valid JSON.",
          false,
          "Retry once. If this persists, verify the configured Bright Data product.",
        );
      }
    });
  }

  async requestText(
    request: GatewayRequest,
    context: RequestContext,
  ): Promise<{ status: number; data: string }> {
    return this.request(request, context, (text) => text);
  }

  private async request<T>(
    request: GatewayRequest,
    context: RequestContext,
    parse: (text: string) => T,
  ): Promise<{ status: number; data: T }> {
    const startedAt = performance.now();
    const url = new URL(
      request.path,
      this.options.baseUrl ?? "https://api.brightdata.com",
    );
    for (const [key, value] of Object.entries(request.query ?? {})) {
      url.searchParams.set(key, value);
    }
    let apiKey: string;
    try {
      ({ apiKey } = await this.options.credentials(context.principalId));
    } catch (error) {
      throw translateNetworkError(error, context.signal);
    }
    const fetcher = this.options.fetch ?? fetch;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const timeout = AbortSignal.timeout(request.timeoutMs ?? 15_000);
        const signal = context.signal
          ? AbortSignal.any([context.signal, timeout])
          : timeout;
        const response = await fetcher(url, {
          method: request.method,
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            "user-agent": "bright-mcp/0.1.0",
            "x-request-id": context.requestId,
          },
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
          signal,
        });

        if (!response.ok) {
          await response.body?.cancel();
          if (RETRYABLE_STATUS.has(response.status) && attempt < 3) {
            await this.retryDelay(attempt, context.signal);
            continue;
          }
          throw statusError(response.status);
        }
        const text = await readBoundedText(response, MAX_RESPONSE_BYTES);

        const data = parse(text);

        this.options.logger.info({
          operation: `${request.method} ${request.path}`,
          requestId: context.requestId,
          attempt,
          status: response.status,
          durationMs: Math.round(performance.now() - startedAt),
          terminalState: "success",
        });
        return { status: response.status, data };
      } catch (error) {
        const capabilityError = translateNetworkError(error, context.signal);
        const shouldRetry = capabilityError.retryable && attempt < 3;
        if (shouldRetry) {
          await this.retryDelay(attempt, context.signal);
          continue;
        }
        this.options.logger.error({
          operation: `${request.method} ${request.path}`,
          requestId: context.requestId,
          attempt,
          errorCode: capabilityError.code,
          durationMs: Math.round(performance.now() - startedAt),
          terminalState: "error",
        });
        throw capabilityError;
      }
    }

    throw new CapabilityError(
      "upstream_unavailable",
      "Bright Data did not respond after bounded retries.",
      true,
    );
  }

  private async retryDelay(attempt: number, signal?: AbortSignal) {
    await Bun.sleep(200 * attempt);
    if (signal?.aborted) {
      throw new CapabilityError(
        "cancelled",
        "The Bright Data request was cancelled.",
        false,
      );
    }
  }
}

type GatewayRequest = {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
};

async function readBoundedText(response: Response, maxBytes: number) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw responseTooLarge();
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw responseTooLarge();
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

function responseTooLarge() {
  return new CapabilityError(
    "upstream_response_too_large",
    "Bright Data returned more data than this operation accepts.",
    false,
    "Request less data or use task-backed execution when available.",
  );
}

function statusError(status: number): CapabilityError {
  if (status === 400 || status === 422) {
    return new CapabilityError(
      "upstream_rejected_input",
      "Bright Data rejected the upstream request input.",
      false,
      "Verify the tool arguments and configured Bright Data product zone.",
    );
  }
  if (status === 401) {
    return new CapabilityError(
      "brightdata_authentication_failed",
      "Bright Data rejected the configured API key.",
      false,
      "Replace BRIGHTDATA_API_KEY with a valid API key.",
    );
  }
  if (status === 402) {
    return new CapabilityError(
      "brightdata_quota_exhausted",
      "The Bright Data account cannot run this paid operation.",
      false,
      "Check the account balance and product access in Bright Data.",
    );
  }
  if (status === 403) {
    return new CapabilityError(
      "brightdata_permission_denied",
      "The configured Bright Data API key lacks access to this product.",
      false,
      "Grant the API key product access or use another key.",
    );
  }
  if (status === 404) {
    return new CapabilityError(
      "upstream_capability_unavailable",
      "The configured Bright Data capability is unavailable.",
      false,
      "Verify the adapter mapping and product zone.",
    );
  }
  if (status === 429) {
    return new CapabilityError(
      "brightdata_rate_limited",
      "Bright Data rate-limited the request after bounded retries.",
      true,
      "Wait briefly before retrying.",
    );
  }
  return new CapabilityError(
    "upstream_unavailable",
    `Bright Data returned HTTP ${status}.`,
    RETRYABLE_STATUS.has(status),
    RETRYABLE_STATUS.has(status) ? "Retry after a brief delay." : undefined,
  );
}

function translateNetworkError(
  error: unknown,
  callerSignal?: AbortSignal,
): CapabilityError {
  if (error instanceof CapabilityError) return error;
  if (error instanceof CredentialResolutionError) {
    return new CapabilityError(
      error.reason === "missing"
        ? "brightdata_connection_required"
        : "brightdata_credential_unavailable",
      error.message,
      false,
      error.reason === "missing"
        ? "Configure a Bright Data credential for this MCP connection, then retry."
        : "Unlock macOS Keychain or use explicit headless credential configuration.",
    );
  }
  if (callerSignal?.aborted) {
    return new CapabilityError(
      "cancelled",
      "The Bright Data request was cancelled.",
      false,
    );
  }
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return new CapabilityError(
      "upstream_timeout",
      "Bright Data did not respond before the request deadline.",
      true,
      "Retry once or use task-backed execution when available.",
    );
  }
  return new CapabilityError(
    "upstream_unavailable",
    "Bright Data could not be reached.",
    true,
    "Check network access and retry after a brief delay.",
  );
}
