import { type ComponentType, lazy, type ReactNode, Suspense } from "react";
import { ApprovalModal } from "../features/trade/ApprovalModal";
import { UnlockModal } from "../features/trade/UnlockModal";
import { useUi } from "../state/ui";
import { HotkeysHelp } from "./HotkeysHelp";
import { PanicDialog } from "./PanicDialog";
import { RiskConfirmDialog } from "./RiskConfirmDialog";
import { Toasts } from "./Toasts";
import { TradeReviewSheet } from "./TradeReviewSheet";

/** React.lazy for a named export. */
function lazyNamed<M, K extends keyof M>(load: () => Promise<M>, name: K) {
  return lazy(async () => ({ default: (await load())[name] as ComponentType }));
}

/*
 * Overlays that aren't needed for the first paint load in their own chunks, keeping the shell
 * plus Pulse inside the initial-JS budget (DESIGN.md 8). They stay mounted, so their chunks load
 * right after start-up and open instantly; each has its own boundary so a slow chunk never hides
 * another overlay. The trade-critical ones (unlock, wallet approval, risk confirm, touch review,
 * Panic, toasts) stay in the main bundle.
 */
const SearchModal = lazyNamed(() => import("../features/search/SearchModal"), "SearchModal");
const FundModal = lazyNamed(() => import("../features/trade/FundModal"), "FundModal");
const InstantTradeWindow = lazyNamed(() => import("../features/trade/InstantTradeWindow"), "InstantTradeWindow");
const TrackerDock = lazyNamed(() => import("../features/trackers/TrackerDock"), "TrackerDock");
const SettingsDrawer = lazy(() => import("../features/settings/SettingsDrawer"));

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={null}>{children}</Suspense>;
}

export function GlobalOverlays() {
  const settingsOpen = useUi((s) => s.settingsOpen);
  return (
    <>
      <Lazy>
        <SearchModal />
      </Lazy>
      {settingsOpen && (
        <Lazy>
          <SettingsDrawer />
        </Lazy>
      )}
      <Lazy>
        <FundModal />
      </Lazy>
      <UnlockModal />
      <ApprovalModal />
      <HotkeysHelp />
      <PanicDialog />
      <RiskConfirmDialog />
      <TradeReviewSheet />
      <Lazy>
        <InstantTradeWindow />
      </Lazy>
      <Lazy>
        <TrackerDock />
      </Lazy>
      <Toasts />
    </>
  );
}
