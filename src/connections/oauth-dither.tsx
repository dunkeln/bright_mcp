import { createRoot } from "react-dom/client";
import HeroDither from "../../site/src/components/HeroDither";

const container = document.getElementById("oauth-dither");
if (container) createRoot(container).render(<HeroDither />);
