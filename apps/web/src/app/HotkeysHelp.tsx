import { Button } from "../components/ui/Button";
import { Hotkey } from "../components/ui/controls";
import { Modal } from "../components/ui/Modal";
import { HOTKEY_ACTIONS } from "../lib/hotkeys";
import { useSettings } from "../state/settings";
import { useUi } from "../state/ui";

export function HotkeysHelp() {
  const open = useUi((s) => s.hotkeysHelpOpen);
  const setOpen = useUi((s) => s.setHotkeysHelp);
  const openSettings = useUi((s) => s.openSettings);
  const hotkeys = useSettings((s) => s.hotkeys);
  const tradeHotkeys = useSettings((s) => s.tradeHotkeys);
  const groups = ["General", "Trading", "Navigation"] as const;
  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      title="Keyboard shortcuts"
      width={560}
      footer={
        <div className="flex items-center justify-between text-[11px] text-dim">
          <span>
            Trade hotkeys are {tradeHotkeys ? "on" : "off"}. Hold Space, then press the key. Buys target the hovered Pulse card or the open
            token.
          </span>
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              setOpen(false);
              openSettings("hotkeys");
            }}
          >
            Edit
          </Button>
        </div>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {groups.map((g) => (
          <div key={g} className={g === "Trading" ? "sm:row-span-2" : ""}>
            <div className="zf-label mb-1.5">{g}</div>
            <div className="space-y-1">
              {HOTKEY_ACTIONS.filter((a) => a.group === g).map((a) => (
                <div key={a.id} className="flex items-center justify-between gap-2 text-xs">
                  <span className="text-muted">{a.label}</span>
                  <span className="flex gap-1">
                    {(hotkeys[a.id] ?? []).map((b) => (
                      <Hotkey key={b} binding={b} />
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
