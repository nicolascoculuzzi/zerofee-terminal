import { useEffect } from "react";
import { RouterProvider } from "react-router";
import { startFeed } from "../state/feed";
import { useSettings } from "../state/settings";
import { router } from "./routes";

export function App() {
  const theme = useSettings((s) => s.display.theme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    // Browser chrome follows the bg token from index.css, whichever theme resolved.
    const bg = getComputedStyle(document.documentElement).getPropertyValue("--zf-bg").trim();
    if (bg) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg);
  }, [theme]);

  useEffect(() => startFeed(), []);

  return <RouterProvider router={router} />;
}
