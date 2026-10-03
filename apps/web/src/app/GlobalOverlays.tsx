import { lazy, Suspense } from "react";
import { SearchModal } from "../features/search/SearchModal";
import { TrackerDock } from "../features/trackers/TrackerDock";
import { ApprovalModal } from "../features/trade/ApprovalModal";
import { FundModal } from "../features/trade/FundModal";
import { InstantTradeWindow } from "../features/trade/InstantTradeWindow";
import { UnlockModal } from "../features/trade/UnlockModal";
import { useUi } from "../state/ui";
import { HotkeysHelp } from "./HotkeysHelp";
import { PanicDialog } from "./PanicDialog";
import { Toasts } from "./Toasts";

const SettingsDrawer = lazy(() => import("../features/settings/SettingsDrawer"));

export function GlobalOverlays() {
  const settingsOpen = useUi((s) => s.settingsOpen);
  return (
    <>
      <SearchModal />
      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsDrawer />
        </Suspense>
      )}
      <FundModal />
      <UnlockModal />
      <ApprovalModal />
      <HotkeysHelp />
      <PanicDialog />
      <InstantTradeWindow />
      <TrackerDock />
      <Toasts />
    </>
  );
}
