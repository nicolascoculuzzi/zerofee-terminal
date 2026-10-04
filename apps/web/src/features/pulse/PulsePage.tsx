import { Columns3 } from "lucide-react";
import { lazy, type RefObject, Suspense, useEffect, useRef } from "react";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/bits";
import { Segmented } from "../../components/ui/controls";
import { COLUMN_TITLE } from "../../config";
import { BREAKPOINT, useMediaQuery } from "../../lib/useMediaQuery";
import type { PulseColumnId } from "../../protocol";
import { useSettings } from "../../state/settings";
import { IconMasks } from "./icons";
import { MobilePulse } from "./MobilePulse";
import { PulseColumn } from "./PulseColumn";
import { PulseToolbar } from "./PulseToolbar";
import { usePulseUi } from "./store";
import { usePulseHotkeys } from "./usePulseHotkeys";

// Opened on demand: kept out of the Pulse route's first load (DESIGN.md 8, initial JS).
const FilterModal = lazy(() => import("./FilterModal").then((m) => ({ default: m.FilterModal })));
const BlacklistModal = lazy(() => import("./BlacklistModal").then((m) => ({ default: m.BlacklistModal })));
// Hover tips, the card menu and the dev-sell confirm: mounted with the page, their code loads right after the
// first rows (state lives in the Pulse store, so nothing opened meanwhile is lost).
const TipLayer = lazy(() =>
  Promise.all([import("./TipLayer"), import("./tipContent")]).then(([t, c]) => ({
    default: ({ root }: { root: RefObject<HTMLElement | null> }) => <t.TipLayer root={root} render={c.renderTip} />,
  })),
);
const TokenMenu = lazy(() => import("./TokenMenu").then((m) => ({ default: m.TokenMenu })));
const ConfirmDevDialog = lazy(() => import("./TokenMenu").then((m) => ({ default: m.ConfirmDevDialog })));

const SHORT_TITLE: Record<PulseColumnId, string> = { new: "New", final: "Final", migrated: "Migrated" };

/** 768–1023 px: the second column's header switches between the remaining columns (DESIGN.md 5.1). */
function SecondColumnSwitch({ column, options }: { column: PulseColumnId; options: PulseColumnId[] }) {
  const setTabletColumn = usePulseUi((s) => s.setTabletColumn);
  return (
    <Segmented<PulseColumnId>
      size="xs"
      value={column}
      onChange={setTabletColumn}
      options={options.map((c) => ({ value: c, label: SHORT_TITLE[c], title: COLUMN_TITLE[c] }))}
      label="Second column"
    />
  );
}

/**
 * Pulse (DESIGN.md 5.1, 5.8): the 32 px toolbar over three equal columns tiled with 1 px
 * hairlines from 1024 px; two from 768 px (column 2 switches between the rest); tabs and 64 px
 * rows on phones. The page owns the card tooltip layer, the icon masks, the hotkeys and the
 * overlays (filters, blacklist, card menu, dev confirm). The touch review sheet is global (tradeActions).
 */
export default function PulsePage() {
  const root = useRef<HTMLDivElement>(null);
  const desktop = useMediaQuery(BREAKPOINT.lg);
  const tablet = useMediaQuery(BREAKPOINT.md);
  const order = useSettings((s) => s.pulseLayout.order);
  const hidden = useSettings((s) => s.pulseLayout.hidden);
  const setPulseLayout = useSettings((s) => s.setPulseLayout);
  const tabletColumn = usePulseUi((s) => s.tabletColumn);
  const mobileColumn = usePulseUi((s) => s.mobileColumn);
  const filterOpen = usePulseUi((s) => s.filterColumn !== null);
  const blacklistOpen = usePulseUi((s) => s.blacklistOpen);
  usePulseHotkeys();

  const visible = order.filter((c) => !hidden.includes(c));
  const rest = visible.slice(1);
  const second = tabletColumn && rest.includes(tabletColumn) ? tabletColumn : rest[0];
  const first = visible[0];
  const columns: PulseColumnId[] = !tablet ? [mobileColumn] : desktop ? visible : [first, second].filter((c): c is PulseColumnId => !!c);
  const orderKey = columns.join(",");

  // biome-ignore lint/correctness/useExhaustiveDependencies: orderKey stands for the columns array
  useEffect(() => {
    usePulseUi.getState().setOrder(columns);
  }, [orderKey]);

  return (
    <div ref={root} className="flex h-full min-h-0 flex-col bg-bg">
      <IconMasks target={root} />
      {tablet && <PulseToolbar />}
      {!tablet ? (
        <MobilePulse />
      ) : visible.length === 0 ? (
        <div className="flex-1 bg-surface-1">
          <EmptyState
            icon={<Columns3 />}
            title="All columns are hidden"
            body="Show New Pairs, Final Stretch or Migrated again from the Columns menu."
            action={
              <Button size="sm" variant="secondary" onClick={() => setPulseLayout({ hidden: [] })}>
                Show all columns
              </Button>
            }
          />
        </div>
      ) : (
        <div
          className="grid min-h-0 flex-1 gap-px bg-hairline"
          style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}
        >
          {columns.map((c, i) => (
            <PulseColumn
              key={c}
              column={c}
              titleSlot={!desktop && i === 1 && rest.length > 1 ? <SecondColumnSwitch column={c} options={rest} /> : undefined}
            />
          ))}
        </div>
      )}
      <Suspense fallback={null}>
        <TipLayer root={root} />
      </Suspense>
      {filterOpen && (
        <Suspense fallback={null}>
          <FilterModal />
        </Suspense>
      )}
      {blacklistOpen && (
        <Suspense fallback={null}>
          <BlacklistModal />
        </Suspense>
      )}
      <Suspense fallback={null}>
        <TokenMenu />
        <ConfirmDevDialog />
      </Suspense>
    </div>
  );
}
