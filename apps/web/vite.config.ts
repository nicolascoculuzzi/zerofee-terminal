import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";

/**
 * Strict Content-Security-Policy for production builds (SPEC.md, "Front-end integrity").
 * The simulation needs no network origin besides 'self'. A live build also connects to the gateway
 * (VITE_API_ORIGIN and its ws:/wss: twin; same-origin needs nothing extra) and to Jupiter's Swap API,
 * which the browser calls itself for the long-tail fallback (quotes and routes). The signer worker is a
 * same-origin module ('self'); its Argon2 WebAssembly runs inside the worker.
 * Images are same-origin only: token images through the server's image proxy (GET /api/img), platform
 * logos bundled in public/venues/; data: is for the Pulse card icon masks, blob: for chart and share-card
 * previews. The edge (deploy/docker/Caddyfile) sends the same img-src.
 * Dev builds skip it because Vite injects inline styles for HMR.
 */
const JUPITER_API_ORIGIN = "https://api.jup.ag";

function csp(apiOrigin: string, live: boolean): string {
  const connect = ["'self'"];
  if (apiOrigin) connect.push(apiOrigin, apiOrigin.replace(/^http/, "ws"));
  if (live) connect.push(JUPITER_API_ORIGIN);
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${connect.join(" ")}`,
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

function contentSecurityPolicy(policy: string): Plugin {
  return {
    name: "zerofee-csp",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`);
    },
  };
}

/**
 * Preloads the Plex Sans latin face (DESIGN.md 9.3) so first paint uses the real font. Build
 * only: it looks up the emitted woff2 in the bundle; the CSP already allows font-src 'self'.
 */
function preloadPrimaryFont(): Plugin {
  let base = "/";
  return {
    name: "zerofee-font-preload",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const file = Object.keys(ctx.bundle ?? {}).find((f) => /ibm-plex-sans-latin-standard-normal.*\.woff2$/.test(f));
        if (!file) return html;
        return html.replace(
          "</head>",
          `    <link rel="preload" as="font" type="font/woff2" href="${base}${file}" crossorigin />\n  </head>`,
        );
      },
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const live = env.VITE_DATA_SOURCE === "live";
  const apiOrigin = (env.VITE_API_ORIGIN ?? "").replace(/\/+$/, "");
  // `vite dev` / `vite preview` in live mode: same-origin /api and /ws, forwarded to the gateway
  // (src/runtime.ts). Set the server's PUBLIC_ORIGIN to this dev origin so sign-in and CSRF checks pass.
  const target = apiOrigin || "http://127.0.0.1:8787";
  const proxy = live
    ? {
        "/api": { target, changeOrigin: false },
        "/ws": { target: target.replace(/^http/, "ws"), ws: true, changeOrigin: false },
      }
    : undefined;
  return {
    // A literal, so the bundler drops the implementation that is not selected (src/services/index.ts).
    define: { "import.meta.env.VITE_DATA_SOURCE": JSON.stringify(live ? "live" : "mock") },
    plugins: [react(), tailwindcss(), contentSecurityPolicy(csp(apiOrigin, live)), preloadPrimaryFont()],
    server: { port: 5173, strictPort: false, proxy },
    preview: { port: 4173, proxy },
    worker: { format: "es" as const },
    build: {
      target: "es2022",
      sourcemap: true,
      chunkSizeWarningLimit: 900,
    },
  };
});
