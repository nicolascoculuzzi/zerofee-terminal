import { AlertTriangle, Check, Copy, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { Button } from "../components/ui/Button";
import { Logo } from "./Logo";

/** A route chunk that failed to load: usually a deploy replaced it, or the connection dropped mid-load. */
function isChunkError(message: string): boolean {
  return /dynamically imported module|Importing a module script failed|error loading dynamically|Loading chunk/i.test(message);
}

/**
 * Route crash (DESIGN.md 4.18): panels fail inline; this only catches a view that couldn't render at all.
 * One top-left panel in the shape of Vercel's failed-build card (warn icon and title in a header, what
 * happened in one sentence, the raw error in mono, actions right-aligned with the primary last):
 * https://mobbin.com/screens/ff81f1e9-25b1-46f9-8448-31fa40a77e4b and
 * https://mobbin.com/screens/a30b7056-97ec-437b-a3ff-d7365cd86a49
 */
export function RouteError({ error }: { error: unknown }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [copied, setCopied] = useState(false);
  const message = error instanceof Error ? error.message : "Something went wrong";
  const chunk = isChunkError(message);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = () => {
    const stack = error instanceof Error && error.stack ? `\n\n${error.stack}` : "";
    void navigator.clipboard?.writeText(`${pathname}\n${message}${stack}`).then(() => setCopied(true));
  };

  return (
    <div className="min-h-dvh bg-bg text-fg-1">
      <header className="flex h-14 items-center px-4 md:px-6">
        <Logo />
      </header>
      <section
        aria-labelledby="route-error-title"
        className="mx-4 max-w-[560px] overflow-hidden rounded-md border border-hairline bg-surface-1 md:mx-6"
      >
        <header className="flex h-11 items-center gap-2 border-b border-hairline px-4">
          <AlertTriangle className="icon-sm shrink-0 text-warn" />
          <h1 id="route-error-title" className="text-heading font-semibold text-fg-1">
            {chunk ? "This view didn't load" : "This view couldn't render"}
          </h1>
          <span className="ml-auto truncate font-mono text-label text-fg-3">{pathname}</span>
        </header>
        <div className="space-y-3 p-4">
          <p className="text-body text-fg-2">
            {chunk
              ? "zerofee was updated or the connection dropped while this page loaded. Reload to fetch it again."
              : "Something in this page failed. Your wallets and armed orders are unaffected."}
          </p>
          <pre className="max-h-40 overflow-auto rounded-sm bg-surface-2 p-3 font-mono text-label whitespace-pre-wrap text-fg-2">
            {message}
          </pre>
        </div>
        <footer className="flex h-13 items-center gap-2 border-t border-hairline px-4">
          <Button variant="ghost" size="sm" className="mr-auto" icon={copied ? <Check /> : <Copy />} onClick={copy}>
            {copied ? "Copied" : "Copy details"}
          </Button>
          <Button variant="secondary" size="md" onClick={() => navigate("/pulse")}>
            Back to Pulse
          </Button>
          <Button variant="primary" size="md" icon={<RotateCw />} onClick={() => window.location.reload()}>
            Reload
          </Button>
        </footer>
      </section>
    </div>
  );
}
