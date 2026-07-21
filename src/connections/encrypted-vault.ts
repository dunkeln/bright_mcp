import { chmod, mkdir } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";
import {
  CredentialResolutionError,
  type CredentialProvider,
} from "./credentials";

const storedCredentialSchema = z.object({ apiKey: z.string().min(1).max(4_096) });

export async function createEncryptedCredentialVault(options: {
  path: string;
  keyHex: string;
  deploymentId: string;
}) {
  if (!/^[0-9a-fA-F]{64}$/.test(options.keyHex)) {
    throw new Error("MCP_VAULT_KEY must be exactly 32 bytes encoded as 64 hex characters.");
  }
  if (options.path !== ":memory:" && !isAbsolute(options.path)) {
    throw new Error("MCP_VAULT_PATH must be an absolute path.");
  }
  if (options.path !== ":memory:") {
    await mkdir(dirname(options.path), { recursive: true, mode: 0o700 });
  }
  // ponytail: SQLite is a single-instance vault; replace this provider when deployment needs shared writes.
  const database = new Database(options.path, { create: true, strict: true });
  database.run("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  database.run(`
    CREATE TABLE IF NOT EXISTS bright_credentials (
      principal_id TEXT PRIMARY KEY,
      nonce BLOB NOT NULL,
      ciphertext BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT
  `);
  if (options.path !== ":memory:") await chmod(options.path, 0o600);

  const key = await crypto.subtle.importKey(
    "raw",
    decodeHex(options.keyHex),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
  const select = database.query<
    { nonce: Uint8Array; ciphertext: Uint8Array },
    { principalId: string }
  >("SELECT nonce, ciphertext FROM bright_credentials WHERE principal_id = $principalId");
  const upsert = database.query<
    never,
    {
      principalId: string;
      nonce: Uint8Array;
      ciphertext: Uint8Array;
      updatedAt: number;
    }
  >(`
    INSERT INTO bright_credentials (principal_id, nonce, ciphertext, updated_at)
    VALUES ($principalId, $nonce, $ciphertext, $updatedAt)
    ON CONFLICT(principal_id) DO UPDATE SET
      nonce = excluded.nonce,
      ciphertext = excluded.ciphertext,
      updated_at = excluded.updated_at
  `);
  const remove = database.query<never, { principalId: string }>(
    "DELETE FROM bright_credentials WHERE principal_id = $principalId",
  );

  const credentials: CredentialProvider = async (principalId) => {
    const row = select.get({ principalId });
    if (!row) {
      throw new CredentialResolutionError(
        "missing",
        "No Bright Data connection exists for this account.",
      );
    }
    try {
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: Uint8Array.from(row.nonce),
          additionalData: aad(options.deploymentId, principalId),
        },
        key,
        Uint8Array.from(row.ciphertext),
      );
      return storedCredentialSchema.parse(
        JSON.parse(new TextDecoder().decode(plaintext)),
      );
    } catch {
      throw new CredentialResolutionError(
        "unavailable",
        "The stored Bright Data connection could not be decrypted.",
      );
    }
  };

  return {
    credentials,
    async store(principalId: string, apiKey: string) {
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv: nonce, additionalData: aad(options.deploymentId, principalId) },
          key,
          new TextEncoder().encode(JSON.stringify({ apiKey })),
        ),
      );
      upsert.run({ principalId, nonce, ciphertext, updatedAt: Date.now() });
    },
    revoke(principalId: string) {
      return remove.run({ principalId }).changes > 0;
    },
    close() {
      database.close();
    },
  };
}

export type EncryptedCredentialVault = Awaited<
  ReturnType<typeof createEncryptedCredentialVault>
>;

function aad(deploymentId: string, principalId: string) {
  return new TextEncoder().encode(`bright-mcp\0${deploymentId}\0${principalId}`);
}

function decodeHex(value: string) {
  return Uint8Array.from(
    value.match(/.{2}/g) ?? [],
    (byte) => Number.parseInt(byte, 16),
  );
}
