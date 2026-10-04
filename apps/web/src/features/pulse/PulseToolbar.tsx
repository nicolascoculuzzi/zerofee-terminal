import { Ban, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { CountBadge } from "../../components/ui/bits";
import { Hotkey, Segmented } from "../../components/ui/controls";
import { Tooltip } from "../../components/ui/Tooltip";
import { useSettings } from "../../state/settings";
import { ColumnsMenu } from "./ColumnsMenu";
import { DisplayMenu } from "./DisplayMenu";
import { usePulseUi } from "./store";
import { ToolbarButton } from "./ToolbarButton";

const COLUMNS = ["new", "final", "migrated"] as const;

/**
 * Pulse toolbar (DESIGN.md 5.1), 32 px under the top bar: Columns, Display, Blacklist (with its
 * count) and Sound on the left; the insert mode Live | Calm, Pause all (Shift+P) and the legend
 * toggle on the right. Greyscale: toggles show as text-1 on surface-3, nothing is coloured.
 */
export function PulseToolbar() {
  const blacklisted = useSettings(
    (s) => s.blacklists.tokens.length + s.blacklists.devs.length + s.blacklists.fundingWallets.length + s.blacklists.xHandles.length,
  );
  const soundOn = useSettings((s) => COLUMNS.some((c) => s.columns[c].sound));
  const setColumn = useSettings((s) => s.setColumn);
  const insertMode = useSettings((s) => s.display.insertMode);
  const setDisplay = useSettings((s) => s.setDisplay);
  const legend = useSettings((s) => s.pulseLayout.legend);
  const setPulseLayout = useSettings((s) => s.setPulseLayout);
  const pauseAllKey = useSettings((s) => s.hotkeys["pulse.pauseAll"]?.[0]);
  const pausedAll = usePulseUi((s) => s.pausedAll);

  return (
    <div className="flex h-panel-header shrink-0 items-center gap-1 border-b border-hairline bg-surface-1 px-2">
      <h1 className="sr-only">Pulse</h1>
      <ColumnsMenu />
      <DisplayMenu />
      <Tooltip content="Hidden tokens, devs, funding wallets and X accounts">
        <ToolbarButton onClick={() => usePulseUi.getState().openBlacklist(true)}>
          <Ban />
          Blacklist
          {blacklisted > 0 && <CountBadge count={blacklisted} />}
        </ToolbarButton>
      </Tooltip>
      <Tooltip content={soundOn ? "Mute new-token sounds in every column" : "Play a short tick for new tokens in every column"}>
        <ToolbarButton
          active={soundOn}
          onClick={() => {
            for (const c of COLUMNS) setColumn(c, { sound: !soundOn });
          }}
        >
          {soundOn ? <Volume2 /> : <VolumeX />}
          Sound
        </ToolbarButton>
      </Tooltip>

      <div className="ml-auto flex items-center gap-1">
        <Tooltip
          content={
            insertMode === "live"
              ? "Live: new tokens appear as the feed reports them."
              : "Calm: new tokens appear at most once a second, in batches."
          }
        >
          <Segmented<"live" | "calm">
            size="xs"
            value={insertMode}
            onChange={(v) => setDisplay({ insertMode: v })}
            options={[
              { value: "live", label: "Live" },
              { value: "calm", label: "Calm" },
            ]}
            label="Insert mode"
          />
        </Tooltip>
        <Tooltip
          content={
            <span className="flex items-center gap-2">
              {pausedAll ? "Resume all columns" : "Pause all columns"} <Hotkey binding={pauseAllKey} />
            </span>
          }
        >
          <ToolbarButton active={pausedAll} onClick={() => usePulseUi.getState().togglePauseAll()}>
            {pausedAll ? <Play /> : <Pause />}
            {pausedAll ? "Resume all" : "Pause all"}
          </ToolbarButton>
        </Tooltip>
        <Tooltip content="Risk legend under each column header: T Top 10 · D Dev · S Snipers · I Insiders · B Bundlers">
          <ToolbarButton active={legend} onClick={() => setPulseLayout({ legend: !legend })}>
            Legend
          </ToolbarButton>
        </Tooltip>
      </div>
    </div>
  );
}
