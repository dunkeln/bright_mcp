import { devDatasetResult } from "./dev-fixture";

const previewWindow = window as Window & {
  openai?: { toolOutput?: unknown };
};

previewWindow.openai = {
  ...previewWindow.openai,
  toolOutput: devDatasetResult,
};

await import("./main");
