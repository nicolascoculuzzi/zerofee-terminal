import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { buildCsp, inlineCspProblems } from "./csp";

/**
 * Strict Content-Security-Policy for production builds (SPEC.md, "Front-end integrity"), as a meta tag; the
 * policy itself (and the one inline <style> hash it allows) is in csp.ts. Dev builds skip it because Vite
 * injects inline styles for HMR.
 */
function contentSecurityPolicy(policy: string): Plugin {
  return {
    name: "zerofee-csp",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html) {
        // The final document must not need 'unsafe-inline': no style attributes, no <style> without its hash.
        const problems = inlineCspProblems(html, policy);
        if (problems.length) throw new Error(`index.html breaks the CSP (style-src / script-src):\n  ${problems.join("\n  ")}`);
        return html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`);
      },
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

/**
 * The first screen's critical path, fetched in parallel with the entry instead of one after another:
 *  - `modulepreload` for the data layer chunk (services/live or services/mock, imported at boot) and the Pulse
 *    route (the default page), with their static imports. Vite only preloads the entry's static imports.
 *  - Live builds: `preload as=fetch` for GET /api/pulse, the three Pulse lists, so rows can render before the
 *    WebSocket is up (services/live/bootstrap.ts reads the same request).
 *  - The mono face (Pulse numbers) next to the sans face preloadPrimaryFont adds.
 */
function preloadCriticalPath(apiOrigin: string, live: boolean): Plugin {
  let base = "/";
  return {
    name: "zerofee-critical-preload",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const bundle = ctx.bundle;
        if (!bundle) return html;
        type Chunk = { type: "chunk"; fileName: string; imports: string[]; isEntry: boolean; facadeModuleId: string | null };
        const chunks = Object.values(bundle).filter((c): c is Chunk & (typeof bundle)[string] => c.type === "chunk") as unknown as Chunk[];
        const entry = chunks.find((c) => c.isEntry);
        const skip = new Set([entry?.fileName, ...(entry?.imports ?? [])]);
        const files = new Set<string>();
        const add = (c: Chunk | undefined) => {
          if (!c || files.has(c.fileName) || skip.has(c.fileName)) return;
          files.add(c.fileName);
          for (const i of c.imports) add(bundle[i] as unknown as Chunk | undefined);
        };
        const targets = [
          live ? /src\/services\/live\/index\.ts$/ : /src\/services\/mock\/index\.ts$/,
          /src\/features\/pulse\/PulsePage\.tsx$/,
        ];
        for (const re of targets) add(chunks.find((c) => c.facadeModuleId !== null && re.test(c.facadeModuleId)));
        const links: string[] = [];
        if (live) links.push(`<link rel="preload" as="fetch" href="${apiOrigin}/api/pulse" crossorigin />`);
        for (const f of files) links.push(`<link rel="modulepreload" crossorigin href="${base}${f}" />`);
        const mono = Object.keys(bundle).find((f) => /ibm-plex-mono-latin-400-normal.*\.woff2$/.test(f));
        if (mono) links.push(`<link rel="preload" as="font" type="font/woff2" href="${base}${mono}" crossorigin />`);
        // after the stylesheet: on a slow link the render-blocking CSS (and with it the boot skeleton) must not
        // share its bandwidth with the preloads
        // and the stylesheet itself goes ahead of the entry script and Vite's modulepreloads
        const sheets: string[] = [];
        const rest = html.replace(/\s*<link rel="stylesheet"[^>]*>/g, (m) => {
          sheets.push(m.trim());
          return "";
        });
        return rest
          .replace(/(<meta name="viewport"[^>]*>)/, (m) => `${m}\n    ${sheets.join("\n    ")}`)
          .replace("</head>", `    ${links.join("\n    ")}\n  </head>`);
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
    // `react-router` is our own small router (src/lib/router.tsx): the same API for the parts the app uses,
    // ~11 KB gzip less on the first screen than the react-router package. tsconfig.json maps it the same way.
    resolve: { alias: { "react-router": fileURLToPath(new URL("./src/lib/router.tsx", import.meta.url)) } },
    plugins: [
      react(),
      tailwindcss(),
      contentSecurityPolicy(buildCsp(apiOrigin, live)),
      preloadPrimaryFont(),
      preloadCriticalPath(apiOrigin, live),
    ],
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
