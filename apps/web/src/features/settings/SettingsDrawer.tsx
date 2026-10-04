import { Search } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Drawer } from "../../components/ui/Modal";
import { cn } from "../../lib/cn";
import { type PresetId, useSettings } from "../../state/settings";
import { useUi } from "../../state/ui";
import { AboutSection } from "./AboutSection";
import { AlertsSection } from "./AlertsSection";
import { BlacklistsSection } from "./BlacklistsSection";
import { DisplaySection } from "./DisplaySection";
import { HotkeysSection } from "./HotkeysSection";
import { LandingSection } from "./LandingSection";
import { LimitsSection } from "./LimitsSection";
import { MetricsSection } from "./MetricsSection";
import { PresetsSection } from "./PresetsSection";
import {
  anchorId,
  onSettingsTarget,
  SECTION_BY_ID,
  SECTIONS,
  type SectionId,
  type SettingsTarget,
  searchSettings,
  TARGET_FOR_TAB,
  takePendingTarget,
} from "./sections";
import { WalletsSection } from "./WalletsSection";

const TRADING = SECTIONS.filter((s) => s.group === "Trading");
const TOP_LEVEL = SECTIONS.filter((s) => !s.group);
/** Visual order of the nav (keyboard order follows it). */
const ORDER: SectionId[] = [...TRADING, ...TOP_LEVEL].map((s) => s.id);
const NAV_LIST = "flex min-h-0 gap-1 overflow-x-auto px-2 pb-2 sm:flex-col sm:gap-0 sm:overflow-x-visible sm:overflow-y-auto";

/*
 * Settings drawer (DESIGN.md 5.5): 720 px from the right, a 176 px nav with search and groups
 * (Trading: Presets, Landing, Limits, Blacklists; then Hotkeys, Display, Wallets and security,
 * Alerts, Metrics, About) and a 544 px content column with 16 px padding. Below 640 px the nav
 * becomes a scrolling strip above the content. Searchable nav after Devin:
 * https://mobbin.com/screens/93170d84-7435-4c89-82b5-647330913aba
 */
