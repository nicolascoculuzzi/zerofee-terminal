import { ExternalLink } from "lucide-react";
import { Logo } from "../../app/Logo";
import { getServices } from "../../services";
import { Group, Row, TabHeader } from "./ui";

const APP_VERSION = "0.1.0";

/** Required attribution for TradingView Lightweight Charts (apps/web/NOTICE). Keep verbatim. */
const CHART_ATTRIBUTION = "Charts by TradingView Lightweight Charts™, Copyright (c) 2026 TradingView, Inc.";

/* About rows follow Graphite's preferences anatomy (label left, value right, hairlines):
   https://mobbin.com/screens/102736c8-9a2a-4185-a155-025f1c0b3217 */
export function AboutTab() {
  const simulated = getServices().simulated;
  return (
    <>
      <TabHeader title="About" />

      <Group>
        <Row label={<Logo />} hint="A Solana memecoin trading terminal with zero platform fees. You keep your keys.">
          <span className="font-mono text-data text-fg-2">v{APP_VERSION}</span>
        </Row>
        <Row label="Platform fee" hint="You pay only what the chain charges: venue fees, network fees and tips, and refundable rent.">
          <span className="font-mono text-data font-semibold text-fg-1">0%</span>
        </Row>
      </Group>

      {simulated && (
        <Group title="Simulated data">
          <div className="space-y-1 px-3 py-2 text-data text-fg-2">
            <p>
              Everything you see runs on a simulation inside your browser: tokens, trades, wallets, balances and fills. The app makes no
              network calls, no transaction is ever signed or sent, and no real funds move.
            </p>
            <p className="text-label text-fg-3">
              The live version replaces the simulation with the zerofee gateway, the trade engine and the isolated signer.
            </p>
          </div>
        </Group>
      )}

      <Group title="Charts">
        <div className="space-y-2 px-3 py-2 text-data">
          <p className="text-fg-1">{CHART_ATTRIBUTION}</p>
          <a
            href="https://www.tradingview.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-fg-1 underline underline-offset-2 hover:text-fg-2"
          >
            https://www.tradingview.com/
            <ExternalLink className="icon-sm" />
          </a>
          <p className="text-label text-fg-2">Lightweight Charts is licensed under Apache-2.0. See the NOTICE file in apps/web.</p>
          <p className="text-label text-fg-2">TradingView Advanced Charts is not used.</p>
        </div>
      </Group>
    </>
  );
}
