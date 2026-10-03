import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Strict Content-Security-Policy for production builds (SPEC.md, "Front-end integrity").
 * The app runs on simulated data, so nothing needs a network origin besides 'self'.
 * Dev builds skip it because Vite injects inline styles for HMR.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

function contentSecurityPolicy(): Plugin {
  return {
    name: "zerofee-csp",
    apply: "build",
    transformIndexHtml(html) {
      return html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
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

export default defineConfig({
  plugins: [react(), tailwindcss(), contentSecurityPolicy(), preloadPrimaryFont()],
  server: { port: 5173, strictPort: false },
  preview: { port: 4173 },
  build: {
    target: "es2022",
    sourcemap: true,
    chunkSizeWarningLimit: 900,
  },
});