export default function SettingsDrawer() {
  const open = useUi((s) => s.settingsOpen);
  const tab = useUi((s) => s.settingsTab);
  const openSettings = useUi((s) => s.openSettings);
  const close = useUi((s) => s.closeSettings);
  const [target, setTarget] = useState<SettingsTarget>(() => takePendingTarget() ?? TARGET_FOR_TAB[tab]);
  const [editing, setEditing] = useState<PresetId>(() => useSettings.getState().activePreset);
  const [query, setQuery] = useState("");
  const lastTab = useRef(tab);
  const panelRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Partial<Record<SectionId, HTMLButtonElement | null>>>({});
  const section = target.section;

  // Store tab changed elsewhere while open (e.g. a "Caps" action in a toast).
  useEffect(() => {
    if (tab === lastTab.current) return;
    lastTab.current = tab;
    setTarget(takePendingTarget() ?? TARGET_FOR_TAB[tab]);
  }, [tab]);

  // openSettingsAt() while the drawer is already open.
  useEffect(
    () =>
      onSettingsTarget((t) => {
        takePendingTarget();
        lastTab.current = SECTION_BY_ID[t.section].tab ?? lastTab.current;
        setTarget(t);
      }),
    [],
  );

  // New section: back to the top, or to the requested row.
  useEffect(() => {
    const anchor = target.anchor === "export" ? "wallets" : target.anchor;
    const el = anchor ? document.getElementById(anchorId(anchor)) : null;
    if (el) el.scrollIntoView({ block: "start" });
    else panelRef.current?.scrollTo({ top: 0 });
    itemRefs.current[target.section]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [target]);

  const goTo = (id: SectionId, anchor?: string) => {
    setTarget({ section: id, anchor });
    const t = SECTION_BY_ID[id].tab;
    if (t && t !== lastTab.current) {
      lastTab.current = t;
      openSettings(t);
    }
  };

  const onNavKey = (e: KeyboardEvent<HTMLButtonElement>, id: SectionId) => {
    const i = ORDER.indexOf(id);
    let next = -1;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") next = (i + 1) % ORDER.length;
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") next = (i - 1 + ORDER.length) % ORDER.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = ORDER.length - 1;
    const nextId = ORDER[next];
    if (!nextId) return;
    e.preventDefault();
    goTo(nextId);
    itemRefs.current[nextId]?.focus();
  };

  const hits = searchSettings(query);

  const itemClass = (active: boolean, nested?: boolean) =>
    cn(
      "focus-inset flex h-7 shrink-0 items-center gap-2 rounded-sm pr-2 text-left text-data font-medium whitespace-nowrap transition-colors max-sm:h-11 sm:w-full",
      nested ? "pl-4 max-sm:pl-2" : "pl-2",
      active ? "bg-surface-3 text-fg-1" : "text-fg-2 hover:text-fg-1",
    );

  /** A nav tab: 28 px, 12/500; the active one is text-1 on surface-3 (5.5). */
  const navTab = (id: SectionId, nested?: boolean) => {
    const active = id === section;
    return (
      <button
        key={id}
        ref={(el) => {
          itemRefs.current[id] = el;
        }}
        type="button"
        role="tab"
        id={`zf-settings-tab-${id}`}
        aria-selected={active}
        aria-controls="zf-settings-panel"
        tabIndex={active ? 0 : -1}
        onClick={() => goTo(id)}
        onKeyDown={(e) => onNavKey(e, id)}
        className={itemClass(active, nested)}
      >
        <span className="truncate">{SECTION_BY_ID[id].label}</span>
      </button>
    );
  };

  /** While searching: a result that jumps to a section, or to the matching row. */
  const resultItem = (id: SectionId, term?: string, anchor?: string) => (
    <button
      key={`${id}-${term ?? ""}`}
      type="button"
      onClick={() => {
        goTo(id, anchor);
        setQuery("");
      }}
      className={itemClass(false)}
    >
      <span className="truncate">{SECTION_BY_ID[id].label}</span>
      {term && <span className="min-w-0 truncate font-normal text-fg-3">{term}</span>}
    </button>
  );

  return (
    <Drawer open={open} onClose={close} title="Settings" width={720}>
      <div className="flex h-full min-h-0 flex-col sm:flex-row">
        <nav aria-label="Settings sections" className="flex shrink-0 flex-col border-hairline max-sm:border-b sm:w-44 sm:border-r">
          <div className="p-2 pb-1">
            <label className="relative block">
              <span className="sr-only">Search settings</span>
              <Search className="icon-sm pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-fg-3" />
              <input
                type="search"
                className="zf-input pl-7 max-sm:h-11"
                placeholder="Search settings"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && query) {
                    e.preventDefault();
                    e.stopPropagation();
                    setQuery("");
                  } else if (e.key === "Enter" && hits[0]) {
                    e.preventDefault();
                    goTo(hits[0].section.id, hits[0].term?.anchor);
                    setQuery("");
                  }
                }}
              />
            </label>
          </div>
          {query.trim() ? (
            <section aria-label="Search results" className={NAV_LIST}>
              {hits.length > 0 ? (
                hits.map((h) => resultItem(h.section.id, h.term?.text, h.term?.anchor))
              ) : (
                <p className="px-2 py-1 text-label text-fg-3">No settings match.</p>
              )}
            </section>
          ) : (
            <div role="tablist" aria-orientation="vertical" aria-label="Settings sections" className={NAV_LIST}>
              <div role="presentation" className="zf-group-label px-2 pt-2 pb-1 max-sm:hidden">
                Trading
              </div>
              {TRADING.map((s) => navTab(s.id, true))}
              <div role="presentation" className="h-2 max-sm:hidden" />
              {TOP_LEVEL.map((s) => navTab(s.id))}
            </div>
          )}
        </nav>
        <div
          ref={panelRef}
          role="tabpanel"
          id="zf-settings-panel"
          aria-labelledby={`zf-settings-tab-${section}`}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 pb-12"
        >
          {section === "presets" && <PresetsSection editing={editing} onEditing={setEditing} onNavigate={goTo} />}
          {section === "landing" && <LandingSection editing={editing} onEditing={setEditing} onNavigate={goTo} />}
          {section === "limits" && <LimitsSection />}
          {section === "blacklists" && <BlacklistsSection />}
          {section === "hotkeys" && <HotkeysSection />}
          {section === "display" && <DisplaySection />}
          {section === "security" && <WalletsSection key={target.anchor ?? ""} initialExport={target.anchor === "export"} />}
          {section === "alerts" && <AlertsSection />}
          {section === "metrics" && <MetricsSection onNavigate={goTo} />}
          {section === "about" && <AboutSection />}
        </div>
      </div>
    </Drawer>
  );
}
