import { BrightDataGateway } from "../src/adapters/brightdata/gateway";
import { CapabilityError } from "../src/core/contracts";
import {
  deleteMacOsKeychainCredential,
  hasMacOsKeychainCredential,
  macOsKeychainCredential,
  promptAndStoreMacOsKeychainCredential,
} from "../src/connections/credentials";

const command = process.argv[2] ?? "help";

try {
  if (command === "connect") await connect();
  else if (command === "disconnect") await disconnect();
  else if (command === "help" || command === "--help" || command === "-h") help();
  else throw new Error(`Unknown command: ${command}`);
} catch (error) {
  const message = error instanceof Error ? error.message : "Credential setup failed.";
  console.error(`Bright Data connection failed: ${message}`);
  process.exitCode = 1;
}

async function connect() {
  if (await hasMacOsKeychainCredential()) {
    throw new Error(
      "A token is already stored. Run bun run disconnect:brightdata before replacing it.",
    );
  }
  if (!process.stdin.isTTY) {
    throw new Error("Run this command from an interactive terminal.");
  }

  console.log("macOS Keychain will prompt for the Bright Data API token.");
  console.log("The token will not appear in this command's arguments or shell history.");
  await promptAndStoreMacOsKeychainCredential();

  try {
    const gateway = new BrightDataGateway({
      credentials: macOsKeychainCredential(),
      logger: { info() {}, error() {} },
    });
    await gateway.requestJson(
      { method: "GET", path: "/status", timeoutMs: 10_000 },
      { principalId: "local", requestId: crypto.randomUUID() },
    );
  } catch (error) {
    await deleteMacOsKeychainCredential();
    if (error instanceof CapabilityError) {
      throw new Error(`${error.message} The unvalidated keychain item was removed.`);
    }
    throw error;
  }

  console.log("Bright Data token validated and stored in macOS Keychain.");
  console.log("Set BRIGHTDATA_CREDENTIAL_SOURCE=keychain in the local MCP configuration.");
}

async function disconnect() {
  const deleted = await deleteMacOsKeychainCredential();
  console.log(
    deleted
      ? "Bright Data token removed from macOS Keychain."
      : "No Bright Data token was stored in macOS Keychain.",
  );
}

function help() {
  console.log(`Usage:
  bun run connect:brightdata     Prompt, validate, and store a token
  bun run disconnect:brightdata  Remove the stored token`);
}
