import { LRUCache } from "lru-cache";

export type BrowserCredentialProvider = (
  principalId: string,
) => Promise<{ username: string; password: string }>;

export function staticBrowserCredential(
  username: string,
  password: string,
): BrowserCredentialProvider {
  return async () => ({ username, password });
}

export function createBasicBrowserCredentialProvider() {
  const credentials = new LRUCache<
    string,
    { username: string; password: string }
  >({
    max: 1_000,
    ttl: 60 * 60_000,
    updateAgeOnGet: true,
    ttlAutopurge: true,
  });
  return {
    credentials: async (principalId: string) => {
      const credential = credentials.get(principalId);
      if (!credential) {
        throw new Error(
          "No Bright Data Browser API credential is bound to this MCP session.",
        );
      }
      return credential;
    },
    bind(authorization: string | null) {
      const match = /^Basic ([A-Za-z0-9+/=]{1,8192})$/.exec(
        authorization ?? "",
      );
      if (!match) return undefined;
      let decoded: string;
      try {
        decoded = Buffer.from(match[1]!, "base64").toString("utf8");
      } catch {
        return undefined;
      }
      const separator = decoded.indexOf(":");
      const username = decoded.slice(0, separator).trim();
      const password = decoded.slice(separator + 1);
      if (
        separator < 1 ||
        username.length > 512 ||
        !password ||
        password.length > 4096 ||
        /[\u0000-\u001f\u007f]/.test(username + password)
      ) {
        return undefined;
      }
      const digest = new Bun.CryptoHasher("sha256")
        .update(`${username}\0${password}`)
        .digest("hex");
      const principalId = `browser_${digest.slice(0, 32)}`;
      credentials.set(principalId, { username, password });
      return principalId;
    },
  };
}
