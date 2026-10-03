import { ArrowUpFromLine, Ban, Info, Keyboard, type LucideIcon, Palette, Shield, SlidersHorizontal, Zap } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef } from "react";
import { Drawer } from "../../components/ui/Modal";
import { cn } from "../../lib/cn";
import { type SettingsTab, useUi } from "../../state/ui";
import { AboutTab } from "./AboutTab";
import { BlacklistsTab } from "./BlacklistsTab";
import { DisplayTab } from "./DisplayTab";
import { HotkeysTab } from "./HotkeysTab";
import { PresetsTab } from "./PresetsTab";
import { SecurityTab } from "./SecurityTab";
import { TradingTab } from "./TradingTab";
import { WithdrawalsTab } from "./WithdrawalsTab";

const TABS: { id: SettingsTab; label: string; icon: LucideIcon }[] = [
  { id: "presets", label: "Presets", icon: SlidersHorizontal },
  { id: "hotkeys", label: "Hotkeys", icon: Keyboard },
  { id: "display", label: "Display", icon: Palette },
  { id: "trading", label: "Trading", icon: Zap },
  { id: "security", label: "Security", icon: Shield },
  { id: "withdrawals", label: "Withdrawals", icon: ArrowUpFromLine },
  { id: "blacklists", label: "Blacklists", icon: Ban },
  { id: "about", label: "About", icon: Info },
];

function TabContent({ tab }: { tab: SettingsTab }) {
  switch (tab) {
    case "presets":
      return <PresetsTab />;
    case "hotkeys":
      return <HotkeysTab />;
    case "display":
      return <DisplayTab />;
    case "trading":
      return <TradingTab />;
    case "security":
      return <SecurityTab />;
    case "withdrawals":
      return <WithdrawalsTab />;
    case "blacklists":
      return <BlacklistsTab />;
    case "about":
      return <AboutTab />;
  }
}

/*
 * Settings drawer: right-side drawer (Uniswap settings drawer, as in components/ui Drawer) with
 * a vertical category list like Graphite's settings; the list becomes a horizontal scrolling
 * strip on narrow screens.
 * https://mobbin.com/screens/debc076d-b186-42b2-8c23-b1fae356c2d1
 * https://mobbin.com/screens/102736c8-9a2a-4185-a155-025f1c0b3217
 */
export default function SettingsDrawer() {
  const open = useUi((s) => s.settingsOpen);
  const tab = useUi((s) => s.settingsTab);
  const openSettings = useUi((s) => s.openSettings);
  const close = useUi((s) => s.closeSettings);
  const tabRefs = useRef<Partial<Record<SettingsTab, HTMLButtonElement | null>>>({});
  const panelRef = useRef<HTMLDivElement>(null);

  // A new tab starts at the top, and stays visible in the horizontal strip on phones.
  useEffect(() => {
    tabRefs.current[tab]?.scrollIntoView({ block: "nearest", inline: "nearest" });
    panelRef.current?.scrollTo({ top: 0 });
  }, [tab]);

  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    const target = TABS[next];
    if (!target) return;
    e.preventDefault();
    openSettings(target.id);
    tabRefs.current[target.id]?.focus();
  };

  return (
    <Drawer open={open} onClose={close} title="Settings" width={720}>
      <div className="flex h-full min-h-0 flex-col sm:flex-row">
        <div
          role="tablist"
          aria-label="Settings sections"
          className="flex shrink-0 gap-1 overflow-x-auto border-b border-hairline p-2 sm:w-36 sm:flex-col sm:overflow-x-visible sm:overflow-y-auto sm:border-r sm:border-b-0"
        >
          {TABS.map((t, i) => {
            const active = t.id === tab;
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                ref={(el) => {
                  tabRefs.current[t.id] = el;
                }}
                type="button"
                role="tab"
                id={`zf-settings-tab-${t.id}`}
                aria-selected={active}
                aria-controls="zf-settings-panel"
                tabIndex={active ? 0 : -1}
                onClick={() => openSettings(t.id)}
                onKeyDown={(e) => onTabKeyDown(e, i)}
                className={cn(
                  "flex h-7 shrink-0 items-center gap-2 whitespace-nowrap rounded-sm px-2 text-data transition-colors",
                  active ? "bg-surface-3 text-fg-1" : "text-fg-2 hover:bg-surface-3 hover:text-fg-1",
                )}
              >
                <Icon className="icon-md" />
                {t.label}
              </button>
            );
          })}
        </div>
        <div
          ref={panelRef}
          role="tabpanel"
          id="zf-settings-panel"
          aria-labelledby={`zf-settings-tab-${tab}`}
          className="min-h-0 flex-1 overflow-y-auto p-4"
        >
          <TabContent tab={tab} />
        </div>
      </div>
    </Drawer>
  );
}
