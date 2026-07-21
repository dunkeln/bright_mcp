import { LRUCache } from "lru-cache";

export type CredentialProvider = (
  principalId: string,
) => Promise<{ apiKey: string }>;

export class CredentialResolutionError extends Error {
  constructor(readonly reason: "missing" | "unavailable", message: string) {
    super(message);
    this.name = "CredentialResolutionError";
  }
}

export function staticCredential(apiKey: string): CredentialProvider {
  return async () => ({ apiKey });
}

export function createBearerCredentialProvider() {
  const apiKeys = new LRUCache<string, string>({
    max: 1_000,
    ttl: 60 * 60_000,
    updateAgeOnGet: true,
    ttlAutopurge: true,
  });
  return {
    credentials: async (principalId: string) => {
      const apiKey = apiKeys.get(principalId);
      if (!apiKey) {
        throw new CredentialResolutionError(
          "missing",
          "No Bright Data API key is bound to this MCP session.",
        );
      }
      return { apiKey };
    },
    bind(authorization: string | null) {
      const match = /^Bearer ([^\s]{1,4096})$/.exec(authorization ?? "");
      if (!match) return undefined;
      const apiKey = match[1]!;
      const digest = new Bun.CryptoHasher("sha256").update(apiKey).digest("hex");
      const principalId = `byok_${digest.slice(0, 32)}`;
      apiKeys.set(principalId, apiKey);
      return principalId;
    },
  };
}

export function macOsKeychainCredential(): CredentialProvider {
  return async () => ({ apiKey: await readMacOsKeychainCredential() });
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
