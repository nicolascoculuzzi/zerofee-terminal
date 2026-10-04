import { TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { useUi } from "../state/ui";

const COUNTDOWN_S = 3;

/**
 * Countdown confirm for buys of flagged tokens (DESIGN.md 1.7, 4.17): the title names the
 * action, one sentence states the consequence, the flags are listed, and the buttons name both
 * outcomes. "Buy anyway (3)" counts down 3 to 1 before it enables; focus starts on "Don't buy"
 * so a held Space or Enter can't confirm. After Monzo's "Continue anyway (4s)":
 * https://mobbin.com/screens/c73a3c93-eb1e-4c54-80c9-27e68531e9d0
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
          <Button variant="buy" size="md" disabled={left > 0} onClick={() => answer(true)}>
            {left > 0 ? `Buy anyway (${left})` : "Buy anyway"}
          </Button>
        </div>
      }
    >
      {request && (
        <>
          <p className="text-body text-fg-1">{request.symbol} is flagged: someone else may be able to move, freeze or dump your tokens.</p>
          <ul className="mt-3 flex flex-col gap-1.5">
            {request.reasons.map((reason) => (
              <li key={reason} className="flex items-start gap-2 text-data text-fg-2">
                <TriangleAlert className="icon-xs mt-0.5 text-sell" />
                {reason}
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}
