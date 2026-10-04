/**
 * Build-time variables (Vite inlines `VITE_*` from the environment at `vite build`).
 *
 * - `VITE_BUILD_HASH`: the commit the bundle was built from, shown in Settings > About. CI sets
 *   it to the short git SHA (`VITE_BUILD_HASH=$(git rev-parse --short HEAD) bun run build`);
 *   unset, About reads "development" in dev and "unversioned" in a build.
 */
interface ImportMetaEnv {
  readonly VITE_BUILD_HASH?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
