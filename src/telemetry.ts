import * as logfire from "@pydantic/logfire-node";

logfire.configure({
  advanced: { baseUrl: "https://logfire-us.pydantic.dev" },
  distributedTracing: false,
  environment: process.env.NODE_ENV,
  metrics: false,
  nodeAutoInstrumentations: {
    "@opentelemetry/instrumentation-http": { enabled: false },
    "@opentelemetry/instrumentation-undici": { enabled: false },
  },
  sendToLogfire: "if-token-present",
  serviceName: "bright-mcp",
  serviceVersion: "0.3.0",
});

export { logfire };
