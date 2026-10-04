import { Bell, BellRing, X } from "lucide-react";
import { useRef, useState } from "react";
import { Button, IconButton } from "../../components/ui/Button";
import { Hotkey } from "../../components/ui/controls";
import { Popover } from "../../components/ui/Popover";
import { Tooltip } from "../../components/ui/Tooltip";
import { fmtCompact, fmtSol } from "../../lib/format";
import type { TokenSummary } from "../../protocol";
import { useSettings } from "../../state/settings";
import { FormattedInput } from "../trade/FormattedInput";
import { alertLevelText } from "./alerts";
import { useQuote } from "./money";
import { useTokenUi } from "./tokenUi";

/**
 * Header bell (DESIGN.md 5.2): price alerts on market cap for this token. Each alert is a dashed
 * line on the chart that can be dragged; it fires once (a non-trade toast) while the page is open.
 */
export function AlertsButton({ token, size = "sm" }: { token: TokenSummary; size?: "sm" | "md" }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const { quote, solUsd } = useQuote();
  const alerts = useTokenUi((s) => s.alerts);
  const addAlert = useTokenUi((s) => s.addAlert);
  const removeAlert = useTokenUi((s) => s.removeAlert);
  const alertKey = useSettings((s) => s.hotkeys["token.alert"]?.[0]);
  const fx = quote === "USD" ? solUsd : 1;
  // Unknown price (null: the quote has no known SOL value): no reference to set an alert against.
  const price = token.priceSol;
  const currentMc = price === null ? Number.NaN : price * token.supply * fx;
  const known = Number.isFinite(currentMc) && currentMc > 0;
  const [mc, setMc] = useState(known ? currentMc * 1.2 : 0);
  const mine = alerts.filter((a) => a.mint === token.mint);
  const usd = quote === "USD";
  const add = () => {
    if (known && price !== null && mc > 0) addAlert(token.mint, mc / (token.supply * fx), price);
  };

  return (
    <>
      <Tooltip
        content={
          <span className="flex items-center gap-1">
            Price alerts <Hotkey binding={alertKey} />
          </span>
        }
      >
        <IconButton
          ref={anchor}
          size={size}
          label={mine.length > 0 ? `Price alerts (${mine.length})` : "Price alerts"}
          title=""
          active={open || mine.length > 0}
          onClick={() => {
            if (!open && known) setMc(Number((currentMc * 1.2).toPrecision(3)));
            setOpen((o) => !o);
          }}
        >
          {mine.length > 0 ? <BellRing /> : <Bell />}
        </IconButton>
      </Tooltip>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} align="end" width={280} padding="form">
        <div className="space-y-3">
          <div className="text-data font-semibold text-fg-1">Alert when {token.symbol} MC crosses</div>
          <div className="flex items-center gap-2">
            <FormattedInput
              value={mc}
              format={(v) => (usd ? fmtCompact(v) : fmtSol(v))}
              onChange={setMc}
              onStep={(d) => setMc((v) => v * (1 + d / 100))}
              prefix={usd ? "$" : undefined}
              suffix={usd ? "MC" : "SOL MC"}
              ariaLabel="Alert market cap"
              className="flex-1"
              onEnter={add}
            />
            <Button variant="primary" size="sm" disabled={!known} onClick={add}>
              Add alert
            </Button>
          </div>
          {!known && <p className="text-label text-fg-3">The market cap is unknown right now, so there is nothing to measure from.</p>}
          {mine.length > 0 && (
            <ul className="space-y-1">
              {mine.map((a) => (
                <li key={a.id} className="flex h-6 items-center justify-between gap-2 text-data">
                  <span className="text-fg-2">
                    {a.above ? "Above" : "Below"}{" "}
                    <span className="zf-num text-fg-1">{alertLevelText(a.priceSol, token.supply, quote, solUsd).replace("MC ", "")}</span>
                  </span>
                  <IconButton size="xs" label="Remove alert" onClick={() => removeAlert(a.id)}>
                    <X />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
          <p className="text-label text-fg-3">Alerts fire once while this page is open. Drag the dashed line on the chart to move one.</p>
        </div>
      </Popover>
    </>
  );
}
