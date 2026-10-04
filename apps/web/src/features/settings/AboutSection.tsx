import { ArrowUpRight } from "lucide-react";
import oflText from "../../../licenses/OFL-IBM-Plex.txt?raw";
import notice from "../../../NOTICE?raw";
import { Logo } from "../../app/Logo";
import { getServices } from "../../services";
import { Block, Row, Rows, SectionHeader, SubHeader, Tag } from "./ui";

/** Keep in step with apps/web/package.json. */
const APP_VERSION = "0.1.0";

/** Required attribution for TradingView Lightweight Charts (apps/web/NOTICE). Keep verbatim. */
const CHART_ATTRIBUTION = "Charts by TradingView Lightweight Charts™, Copyright (c) 2026 TradingView, Inc.";

/** VITE_BUILD_HASH, set at build time to the short git SHA (see src/env.d.ts). */
const BUILD: string = import.meta.env.VITE_BUILD_HASH || (import.meta.env.DEV ? "development" : "unversioned");

function LicenceText({ summary, text }: { summary: string; text: string }) {
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-label text-fg-2 hover:text-fg-1">{summary}</summary>
      <pre className="mt-2 max-h-64 overflow-auto rounded-sm bg-surface-2 p-3 font-mono text-label whitespace-pre-wrap text-fg-2">
        {text}
      </pre>
    </details>
  );
}

/*
 * About (DESIGN.md 5.5): version, build, platform fee, and the licences from apps/web/NOTICE,
 * including the Lightweight Charts attribution with its link and the IBM Plex OFL text.
 * Label-left / value-right rows after Buffer: https://mobbin.com/screens/8f4e0968-f06d-4fef-a1f1-f714b1f5c5e7
 */
export function AboutSection() {
  const simulated = getServices().simulated;
  return (
    <>
      <SectionHeader title="About" />
      <Rows>
        <Row label={<Logo />} help="A Solana memecoin trading terminal with zero platform fees. You keep your keys." />
        <Row label="Version">
          <span className="zf-num text-data text-fg-1">{APP_VERSION}</span>
        </Row>
        <Row label="Build" help="The commit this bundle was built from.">
          <span className="font-mono text-data text-fg-2">{BUILD}</span>
        </Row>
        <Row label="Platform fee" help="You pay only what the chain charges: venue fees, network fees, tips and refundable rent.">
          <span className="zf-num text-data font-semibold text-fg-1">0</span>
        </Row>
        {simulated && (
          <Row
            label="Data"
            help="Tokens, trades, wallets, balances and fills are simulated in this browser. The app makes no network calls and no real funds move."
          >
            <Tag tone="warn">Simulated data</Tag>
          </Row>
        )}
      </Rows>

      <SubHeader>Licences</SubHeader>
      <Rows>
        <Block>
          <div className="text-data font-medium text-fg-1">TradingView Lightweight Charts</div>
          <p className="mt-0.5 text-label text-fg-2">{CHART_ATTRIBUTION}</p>
          <p className="text-label text-fg-3">
            Apache License 2.0. Every chart keeps the library's attribution link.{" "}
            <a
              href="https://www.tradingview.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 font-medium text-fg-1 underline-offset-2 hover:underline"
            >
              tradingview.com
              <ArrowUpRight className="icon-xs" />
            </a>
          </p>
        </Block>
        <Block>
          <div className="text-data font-medium text-fg-1">IBM Plex Sans and IBM Plex Mono</div>
          <p className="mt-0.5 text-label text-fg-2">Copyright 2017–2019 IBM Corp. SIL Open Font License 1.1, shipped unmodified.</p>
          <LicenceText summary="Full licence text" text={oflText} />
        </Block>
        <Block>
          <div className="text-data font-medium text-fg-1">NOTICE</div>
          <p className="mt-0.5 text-label text-fg-2">Every third-party notice this app ships with.</p>
          <LicenceText summary="Show the NOTICE file" text={notice} />
        </Block>
      </Rows>
    </>
  );
}
