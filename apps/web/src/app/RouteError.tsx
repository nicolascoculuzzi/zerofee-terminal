import { AlertTriangle } from "lucide-react";
import { useNavigate } from "react-router";
import { Button } from "../components/ui/Button";

/**
 * Route crash (DESIGN.md 4.18): top-left aligned, a warn icon, what happened, one way back.
 * Panels fail inline; this only catches a view that couldn't render at all.
 */
export function RouteError({ error }: { error: unknown }) {
  const navigate = useNavigate();
  const message = error instanceof Error ? error.message : "Something went wrong";
  return (
    <div className="min-h-screen bg-bg p-6">
      <div className="flex max-w-xl flex-col items-start gap-3">
        <div className="flex items-center gap-2 text-heading font-semibold text-fg-1">
          <AlertTriangle className="icon-sm text-warn" />
          This view couldn't render
        </div>
        <pre className="w-full rounded-sm border border-hairline bg-surface-1 p-3 font-mono text-label whitespace-pre-wrap text-fg-2">
          {message}
        </pre>
        <Button variant="secondary" size="sm" onClick={() => navigate("/pulse")}>
          Back to Pulse
        </Button>
      </div>
    </div>
  );
}
