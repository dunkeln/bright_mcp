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
  ): Promise<{ status: number; data: unknown; requestId?: string }> {
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
  ): Promise<{ status: number; data: string; requestId?: string }> {
    return this.request(request, context, (text) => text);
  }

  private async request<T>(
    request: GatewayRequest,
    context: RequestContext,
    parse: (text: string) => T,
  ): Promise<{ status: number; data: T; requestId?: string }> {
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

    const maxAttempts = request.maxAttempts ?? 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
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
            "user-agent": "bright-mcp/0.2.0",
            "x-request-id": context.requestId,
          },
          body: request.body === undefined ? undefined : JSON.stringify(request.body),
          signal,
        });

        if (!response.ok) {
          const upstreamRequestId = response.headers.get("x-request-id") ?? undefined;
          if (RETRYABLE_STATUS.has(response.status) && attempt < maxAttempts) {
            await response.body?.cancel();
            await this.retryDelay(
              attempt,
              context.signal,
              response.headers.get("retry-after"),
            );
            continue;
          }
          const detail = await readBoundedText(response, 8_192).catch(() => "");
          throw statusError(
            response.status,
            upstreamRequestId ?? context.requestId,
            detail,
          );
        }
        const text = await readBoundedText(
          response,
          request.maxResponseBytes ?? MAX_RESPONSE_BYTES,
        );

        const data = parse(text);

        this.options.logger.info({
          operation: `${request.method} ${request.path}`,
          requestId: context.requestId,
          attempt,
          status: response.status,
          upstreamRequestId: response.headers.get("x-request-id") ?? undefined,
          durationMs: Math.round(performance.now() - startedAt),
          terminalState: "success",
        });
        return {
          status: response.status,
          data,
          requestId: response.headers.get("x-request-id") ?? undefined,
        };
      } catch (error) {
        const capabilityError = translateNetworkError(error, context.signal);
        const shouldRetry = capabilityError.retryable && attempt < maxAttempts;
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

  private async retryDelay(
    attempt: number,
    signal?: AbortSignal,
    retryAfter?: string | null,
  ) {
    const seconds = Number(retryAfter);
    const retryMs = Number.isFinite(seconds) && seconds >= 0
      ? seconds * 1_000
      : Math.max(0, Date.parse(retryAfter ?? "") - Date.now());
    await Bun.sleep(retryMs || 200 * attempt + Math.random() * 100);
    if (signal?.aborted) {
      throw new CapabilityError(
        "cancelled",
        "The Bright Data request was cancelled.",
        false,
      );
    }
  }
}

export async function pollBrightData<T>(options: {
  context: RequestContext;
  deadlineMs: number;
  intervalMs: number;
  load(): Promise<T>;
  state(value: T): "pending" | "ready" | "failed";
  failed(value: T): CapabilityError;
  timeout: CapabilityError;
}) {
  const deadline = Date.now() + options.deadlineMs;
  while (Date.now() < deadline) {
    if (options.context.signal?.aborted) {
      throw new CapabilityError("cancelled", "The Bright Data operation was cancelled.");
    }
    await Bun.sleep(options.intervalMs);
    const value = await options.load();
    const state = options.state(value);
    if (state === "ready") return value;
    if (state === "failed") throw options.failed(value);
  }
  throw options.timeout;
}

type GatewayRequest = {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxAttempts?: number;
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

function statusError(status: number, requestId?: string, responseBody = ""): CapabilityError {
  if (status === 400 || status === 422) {
    const detail = responseBody.replace(/\s+/g, " ").trim().slice(0, 300);
    if (detail === "Deep Lookup is for business emails only") {
      return new CapabilityError(
        "upstream_capability_unavailable",
        "The configured Deep Lookup capability only supports business-email queries.",
        false,
        "Enable general Deep Lookup access or configure another structured extraction backend.",
        requestId,
      );
    }
    return new CapabilityError(
      "upstream_rejected_input",
      "Bright Data rejected the upstream request input.",
      false,
      "Verify the tool arguments and configured Bright Data product zone.",
      requestId,
    );
  }
  if (status === 401) {
    return new CapabilityError(
      "brightdata_authentication_failed",
      "Bright Data rejected the configured API key.",
      false,
      "Replace BRIGHTDATA_API_KEY with a valid API key.",
      requestId,
    );
  }
  if (status === 402) {
    return new CapabilityError(
      "brightdata_quota_exhausted",
      "The Bright Data account cannot run this paid operation.",
      false,
      "Check the account balance and product access in Bright Data.",
      requestId,
    );
  }
  if (status === 403) {
    return new CapabilityError(
      "brightdata_permission_denied",
      "The configured Bright Data API key lacks access to this product.",
      false,
      "Grant the API key product access or use another key.",
      requestId,
    );
  }
  if (status === 404) {
    return new CapabilityError(
      "upstream_capability_unavailable",
      "The configured Bright Data capability is unavailable.",
      false,
      "Verify the adapter mapping and product zone.",
      requestId,
    );
  }
  if (status === 429) {
    return new CapabilityError(
      "brightdata_rate_limited",
      "Bright Data rate-limited the request after bounded retries.",
      true,
      "Wait briefly before retrying.",
      requestId,
    );
  }
  return new CapabilityError(
    "upstream_unavailable",
    `Bright Data returned HTTP ${status}.`,
    RETRYABLE_STATUS.has(status),
    RETRYABLE_STATUS.has(status) ? "Retry after a brief delay." : undefined,
    requestId,
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
