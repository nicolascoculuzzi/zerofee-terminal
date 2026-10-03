import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
// Fonts are bundled (no font CDN): IBM Plex Sans Variable (wght 100–700, wdth 75–100) and
// Plex Mono 400/500, per docs/design/DESIGN.md 2.2 and 9.3.
import "@fontsource-variable/ibm-plex-sans/standard.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
