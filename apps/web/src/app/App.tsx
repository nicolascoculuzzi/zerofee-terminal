import { useEffect } from "react";
import { BrowserRouter } from "react-router";
import { useMediaQuery } from "../lib/useMediaQuery";
import { startFeed } from "../state/feed";
import { useSettings } from "../state/settings";
import { AppRoutes } from "./routes";

/**
 * Root: applies data-theme, data-density and data-cvd on <html> from settings (DESIGN.md 9.5
 * item 2). "system" follows prefers-color-scheme; "auto" density is compact at 1024px and up
 * with a fine pointer, comfortable otherwise.
 */
export function App() {
  const theme = useSettings((s) => s.display.theme);
  const density = useSettings((s) => s.display.density);
  const cvd = useSettings((s) => s.display.cvd);
  const prefersLight = useMediaQuery("(prefers-color-scheme: light)");
  const desktopPointer = useMediaQuery("(min-width: 1024px) and (pointer: fine)");

  const resolvedTheme = theme === "system" ? (prefersLight ? "light" : "dark") : theme;
  const resolvedDensity = density === "auto" ? (desktopPointer ? "compact" : "comfortable") : density;

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolvedTheme;
    root.dataset.density = resolvedDensity;
    if (cvd === "blue-orange") root.dataset.cvd = "blue-orange";
    else delete root.dataset.cvd;
    // Browser chrome follows the bg token from index.css, whichever theme resolved.
    const bg = getComputedStyle(root).getPropertyValue("--zf-bg").trim();
    if (bg) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg);
  }, [resolvedTheme, resolvedDensity, cvd]);

  useEffect(() => startFeed(), []);

  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}
