import { useSyncExternalStore } from "react";

/** Breakpoints mirror Tailwind's defaults (md 768, lg 1024, xl 1280). */
export const BREAKPOINT = { md: "(min-width: 768px)", lg: "(min-width: 1024px)", xl: "(min-width: 1280px)" } as const;

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
