export type BrowserCredentialProvider = (
  principalId: string,
) => Promise<{ username: string; password: string }>;

export function staticBrowserCredential(
  username: string,
  password: string,
): BrowserCredentialProvider {
  return async () => ({ username, password });
}
