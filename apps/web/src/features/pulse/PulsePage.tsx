import { Ban, LayoutList } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { QuickBuyControl } from "../../app/TopNav";
import { Button } from "../../components/ui/Button";
import { Segmented, Switch } from "../../components/ui/controls";
import { Popover } from "../../components/ui/Popover";
import { type HotkeyAction, registerHotkey } from "../../lib/hotkeys";
import { buy, sell, sellInitials } from "../../lib/tradeActions";
import { BREAKPOINT, useMediaQuery } from "../../lib/useMediaQuery";
import type { PulseColumnId } from "../../protocol";
import { useSettings } from "../../state/settings";
import { useToasts } from "../../state/toasts";
import { useUi } from "../../state/ui";
import { FilterModal } from "./FilterModal";
import { COLUMN_TITLE, PulseColumn } from "./PulseColumn";

const COLUMNS: PulseColumnId[] = ["new", "final", "migrated"];

/** Space+1..4 buy / Space+Q..R sell the hovered card with the active preset's Instant Trade amounts. */
function usePulseHotkeys(): void {
  useEffect(() => {
    const target = () => {
      const mint = useUi.getState().hoverMint;
      if (!mint)
        useToasts
          .getState()
          .push({ kind: "info", title: "Hover a token card first", body: "Pulse hotkeys act on the card under the cursor.", ttl: 2000 });
      return mint;
    };
    const preset = () => {
      const s = useSettings.getState();
      return s.presets[s.activePreset];
    };
    const offs: (() => void)[] = [];
    for (let i = 0; i < 4; i++) {
      offs.push(
        registerHotkey(`buy.${i + 1}` as HotkeyAction, () => {
          const mint = target();
          const sol = preset().instantBuy[i];
          if (mint && sol) void buy({ mint, sol, source: "hotkey" });
        }),
        registerHotkey(`sell.${i + 1}` as HotkeyAction, () => {
          const mint = target();
          const pct = preset().instantSellPct[i];
          if (mint && pct) void sell({ mint, pct, source: "hotkey" });
        }),
      );
    }
    offs.push(
      registerHotkey("sell.initials", () => {
        const mint = target();
        if (mint) void sellInitials(mint, "hotkey");
      }),
    );
    return () => {
      for (const off of offs) off();
      useUi.getState().setHoverMint(null);
    };
  }, []);
}

function DisplayMenu() {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const display = useSettings((s) => s.display);
  const setDisplay = useSettings((s) => s.setDisplay);
  const rows: { key: "compactCards" | "metricColors" | "showProgressRing" | "largeQuickBuy"; label: string }[] = [
    { key: "compactCards", label: "Compact cards" },
    { key: "metricColors", label: "Risk and price colours" },
    { key: "showProgressRing", label: "Bonding progress ring" },
    { key: "largeQuickBuy", label: "Large quick-buy buttons" },
  ];
  return (
    <>
      <Button ref={anchor} size="sm" variant="ghost" icon={<LayoutList className="icon-sm" />} onClick={() => setOpen((o) => !o)}>
        Display
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} align="end" width={248}>
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.key} className="flex items-center justify-between gap-2 px-1 text-sm">
              <span className="text-muted">{r.label}</span>
              <Switch checked={display[r.key]} onChange={(v) => setDisplay({ [r.key]: v })} label={r.label} />
            </div>
          ))}
          <div className="border-t border-line px-1 pt-2">
            <div className="zf-label mb-1">List refresh rate</div>
            <Segmented<string>
              size="xs"
              className="w-full"
              value={String(display.pulseHz)}
              onChange={(v) => setDisplay({ pulseHz: Number(v) })}
              options={["4", "6", "8", "10"].map((v) => ({ value: v, label: `${v} Hz` }))}
              label="Pulse refresh rate"
            />
          </div>
        </div>
      </Popover>
    </>
  );
}

/**
 * Pulse: three live columns (New Pairs / Final Stretch / Migrated), each with its own search,
 * quick-buy amount, preset and filters; segmented tabs on narrow screens.
 */
export default function PulsePage() {
  const [filterColumn, setFilterColumn] = useState<PulseColumnId | null>(null);
  const [mobileColumn, setMobileColumn] = useState<PulseColumnId>("new");
  const blacklisted = useSettings(
    (s) => s.blacklists.tokens.length + s.blacklists.devs.length + s.blacklists.fundingWallets.length + s.blacklists.xHandles.length,
  );
  const openSettings = useUi((s) => s.openSettings);
  const wide = useMediaQuery(BREAKPOINT.lg);
  usePulseHotkeys();

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-line bg-panel px-3">
        <h1 className="text-lg font-semibold">Pulse</h1>
        <div className="xl:hidden">
          <QuickBuyControl />
        </div>
        <div className="ml-auto flex items-center gap-1">
          {blacklisted > 0 && (
            <Button size="sm" variant="ghost" icon={<Ban className="icon-sm" />} onClick={() => openSettings("blacklists")}>
              {blacklisted} blacklisted
            </Button>
          )}
          <DisplayMenu />
        </div>
      </div>

      {wide ? (
        <div className="flex min-h-0 flex-1 divide-x divide-line">
          {COLUMNS.map((c) => (
            <PulseColumn key={c} column={c} onOpenFilters={setFilterColumn} />
          ))}
        </div>
      ) : (
        <>
          <div className="shrink-0 border-b border-line p-2">
            <Segmented<PulseColumnId>
              className="w-full"
              value={mobileColumn}
              onChange={setMobileColumn}
              options={COLUMNS.map((c) => ({ value: c, label: COLUMN_TITLE[c] }))}
              label="Pulse column"
            />
          </div>
          <div className="flex min-h-0 flex-1">
            <PulseColumn key={mobileColumn} column={mobileColumn} onOpenFilters={setFilterColumn} />
          </div>
        </>
      )}

      <FilterModal open={filterColumn !== null} column={filterColumn ?? "new"} onClose={() => setFilterColumn(null)} />
    </div>
  );
}
