import { type ComponentType, lazy, type ReactNode, Suspense } from "react";
import { useUi } from "../state/ui";

/** React.lazy for a named export. */
function lazyNamed<M, K extends keyof M>(load: () => Promise<M>, name: K) {
  return lazy(async () => ({ default: (await load())[name] as ComponentType }));
}

/*
 * Overlays that aren't needed for the first paint load in their own chunks, keeping the shell
 * plus Pulse inside the initial-JS budget (DESIGN.md 8). They stay mounted, so their chunks load
 * right after start-up (in parallel with the first data, a few KB each) and are in place long before
 * anything can open them; each has its own boundary so a slow chunk never hides another overlay. That
 * now includes the trade-critical ones (unlock, wallet approval, risk confirm, touch review, Panic,
 * toasts): their state lives in stores, so nothing raised before a chunk lands is lost.
 */
const SearchModal = lazyNamed(() => import("../features/search/SearchModal"), "SearchModal");
const FundModal = lazyNamed(() => import("../features/trade/FundModal"), "FundModal");
const InstantTradeWindow = lazyNamed(() => import("../features/trade/InstantTradeWindow"), "InstantTradeWindow");
const TrackerDock = lazyNamed(() => import("../features/trackers/TrackerDock"), "TrackerDock");
const SettingsDrawer = lazy(() => import("../features/settings/SettingsDrawer"));
const HotkeysHelp = lazyNamed(() => import("./HotkeysHelp"), "HotkeysHelp");
const UnlockModal = lazyNamed(() => import("../features/trade/UnlockModal"), "UnlockModal");
const ApprovalModal = lazyNamed(() => import("../features/trade/ApprovalModal"), "ApprovalModal");
const PanicDialog = lazyNamed(() => import("./PanicDialog"), "PanicDialog");
const RiskConfirmDialog = lazyNamed(() => import("./RiskConfirmDialog"), "RiskConfirmDialog");
const TradeReviewSheet = lazyNamed(() => import("./TradeReviewSheet"), "TradeReviewSheet");
const Toasts = lazyNamed(() => import("./Toasts"), "Toasts");

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
      <Lazy>
        <UnlockModal />
      </Lazy>
      <Lazy>
        <ApprovalModal />
      </Lazy>
      <Lazy>
        <HotkeysHelp />
      </Lazy>
      <Lazy>
        <PanicDialog />
      </Lazy>
      <Lazy>
        <RiskConfirmDialog />
      </Lazy>
      <Lazy>
        <TradeReviewSheet />
      </Lazy>
      <Lazy>
        <InstantTradeWindow />
      </Lazy>
      <Lazy>
        <TrackerDock />
      </Lazy>
      <Lazy>
        <Toasts />
      </Lazy>
    </>
  );
}
