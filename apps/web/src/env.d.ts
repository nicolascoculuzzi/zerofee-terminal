/**
 * Build-time variables (Vite inlines `VITE_*` from the environment at `vite build` / `vite dev`).
 *
 * - `VITE_BUILD_HASH`: the commit the bundle was built from, shown in Settings > About. CI sets
 *   it to the short git SHA (`VITE_BUILD_HASH=$(git rev-parse --short HEAD) bun run build`);
 *   unset, About reads "development" in dev and "unversioned" in a build.
 * - `VITE_DATA_SOURCE`: `mock` (default; the in-browser simulation, no network) or `live` (the real
 *   gateway, wallet and signer). See src/runtime.ts.
 * - `VITE_API_ORIGIN`: the gateway origin, e.g. `http://127.0.0.1:8787`. `vite dev` proxies `/api` and
 *   `/ws` there and the app stays same-origin (set the server's PUBLIC_ORIGIN to the Vite origin). In a
 *   build it is the origin the app calls; empty = the page's own origin (one reverse proxy for both).
 * - `VITE_JUPITER_API_KEY`: optional Jupiter Swap API key for the long-tail fallback (live mode). It ships
 *   in the bundle, so anyone can read it; keyless access (0.5 requests/s) works without it.
 */
interface ImportMetaEnv {
  readonly VITE_BUILD_HASH?: string;
  readonly VITE_DATA_SOURCE?: string;
  readonly VITE_API_ORIGIN?: string;
  readonly VITE_JUPITER_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
