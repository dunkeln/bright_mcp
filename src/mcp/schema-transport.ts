import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export function schemaCompatibleTransport<T extends Transport>(transport: T): T {
  const send = transport.send.bind(transport);
  transport.send = (message, options: TransportSendOptions | undefined) =>
    send(withoutToolSchemaDialects(message), options);
  return transport;
}

function withoutToolSchemaDialects(message: JSONRPCMessage): JSONRPCMessage {
  if (!("result" in message) || !isRecord(message.result)) return message;
  const tools = message.result.tools;
  if (!Array.isArray(tools) || !tools.every(isTool)) return message;
  return {
    ...message,
    result: {
      ...message.result,
      tools: tools.map((tool) => ({
        ...tool,
        inputSchema: withoutDialect(tool.inputSchema),
        ...(tool.outputSchema === undefined
          ? {}
          : { outputSchema: withoutDialect(tool.outputSchema) }),
      })),
    },
  } as JSONRPCMessage;
}

function isTool(value: unknown): value is Record<string, unknown> & {
  name: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
} {
  return isRecord(value) && typeof value.name === "string" && isRecord(value.inputSchema);
}

function withoutDialect(schema: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(schema).flatMap(([key, value]) => {
    if (key === "$schema") return [];
    const compatibleKey = key === "definitions" ? "$defs" : key;
    const compatibleValue = key === "$ref" && typeof value === "string"
      ? value.replace("#/definitions/", "#/$defs/")
      : Array.isArray(value)
        ? value.map(normalizeSchemaValue)
        : normalizeSchemaValue(value);
    return [[compatibleKey, compatibleValue]];
  }));
}

function normalizeSchemaValue(value: unknown): unknown {
  return isRecord(value) ? withoutDialect(value) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
