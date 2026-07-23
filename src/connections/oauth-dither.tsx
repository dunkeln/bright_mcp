import { createRoot } from "react-dom/client";
import HeroDither from "../../site/src/components/HeroDither";

const container = document.getElementById("oauth-dither");
if (container) createRoot(container).render(<HeroDither />);

const form = document.querySelector<HTMLFormElement>("form[data-expires-in]");
const input = form?.querySelector<HTMLInputElement>("#api_key");
const button = form?.querySelector<HTMLButtonElement>("button[type=submit]");
const status = document.querySelector<HTMLElement>("#oauth-status");
const buttonText = button?.textContent ?? "Connect Bright";
let submitted = false;

form?.addEventListener("submit", (event) => {
  if (submitted) {
    event.preventDefault();
  }
});

form?.addEventListener("formdata", () => {
  submitted = true;
  form.setAttribute("aria-busy", "true");
  if (input) {
    input.readOnly = true;
    input.setAttribute("aria-disabled", "true");
  }
  if (button) {
    button.textContent = "Connecting…";
    button.setAttribute("aria-disabled", "true");
  }
  if (status) {
    status.hidden = false;
    status.textContent = "Validating your key and returning to your client…";
  }
  setTimeout(() => {
    if (!submitted) return;
    submitted = false;
    form.removeAttribute("aria-busy");
    if (input) {
      input.readOnly = false;
      input.removeAttribute("aria-disabled");
    }
    if (button) {
      button.textContent = buttonText;
      button.removeAttribute("aria-disabled");
    }
    if (status) status.textContent = "Connection did not finish. Try again.";
  }, 15_000);
});

setTimeout(() => {
  if (submitted) return;
  if (input) input.disabled = true;
  if (button) button.disabled = true;
  if (status) {
    status.hidden = false;
    status.textContent = "Authorization expired. Restart the connection from your MCP client.";
  }
}, Number(form?.dataset.expiresIn ?? 0) * 1_000);
