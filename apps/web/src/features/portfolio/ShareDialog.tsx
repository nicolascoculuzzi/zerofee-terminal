import { Check, Copy, Download } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Hotkey, Segmented, Switch } from "../../components/ui/controls";
import { Modal } from "../../components/ui/Modal";
import { Tooltip } from "../../components/ui/Tooltip";
import { copyText } from "../../lib/clipboard";
import { cn } from "../../lib/cn";
import { IS_MAC } from "../../lib/hotkeys";
import type { ActivityItem, Position } from "../../protocol";
import { getServices } from "../../services";
import { useMarket } from "../../state/market";
import { useSettings } from "../../state/settings";
import { cardSize, drawShareCard, loadCardFonts, type ShareFormat, type ShareMetric, type ShareTemplate } from "./shareCard";
import { buildShareData } from "./shareData";

function Row({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-3 border-b border-hairline py-1.5 last:border-b-0">
      <span className="min-w-0">
        <span className="block text-data text-fg-1">{label}</span>
        {help && <span className="block text-label text-fg-3">{help}</span>}
      </span>
      {children}
    </div>
  );
}

type Flash = "copied" | "copyFailed" | "posted" | null;

/*
 * PnL share dialog (DESIGN.md 4.21): 880 px, the card preview on the left (fit to 520 px),
 * controls on the right (320 px). Card on the left with share options on the right after OKX:
 * https://mobbin.com/flows/da0213e4-f24e-49db-8b9f-b0db144267b3
 * $ / % toggle and template switching after Public: https://mobbin.com/screens/5be7661b-2f1b-4af1-98ca-abe4cf3edb63
 * Copy image / Download image and a show/hide toggle after Perplexity:
 * https://mobbin.com/screens/bf6f870b-1e78-404c-944b-0769c8ee0606
 */
