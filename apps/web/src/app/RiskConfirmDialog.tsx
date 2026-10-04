import { TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { useUi } from "../state/ui";

const COUNTDOWN_S = 3;

/** "Token-2022 extensions: Permanent delegate, Transfer hook" splits into what is flagged, and the specifics. */
function splitReason(reason: string): { what: string; details: string[] } {
  const at = reason.indexOf(": ");
  return at < 0 ? { what: reason, details: [] } : { what: reason.slice(0, at), details: reason.slice(at + 2).split(", ") };
}

/**
 * Countdown confirm for buys of flagged tokens (DESIGN.md 1.7, 4.17): the title names the action, one
 * sentence states the consequence, the flags sit in a hairline panel (what is flagged over the specifics),
 * and the buttons name both outcomes. "Buy anyway (3)" counts down 3 to 1 before it enables; focus starts
 * on "Don't buy" so a held Space or Enter can't confirm. After Monzo's "Continue anyway (4s)":
 * https://mobbin.com/screens/c73a3c93-eb1e-4c54-80c9-27e68531e9d0 and OKX's "Convert (9s)" confirmation:
 * https://mobbin.com/screens/a954dc2c-e48d-4ca1-b681-86716bf2bba2
 */
export function RiskConfirmDialog() {
  const pending = useUi((s) => s.riskConfirm);
  const setRiskConfirm = useUi((s) => s.setRiskConfirm);
  const [left, setLeft] = useState(COUNTDOWN_S);

  useEffect(() => {
    if (!pending) return;
    setLeft(COUNTDOWN_S);
    const timer = setInterval(() => setLeft((n) => (n > 0 ? n - 1 : 0)), 1000);
    return () => clearInterval(timer);
  }, [pending]);

  const answer = (ok: boolean) => {
    pending?.resolve(ok);
    setRiskConfirm(null);
  };

  const request = pending?.request;
  return (
    <Modal
      open={pending !== null}
      onClose={() => answer(false)}
      width={400}
      title={request ? `${request.actionLabel}?` : ""}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" size="md" onClick={() => answer(false)} data-autofocus>
            Don't buy
          </Button>
          <Button variant="buy" size="md" className="min-w-28 tabular-nums" disabled={left > 0} onClick={() => answer(true)}>
            {left > 0 ? `Buy anyway (${left})` : "Buy anyway"}
          </Button>
        </div>
      }
    >
      {request && (
        <div className="space-y-3">
          <p className="text-body text-fg-1">{request.symbol} is flagged. Someone else may be able to move, freeze or dump your tokens.</p>
          <ul aria-label="Flags" className="overflow-hidden rounded-md border border-hairline bg-surface-1">
            {request.reasons.map((reason) => {
              const { what, details } = splitReason(reason);
              return (
                <li key={reason} className="flex items-start gap-2 border-hairline px-3 py-2 not-first:border-t">
                  <TriangleAlert className="icon-sm mt-0.5 text-sell" />
                  <div className="min-w-0">
                    <div className="text-data font-medium text-fg-1">{what}</div>
                    {details.length > 0 && (
                      <div className="zf-num mt-0.5 flex flex-wrap gap-x-2.5 text-label text-fg-3">
                        {details.map((d) => (
                          <span key={d} className="whitespace-nowrap">
                            {d}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="text-label text-fg-3">Risk bands are set in Settings, under Display.</p>
        </div>
      )}
    </Modal>
  );
}
