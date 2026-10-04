import { Activity, Camera, ChartCandlestick, ChartLine, Check, ChevronDown, MapPin, Maximize2, Minimize2 } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { IconButton } from "../../../components/ui/Button";
import { Segmented } from "../../../components/ui/controls";
import { MenuItem, MenuSeparator, Popover } from "../../../components/ui/Popover";
import { cn } from "../../../lib/cn";
import { compactLabel } from "../../../lib/hotkeys";
import { TIMEFRAMES, type Timeframe } from "../../../protocol";
import { type QuoteCurrency, useSettings } from "../../../state/settings";
import { type ChartMode, type ChartType, MARKER_LABEL, type MarkerKey, useTokenUi } from "../tokenUi";

/*
 * Chart toolbar (DESIGN.md 4.10): 32 px, timeframes, chart type, indicators on the left; MC |
 * Price, the global USD | SOL quote, markers, screenshot and maximize on the right. Toolbar and
 * chart-type menu after Coinbase Advanced https://mobbin.com/screens/4ed27744-549c-4cb7-894f-e2bc1f04c623;
 * the markers menu after Binance's chart settings https://mobbin.com/screens/9ee1d184-7edd-4bb9-9250-bd49a1a53a53
 */

const TYPE_LABEL: Record<ChartType, string> = { candles: "Candles", bars: "Bars", line: "Line" };
const MARKER_ORDER: MarkerKey[] = ["you", "dev", "tracked", "snipers", "avgLines", "orderLines", "migration", "candleClick"];

function MenuButton({
  label,
  icon,
  children,
  wide = false,
}: {
  label: string;
  icon: ReactNode;
  children: (close: () => void) => ReactNode;
  wide?: boolean;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex h-6 shrink-0 items-center gap-1 rounded-sm px-1.5 text-data font-medium text-fg-2 transition-colors hover:bg-surface-3 hover:text-fg-1",
          open && "bg-surface-3 text-fg-1",
        )}
      >
        <span className="flex [&_svg]:size-3.5">{icon}</span>
        <span className="hidden @min-[640px]:inline">{label}</span>
        <ChevronDown className="icon-xs" />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} width={wide ? 248 : 200}>
        <div role="menu" aria-label={label}>
          {children(() => setOpen(false))}
        </div>
      </Popover>
    </>
  );
}

export function ChartToolbar({
  onScreenshot,
  maximized,
  onMaximize,
}: {
  onScreenshot: () => Promise<boolean>;
  maximized: boolean;
  onMaximize: (on: boolean) => void;
}) {
  const tf = useTokenUi((s) => s.tf);
  const setTf = useTokenUi((s) => s.setTf);
  const mode = useTokenUi((s) => s.mode);
  const setMode = useTokenUi((s) => s.setMode);
  const chartType = useTokenUi((s) => s.chartType);
  const setChartType = useTokenUi((s) => s.setChartType);
  const volume = useTokenUi((s) => s.volume);
  const setVolume = useTokenUi((s) => s.setVolume);
  const ma = useTokenUi((s) => s.movingAverage);
  const setMa = useTokenUi((s) => s.setMovingAverage);
  const markers = useTokenUi((s) => s.markers);
  const toggleMarker = useTokenUi((s) => s.toggleMarker);
  const quote = useSettings((s) => s.display.quote);
  const setDisplay = useSettings((s) => s.setDisplay);
  const keys = useSettings((s) => s.hotkeys);
  const [shot, setShot] = useState(false);

  useEffect(() => {
    if (!shot) return;
    const t = setTimeout(() => setShot(false), 1200);
    return () => clearTimeout(t);
  }, [shot]);

  const tfHint = `${compactLabel(keys["token.prevTf"]?.[0])} and ${compactLabel(keys["token.nextTf"]?.[0])} step`;

  return (
    <div className="@container flex h-8 shrink-0 items-center gap-2 border-b border-hairline bg-surface-1 px-2">
      <Segmented<Timeframe>
        size="sm"
        value={tf}
        onChange={setTf}
        options={TIMEFRAMES.map((t) => ({ value: t, label: t, title: `${t} candles (${tfHint})` }))}
        label="Timeframe"
      />
      <MenuButton label={TYPE_LABEL[chartType]} icon={chartType === "line" ? <ChartLine /> : <ChartCandlestick />}>
        {(close) =>
          (["candles", "bars", "line"] as const).map((t) => (
            <MenuItem
              key={t}
              checked={chartType === t}
              icon={chartType === t ? <Check /> : <span className="size-3.5" />}
              onSelect={() => {
                setChartType(t);
                close();
              }}
            >
              {TYPE_LABEL[t]}
            </MenuItem>
          ))
        }
      </MenuButton>
      <MenuButton label="Indicators" icon={<Activity />}>
        {() => (
          <>
            <MenuItem checked={volume} icon={volume ? <Check /> : <span className="size-3.5" />} onSelect={() => setVolume(!volume)}>
              Volume
            </MenuItem>
            <MenuItem checked={ma} icon={ma ? <Check /> : <span className="size-3.5" />} onSelect={() => setMa(!ma)}>
              Moving average (20)
            </MenuItem>
          </>
        )}
      </MenuButton>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <Segmented<ChartMode>
          size="xs"
          value={mode}
          onChange={setMode}
          options={[
            { value: "mc", label: "MC", title: `Market cap (${compactLabel(keys["token.toggleMc"]?.[0])})` },
            { value: "price", label: "Price", title: `Price (${compactLabel(keys["token.toggleMc"]?.[0])})` },
          ]}
          label="Chart value"
        />
        <Segmented<QuoteCurrency>
          size="xs"
          value={quote}
          onChange={(q) => setDisplay({ quote: q })}
          options={[
            { value: "USD", label: "USD", title: `USD (${compactLabel(keys["quote.toggle"]?.[0])})` },
            { value: "SOL", label: "SOL", title: `SOL (${compactLabel(keys["quote.toggle"]?.[0])})` },
          ]}
          label="Quote currency"
        />
        <MenuButton label="Markers" icon={<MapPin />} wide>
          {() =>
            MARKER_ORDER.map((k, i) => (
              <span key={k}>
                {i === 4 && <MenuSeparator />}
                {i === 7 && <MenuSeparator />}
                <MenuItem
                  checked={markers[k]}
                  icon={markers[k] ? <Check /> : <span className="size-3.5" />}
                  onSelect={() => toggleMarker(k)}
                >
                  {MARKER_LABEL[k]}
                </MenuItem>
              </span>
            ))
          }
        </MenuButton>
        <IconButton label={shot ? "Copied" : "Copy chart image"} onClick={() => void onScreenshot().then((ok) => setShot(ok))}>
          {shot ? <Check /> : <Camera />}
        </IconButton>
        <IconButton label={maximized ? "Restore chart (Esc)" : "Maximize chart"} active={maximized} onClick={() => onMaximize(!maximized)}>
          {maximized ? <Minimize2 /> : <Maximize2 />}
        </IconButton>
      </div>
    </div>
  );
}