export function ShareDialog({
  position,
  activity,
  walletLabel,
  onClose,
}: {
  position: Position;
  activity: readonly ActivityItem[];
  walletLabel: string | null;
  onClose: () => void;
}) {
  const supply = useMarket((s) => s.tokens[position.mint]?.supply ?? null);
  const liveMcUsd = useMarket((s) => s.tokens[position.mint]?.marketCapUsd ?? null);
  const solUsd = useMarket((s) => s.solUsd);
  const blueOrange = useSettings((s) => s.display.cvd === "blue-orange");
  // A snapshot: the numbers freeze when the dialog opens, and the card carries that timestamp.
  const [data] = useState(() => buildShareData({ position, activity, supply, liveMcUsd, solUsd, now: Date.now(), walletLabel }));
  const [metric, setMetric] = useState<ShareMetric>(data.pct !== null ? "pct" : "sol");
  const [template, setTemplate] = useState<ShareTemplate>("dark");
  const [format, setFormat] = useState<ShareFormat>("landscape");
  const [chart, setChart] = useState(true);
  const [amounts, setAmounts] = useState(true);
  const [showWallet, setShowWallet] = useState(false);
  const [fontsReady, setFontsReady] = useState(false);
  const [flash, setFlash] = useState<Flash>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simulated = getServices().simulated;
  const canChart = data.path.filter((q) => q.v > 0).length >= 2;

  useEffect(() => {
    let alive = true;
    void loadCardFonts().then(() => {
      if (alive) setFontsReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1200);
    return () => clearTimeout(t);
  }, [flash]);

  useEffect(() => {
    // Draws once with whatever font is ready, and again when Plex has loaded.
    void fontsReady;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { w, h } = cardSize(format);
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    drawShareCard(ctx, data, { metric, template, chart: chart && canChart, amounts, walletLabel: showWallet, format, blueOrange });
  }, [data, metric, template, chart, canChart, amounts, showWallet, format, blueOrange, fontsReady]);

  const toBlob = useCallback(
    () => new Promise<Blob | null>((resolve) => (canvasRef.current ? canvasRef.current.toBlob(resolve, "image/png") : resolve(null))),
    [],
  );

  const copyImage = useCallback(async () => {
    try {
      const blob = await toBlob();
      if (!blob || typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) throw new Error("Clipboard images unsupported");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      setFlash("copied");
    } catch {
      setFlash("copyFailed");
    }
  }, [toBlob]);

  const download = async () => {
    const blob = await toBlob();
    if (!blob) return;
    // A local Blob URL; nothing is uploaded.
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `zerofee-${data.symbol}-pnl.png`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const postText = `$${data.symbol} ${amounts ? (data.pct ?? data.sol) : (data.pct ?? "")} on zerofee · 0% platform fee`
    .replace(/\s+/g, " ")
    .trim();
  const post = () => {
    if (simulated) {
      // Simulated data: no network calls from the app, so the post text goes to the clipboard.
      void copyText(postText).then((ok) => setFlash(ok ? "posted" : "copyFailed"));
      return;
    }
    window.open(`https://x.com/intent/post?text=${encodeURIComponent(postText)}`, "_blank", "noopener,noreferrer");
  };

  // Cmd/Ctrl+C copies the image while the dialog is open (unless text is selected).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = IS_MAC ? e.metaKey : e.ctrlKey;
      if (!mod || e.key.toLowerCase() !== "c" || e.shiftKey || e.altKey) return;
      if (window.getSelection()?.toString()) return;
      e.preventDefault();
      void copyImage();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [copyImage]);

  const metricOptions: { value: ShareMetric; label: string }[] = [
    { value: "pct", label: "%" },
    { value: "sol", label: "SOL" },
    { value: "usd", label: "USD" },
  ];
  const portrait = format === "portrait";

  return (
    <Modal
      open
      onClose={onClose}
      width={880}
      title={`Share $${data.symbol} PnL`}
      description={`Snapshot at ${data.stamp}`}
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Tooltip content={simulated ? "Simulated data: copies the post text instead of opening X" : "Opens X with the text filled in"}>
            <Button variant="secondary" size="md" onClick={post}>
              {flash === "posted" ? "Post text copied" : "Post to X"}
            </Button>
          </Tooltip>
          <Button variant="secondary" size="md" icon={<Download />} onClick={() => void download()}>
            Download PNG
          </Button>
          <Tooltip
            content={
              <span className="inline-flex items-center gap-2">
                Copy image <Hotkey binding="Mod+C" />
              </span>
            }
          >
            <Button
              variant="primary"
              size="md"
              icon={flash === "copied" ? <Check /> : <Copy />}
              aria-label={flash === "copied" ? "Copied" : "Copy image"}
              onClick={() => void copyImage()}
            >
              {flash === "copied" ? "Copied" : flash === "copyFailed" ? "Couldn't copy" : "Copy image"}
            </Button>
          </Tooltip>
        </div>
      }
    >
      <div className="grid gap-4 md:grid-cols-[520px_minmax(0,1fr)]">
        <div className="flex h-[292px] items-center justify-center md:h-[468px]">
          <canvas
            ref={canvasRef}
            role="img"
            aria-label={`PnL card for $${data.symbol}: ${data.pct ?? data.sol}`}
            className={cn("rounded-lg border border-hairline", portrait ? "h-full w-auto max-w-full" : "h-auto max-h-full w-full")}
          />
        </div>
        <div className="flex min-w-0 flex-col">
          <Row label="Primary metric">
            <Segmented<ShareMetric>
              value={amounts ? metric : "pct"}
              onChange={setMetric}
              size="sm"
              label="Primary metric"
              options={metricOptions.map((o) => ({
                ...o,
                label: o.label,
                title: !amounts && o.value !== "pct" ? "Turn on Show amounts to use this" : undefined,
              }))}
            />
          </Row>
          <Row label="Template">
            <Segmented<ShareTemplate>
              value={template}
              onChange={setTemplate}
              size="sm"
              label="Template"
              options={[
                { value: "dark", label: "Dark" },
                { value: "light", label: "Light" },
                { value: "mono", label: "Mono" },
              ]}
            />
          </Row>
          <Row label="Format">
            <Segmented<ShareFormat>
              value={format}
              onChange={setFormat}
              size="sm"
              label="Format"
              options={[
                { value: "landscape", label: "Landscape" },
                { value: "portrait", label: "Portrait" },
              ]}
            />
          </Row>
          <Row label="Include chart" help={canChart ? "Market cap at each of your fills" : "Needs at least two fills with a market cap"}>
            <Switch checked={chart && canChart} onChange={setChart} label="Include chart" disabled={!canChart} />
          </Row>
          <Row label="Show amounts" help="Off shows the % only">
            <Switch checked={amounts} onChange={setAmounts} label="Show amounts" />
          </Row>
          <Row label="Show wallet label" help={walletLabel ? `Adds "${walletLabel}" to the footer` : "This wallet has no label"}>
            <Switch checked={showWallet} onChange={setShowWallet} label="Show wallet label" disabled={!walletLabel} />
          </Row>
          <p className="mt-3 text-label text-fg-3">
            Values are this position's fills at {data.stamp}. Press <span className="font-mono">{IS_MAC ? "Cmd" : "Ctrl"}+C</span> to copy
            the image.
          </p>
        </div>
      </div>
    </Modal>
  );
}
