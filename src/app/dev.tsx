import { devDatasetResult } from "./dev-fixture";

const previewWindow = window as Window & {
  brightMcpPreview?: boolean;
  openai?: { toolOutput?: unknown };
};

previewWindow.brightMcpPreview = true;
previewWindow.openai = {
  ...previewWindow.openai,
  toolOutput: devDatasetResult,
};

await import("./main");
