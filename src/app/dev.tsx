import {
  applyDocumentTheme,
  getDocumentTheme,
} from "@modelcontextprotocol/ext-apps";
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

document.documentElement.dataset.preview = "true";
applyDocumentTheme(
  window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
);

const themeButton = document.createElement("button");
themeButton.className =
  "fixed z-50 right-3 bottom-3 cursor-pointer rounded-full border border-subtle bg-surface-secondary px-3 py-1.5 text-xs text-primary";
themeButton.type = "button";
themeButton.addEventListener("click", () => {
  applyDocumentTheme(getDocumentTheme() === "dark" ? "light" : "dark");
  updateThemeButton();
});
document.body.append(themeButton);
updateThemeButton();

await import("./main");

function updateThemeButton() {
  const theme = getDocumentTheme();
  themeButton.textContent = theme === "dark" ? "Dark" : "Light";
  themeButton.setAttribute(
    "aria-label",
    `Switch to ${theme === "dark" ? "light" : "dark"} mode`,
  );
  themeButton.setAttribute("aria-pressed", String(theme === "dark"));
}
