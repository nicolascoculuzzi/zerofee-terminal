import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { initServices } from "./services";
// Fonts are bundled (no font CDN): IBM Plex Sans Variable (wght 100–700, wdth 75–100) and
// Plex Mono 400/500, per docs/design/DESIGN.md 2.2 and 9.3.
import "@fontsource-variable/ibm-plex-sans/standard.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");

// The service container (simulation or live gateway) loads before the first render: every store and
// page reads it synchronously.
initServices().then(
  () =>
    createRoot(root).render(
      <StrictMode>
        <App />
      </StrictMode>,
    ),
  (e: unknown) => {
    // One quiet line, top-left (DESIGN.md 4.18); nothing else can render without the services.
    root.textContent = `zerofee could not start: ${e instanceof Error ? e.message : String(e)}`;
    root.className = "p-3 text-data text-sell";
  },
);
