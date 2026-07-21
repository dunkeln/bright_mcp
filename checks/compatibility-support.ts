export function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export function testEnvironment(overrides: Record<string, string> = {}) {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    BRIGHTDATA_API_KEY: "",
    BRIGHTDATA_CREDENTIAL_SOURCE: "auto",
    BRIGHTDATA_SERP_ZONE: "",
    BRIGHTDATA_UNLOCKER_ZONE: "",
    BRIGHTDATA_BROWSER_USERNAME: "",
    BRIGHTDATA_BROWSER_PASSWORD: "",
    MCP_BROWSER_PROFILE: "disabled",
    BRIGHT_MCP_TEST_FIXTURES: "1",
    NODE_ENV: "test",
    ...overrides,
  };
}

export function randomPort(except?: number) {
  let value = 20_000 + Math.floor(Math.random() * 20_000);
  if (value === except) value += 1;
  return value;
}

export async function createCertificate(key: string, certificate: string) {
  const process = Bun.spawn(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      key,
      "-out",
      certificate,
      "-days",
      "1",
      "-nodes",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  assert(
    (await process.exited) === 0,
    "OpenSSL could not create a temporary HTTPS certificate.",
  );
}

export async function waitForServer(
  url: string,
  child?: Bun.Subprocess,
  failureMessage = "Server did not start.",
) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child && child.exitCode !== null) {
      const stderr = child.stderr instanceof ReadableStream
        ? await new Response(child.stderr).text()
        : "stderr unavailable";
      throw new Error(`${failureMessage} ${stderr}`);
    }
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // The child is still starting.
    }
    await Bun.sleep(50);
  }
  throw new Error(failureMessage);
}
