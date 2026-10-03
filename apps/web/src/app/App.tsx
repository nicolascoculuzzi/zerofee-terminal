import { useEffect } from "react";
import { RouterProvider } from "react-router";
import { startFeed } from "../state/feed";
import { useSettings } from "../state/settings";
import { router } from "./routes";

export function App() {
  const theme = useSettings((s) => s.display.theme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    meta?.setAttribute("content", theme === "light" ? "#f3f4f6" : "#08090b");
  }, [theme]);

  useEffect(() => startFeed(), []);

  return <RouterProvider router={router} />;
}
