import { ProgressBar } from "../../components/ui/bits";
import { NumberInput, Switch } from "../../components/ui/controls";
import { fmtSol, fmtSolShort } from "../../lib/format";
import type { TradeMode } from "../../services/tradeService";
import { PRESET_IDS, useSettings } from "../../state/settings";
import { useTrades } from "../../state/trades";
import { useWallet } from "../../state/wallet";
import { MODE_INFO, MODES } from "./modes";
import { Group, Note, RadioCard, Row, TabHeader } from "./ui";

/*
 * Trading defaults and limits. The daily-cap meter follows Cohere's spending limit (label,
 * amount, thin usage bar, reset note):
 * https://mobbin.com/screens/1724cae1-3fec-4396-bf64-03890aa6f77a
 */
export function TradingTab() {
  const defaultMode = useSettings((s) => s.defaultMode);
  const setDefaultMode = useSettings((s) => s.setDefaultMode);
  const caps = useSettings((s) => s.caps);
  const setCaps = useSettings((s) => s.setCaps);
  const presets = useSettings((s) => s.presets);
  const quickBuy = useSettings((s) => s.quickBuySol);
  const activePreset = useSettings((s) => s.activePreset);
  const autoBuyOnPaste = useSettings((s) => s.autoBuyOnPaste);
  const setAutoBuyOnPaste = useSettings((s) => s.setAutoBuyOnPaste);
  const setMode = useWallet((s) => s.setMode);
  const spent = useTrades((s) => s.spentToday());

  const chooseMode = (mode: TradeMode) => {
    setDefaultMode(mode);
    setMode(mode);
  };

  const usage = caps.dailySol > 0 ? spent / caps.dailySol : 1;
  const meterColor = usage >= 1 ? "bg-sell" : usage >= 0.8 ? "bg-warn" : "bg-fg-2";

  const overCap: string[] = [];
  for (const id of PRESET_IDS) {
    const p = presets[id];
    const largest = Math.max(0, ...p.buyAmounts, ...p.instantBuy);
    if (largest > caps.perTradeSol) overCap.push(`${id} (${fmtSolShort(largest)} SOL)`);
  }
  if (quickBuy > caps.perTradeSol) overCap.push(`quick buy (${fmtSolShort(quickBuy)} SOL)`);

  return (
    <>
      <TabHeader title="Trading" description="Default signing mode, spending limits and clipboard behaviour." />

      <Group title="Default mode" description="Changing it here also switches the mode you're trading in now.">
        <div className="space-y-2 p-3">
          {MODES.map((m) => (
            <RadioCard key={m} name="zf-default-mode" checked={defaultMode === m} onSelect={() => chooseMode(m)} title={MODE_INFO[m].label}>
              <span className="block text-fg-1">{MODE_INFO[m].summary}</span>
              <span className="block">{MODE_INFO[m].detail}</span>
            </RadioCard>
          ))}
        </div>
      </Group>

      <Group title="Limits" description="Enforced by the signer firewall in your browser and re-checked on the server.">
        <Row label="Per-trade cap" hint="The largest single buy the signer will sign.">
          <NumberInput
            value={caps.perTradeSol}
            onChange={(v) => {
              if (v !== null && v > 0) setCaps({ perTradeSol: v });
            }}
            min={0.001}
            suffix="SOL"
            alignRight
            className="w-32"
            ariaLabel="Per-trade cap, SOL"
          />
        </Row>
        <Row label="Daily cap" hint="Total buys per day; the counter resets at local midnight.">
          <NumberInput
            value={caps.dailySol}
            onChange={(v) => {
              if (v !== null && v > 0) setCaps({ dailySol: v });
            }}
            min={0.001}
            suffix="SOL"
            alignRight
            className="w-32"
            ariaLabel="Daily cap, SOL"
          />
        </Row>
        <div className="space-y-2 px-3 py-2">
          <div className="flex items-baseline justify-between gap-2">
            <span className="zf-label">Spent today</span>
            <span className="font-mono text-data text-fg-1">
              {fmtSol(spent)} <span className="text-fg-3">/ {fmtSol(caps.dailySol)} SOL</span>
            </span>
          </div>
          <ProgressBar value={usage} color={meterColor} />
          <div className="text-label text-fg-3">
            {usage >= 1
              ? "Daily cap reached: new buys are refused until local midnight."
              : `${fmtSol(Math.max(0, caps.dailySol - spent))} SOL left today.`}
          </div>
        </div>
      </Group>
      {(caps.dailySol < caps.perTradeSol || overCap.length > 0) && (
        <div className="mb-6 space-y-2">
          {caps.dailySol < caps.perTradeSol && (
            <Note tone="warn">
              The daily cap is below the per-trade cap, so no single buy can be larger than {fmtSolShort(caps.dailySol)} SOL.
            </Note>
          )}
          {overCap.length > 0 && <Note tone="warn">Above your per-trade cap, so the signer will refuse them: {overCap.join(", ")}.</Note>}
        </div>
      )}

      <Group title="Clipboard">
        <Row
          label="Auto-buy on paste"
          hint={`Paste a contract address anywhere outside a text field to buy ${fmtSolShort(quickBuy)} SOL at once with preset ${activePreset}.`}
        >
          <Switch checked={autoBuyOnPaste} onChange={setAutoBuyOnPaste} label="Auto-buy on paste" />
        </Row>
        <div className="px-3 py-2">
          <Note tone="warn">
            {autoBuyOnPaste
              ? "Auto-buy is on: a paste buys immediately, with no confirmation."
              : "When on, a paste buys immediately, with no confirmation."}{" "}
            Clipboard hijackers swap copied addresses, so check the token before you paste.
            {autoBuyOnPaste ? "" : " While it's off, a pasted address only opens the token page."}
          </Note>
        </div>
      </Group>
    </>
  );
}
