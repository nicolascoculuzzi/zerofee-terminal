import { Check, Ellipsis, EyeOff, Pause, Play, SlidersHorizontal } from "lucide-react";
import { useRef, useState } from "react";
import { IconButton } from "../../components/ui/Button";
import { Hotkey } from "../../components/ui/controls";
import { MenuGroupLabel, MenuItem, MenuSeparator, Popover } from "../../components/ui/Popover";
import { COLUMN_TITLE } from "../../config";
import type { PulseColumnId } from "../../protocol";
import { PRESET_IDS, useSettings } from "../../state/settings";
import { DEFAULT_SORT_LABEL, SORT_KEYS, SORT_LABEL, usePulseUi } from "./store";

/** Checkbox menu items show Check 14 px on the left (DESIGN.md 4.17); unchecked ones keep the slot. */
export function checkIcon(on: boolean) {
  return on ? <Check /> : <span aria-hidden="true" className="block size-3.5" />;
}

/**
 * Column "..." menu (DESIGN.md 4.3): pause, filters, sound, sort, legend and hide, plus the
 * P1–P3 presets when the header is too narrow to show them (under 380 px). Items carry their
 * keycaps on the right, after OKX's menus: https://mobbin.com/screens/a2bb80c5-27d1-4a5e-a87e-7c852a2d38f3
 */
export function ColumnMenu({ column, paused, presetsInMenu }: { column: PulseColumnId; paused: boolean; presetsInMenu: boolean }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const sound = useSettings((s) => s.columns[column].sound);
  const preset = useSettings((s) => s.columns[column].preset ?? s.activePreset);
  const setColumn = useSettings((s) => s.setColumn);
  const legend = useSettings((s) => s.pulseLayout.legend);
  const hidden = useSettings((s) => s.pulseLayout.hidden);
  const setPulseLayout = useSettings((s) => s.setPulseLayout);
  const pauseKey = useSettings((s) => s.hotkeys["pulse.pause"]?.[0]);
  const filtersKey = useSettings((s) => s.hotkeys["pulse.filters"]?.[0]);
  const sort = usePulseUi((s) => s.sort[column]);
  const ui = usePulseUi.getState;
  const run = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  const title = COLUMN_TITLE[column];

  return (
    <>
      <IconButton ref={anchor} label={`${title} options`} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Ellipsis />
      </IconButton>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} align="end" width={232}>
        <div role="menu" aria-label={`${title} options`}>
          <MenuItem
            icon={paused ? <Play /> : <Pause />}
            hint={<Hotkey binding={pauseKey} />}
            onSelect={run(() => ui().togglePause(column))}
          >
            {paused ? "Resume column" : "Pause column"}
          </MenuItem>
          <MenuItem icon={<SlidersHorizontal />} hint={<Hotkey binding={filtersKey} />} onSelect={run(() => ui().openFilters(column))}>
            Filters
          </MenuItem>
          <MenuItem checked={sound} icon={checkIcon(sound)} onSelect={run(() => setColumn(column, { sound: !sound }))}>
            Sound for new tokens
          </MenuItem>
          <MenuItem checked={legend} icon={checkIcon(legend)} onSelect={run(() => setPulseLayout({ legend: !legend }))}>
            Show risk legend
          </MenuItem>
          <MenuSeparator />
          <MenuGroupLabel>Sort</MenuGroupLabel>
          {SORT_KEYS.map((key) => (
            <MenuItem key={key} checked={sort === key} icon={checkIcon(sort === key)} onSelect={run(() => ui().setSort(column, key))}>
              {key === "default" ? DEFAULT_SORT_LABEL[column] : SORT_LABEL[key]}
            </MenuItem>
          ))}
          {presetsInMenu && (
            <>
              <MenuSeparator />
              <MenuGroupLabel>Preset</MenuGroupLabel>
              {PRESET_IDS.map((p) => (
                <MenuItem
                  key={p}
                  checked={preset === p}
                  icon={checkIcon(preset === p)}
                  onSelect={run(() => setColumn(column, { preset: p }))}
                >
                  {p}
                </MenuItem>
              ))}
            </>
          )}
          <MenuSeparator />
          <MenuItem icon={<EyeOff />} onSelect={run(() => setPulseLayout({ hidden: [...hidden.filter((c) => c !== column), column] }))}>
            Hide column
          </MenuItem>
        </div>
      </Popover>
    </>
  );
}
