import { ProgressBar } from "../../components/ui/bits";
import { NumberInput, Switch } from "../../components/ui/controls";
import { fmtSol, fmtSolShort } from "../../lib/format";
import { PRESET_IDS, useSettings } from "../../state/settings";
import { useTrades } from "../../state/trades";
import { Note, Row, Rows, SectionHeader, SubHeader } from "./ui";

/*
 * Limits (DESIGN.md 5.5, SPEC "Signer firewall"): per-trade and daily caps with today's usage,
 * and the clipboard auto-buy switch. Usage meter after Cohere's spending limit (label, amount,
 * thin bar, reset note): https://mobbin.com/screens/1724cae1-3fec-4396-bf64-03890aa6f77a
 */
export function LimitsSection() {
  const caps = useSettings((s) => s.caps);
  const setCaps = useSettings((s) => s.setCaps);
  const presets = useSettings((s) => s.presets);
  const quickBuy = useSettings((s) => s.quickBuySol);
  const activePreset = useSettings((s) => s.activePreset);
  const autoBuyOnPaste = useSettings((s) => s.autoBuyOnPaste);
  const setAutoBuyOnPaste = useSettings((s) => s.setAutoBuyOnPaste);
  const spent = useTrades((s) => s.spentToday());

  const usage = caps.dailySol > 0 ? spent / caps.dailySol : 1;
  // A full meter is a warning about what happens next, not a loss: warn, never sell.
  const meterColor = usage >= 0.8 ? "bg-warn" : "bg-fg-2";

  const overCap: string[] = [];
  for (const id of PRESET_IDS) {
    const p = presets[id];
    const largest = Math.max(0, ...p.buyAmounts, ...p.instantBuy);
    if (largest > caps.perTradeSol) overCap.push(`${id} buttons up to ${fmtSolShort(largest)} SOL`);
  }
  if (quickBuy > caps.perTradeSol) overCap.push(`quick buy ${fmtSolShort(quickBuy)} SOL`);

  return (
    <>
      <SectionHeader
        title="Limits"
        description="Enforced by the signer firewall in this browser before anything is signed, and checked again on the server."
      />
      <SubHeader anchor="caps">Caps</SubHeader>
      <Rows>
        <Row label="Per-trade cap" help="The largest single buy the signer will sign. Default 5 SOL." htmlFor="zf-cap-trade">
          <NumberInput
            id="zf-cap-trade"
            value={caps.perTradeSol}
            onChange={(v) => {
              if (v !== null && v > 0) setCaps({ perTradeSol: v });
            }}
            min={0.001}
            step={(v) => (v < 1 ? 0.01 : 0.1)}
            suffix="SOL"
            ariaLabel="Per-trade cap, SOL"
            className="w-full"
          />
        </Row>
        <Row label="Daily cap" help="Total buys per day. The counter resets at local midnight. Default 50 SOL." htmlFor="zf-cap-daily">
          <NumberInput
            id="zf-cap-daily"
            value={caps.dailySol}
            onChange={(v) => {
              if (v !== null && v > 0) setCaps({ dailySol: v });
            }}
            min={0.001}
            step={1}
            suffix="SOL"
            ariaLabel="Daily cap, SOL"
            className="w-full"
          />
        </Row>
        <Row
          label="Spent today"
          help={
            usage >= 1
              ? "Daily cap reached: new buys are refused until local midnight."
              : `${fmtSol(Math.max(0, caps.dailySol - spent))} SOL left today.`
          }
        >
          <div className="flex w-full flex-col items-end gap-1">
            <span className="zf-num text-data text-fg-1">
              {fmtSol(spent)} <span className="zf-unit">of {fmtSol(caps.dailySol)} SOL</span>
            </span>
            <ProgressBar value={usage} color={meterColor} />
          </div>
        </Row>
      </Rows>
      {(caps.dailySol < caps.perTradeSol || overCap.length > 0) && (
        <div className="mt-2 space-y-1">
          {caps.dailySol < caps.perTradeSol && (
            <Note tone="warn">
              The daily cap is below the per-trade cap, so no single buy can be larger than {fmtSolShort(caps.dailySol)} SOL.
            </Note>
          )}
          {overCap.length > 0 && <Note tone="warn">Above your per-trade cap, so the signer will refuse them: {overCap.join(", ")}.</Note>}
        </div>
      )}

      <SubHeader anchor="paste">Clipboard</SubHeader>
      <Rows>
        <Row
          label="Auto-buy on paste"
          help={`Paste a contract address outside a text field to buy ${fmtSolShort(quickBuy)} SOL at once with ${activePreset}. Off: a paste only opens the token.`}
        >
          <Switch checked={autoBuyOnPaste} onChange={setAutoBuyOnPaste} label="Auto-buy on paste" />
        </Row>
      </Rows>
      {autoBuyOnPaste && (
        <Note tone="warn" className="mt-2">
          A paste buys immediately, with no confirmation. Clipboard hijackers swap copied addresses, so check the token before you paste.
        </Note>
      )}
    </>
  );
}
