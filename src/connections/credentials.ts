export type CredentialProvider = (
  principalId: string,
) => Promise<{ apiKey: string }>;

export function staticCredential(apiKey: string): CredentialProvider {
  return async () => ({ apiKey });
}
