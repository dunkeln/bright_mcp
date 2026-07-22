import { AsyncLocalStorage } from "node:async_hooks";

export type CredentialProvider = (
  principalId: string,
) => Promise<{ apiKey: string; browserZone?: string }>;

export class CredentialResolutionError extends Error {
  constructor(readonly reason: "missing" | "unavailable", message: string) {
    super(message);
    this.name = "CredentialResolutionError";
  }
}

export function staticCredential(
  apiKey: string,
  browserZone?: string,
): CredentialProvider {
  return async () => ({ apiKey, browserZone });
}

export function createRequestCredentialProvider() {
  const requestCredentials = new AsyncLocalStorage<{
    principalId: string;
    credential: { apiKey: string; browserZone?: string };
  }>();
  return {
    credentials: async (principalId: string) => {
      const current = requestCredentials.getStore();
      if (!current || current.principalId !== principalId) {
        throw new CredentialResolutionError(
          "missing",
          "No Bright Data API key is bound to this MCP request.",
        );
      }
      return current.credential;
    },
    bind(apiKeyHeader: string | null, browserZone?: string) {
      if (!apiKeyHeader || !/^[^\s]{1,4096}$/.test(apiKeyHeader)) return undefined;
      const apiKey = apiKeyHeader;
      const digest = new Bun.CryptoHasher("sha256")
        .update(`${apiKey}\0${browserZone ?? ""}`)
        .digest("hex");
      const principalId = `byok_${digest.slice(0, 32)}`;
      return {
        principalId,
        run<T>(operation: () => Promise<T>) {
          return requestCredentials.run(
            { principalId, credential: { apiKey, browserZone } },
            operation,
          );
        },
      };
    },
  };
}

export function macOsKeychainCredential(browserZone?: string): CredentialProvider {
  return async () => ({
    apiKey: await readMacOsKeychainCredential(),
    browserZone,
  });
}

export async function hasMacOsKeychainCredential() {
  requireMacOs();
  const result = await security([
    "find-generic-password",
    "-a",
    KEYCHAIN_ACCOUNT,
    "-s",
    KEYCHAIN_SERVICE,
  ]);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 44) return false;
  throw unavailable();
}

export async function promptAndStoreMacOsKeychainCredential() {
  requireMacOs();
  const result = await security(
    [
      "add-generic-password",
      "-a",
      KEYCHAIN_ACCOUNT,
      "-s",
      KEYCHAIN_SERVICE,
      "-l",
      "Bright MCP — Bright Data API token",
      "-w",
    ],
    true,
  );
  if (result.exitCode !== 0) throw unavailable();
}

export async function deleteMacOsKeychainCredential() {
  requireMacOs();
  const result = await security([
    "delete-generic-password",
    "-a",
    KEYCHAIN_ACCOUNT,
    "-s",
    KEYCHAIN_SERVICE,
  ]);
  if (result.exitCode !== 0 && result.exitCode !== 44) throw unavailable();
  return result.exitCode === 0;
}

async function readMacOsKeychainCredential() {
  requireMacOs();
  const result = await security([
    "find-generic-password",
    "-a",
    KEYCHAIN_ACCOUNT,
    "-s",
    KEYCHAIN_SERVICE,
    "-w",
  ]);
  if (result.exitCode === 44) {
    throw new CredentialResolutionError(
      "missing",
      "No Bright Data API token is stored in macOS Keychain.",
    );
  }
  const apiKey = result.stdout.trim();
  if (result.exitCode !== 0 || !apiKey) throw unavailable();
  return apiKey;
}

async function security(args: string[], interactive = false) {
  const child = Bun.spawn(["/usr/bin/security", ...args], {
    stdin: interactive ? "inherit" : "ignore",
    stdout: "pipe",
    stderr: interactive ? "inherit" : "ignore",
  });
  const [stdout, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  return { stdout, exitCode };
}

function requireMacOs() {
  if (process.platform !== "darwin") {
    throw new CredentialResolutionError(
      "unavailable",
      "The built-in keychain provider currently supports macOS only.",
    );
  }
}

function unavailable() {
  return new CredentialResolutionError(
    "unavailable",
    "macOS Keychain could not read or update the Bright Data credential.",
  );
}

const KEYCHAIN_SERVICE = "dev.bright-mcp.brightdata-api";
const KEYCHAIN_ACCOUNT = "local";
