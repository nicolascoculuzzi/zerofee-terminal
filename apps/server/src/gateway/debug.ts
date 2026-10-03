/**
 * GET /debug - a plain HTML page on the same WebSocket: live launches, migrations and trades with
 * detection latency (receive time - block time; block time has 1 s resolution), ingest counters, and
 * the Pulse "new" column. Uses the server-internal `debug` topic (not part of @zerofee/protocol).
 * No external scripts, styles or fonts.
 */

export const DEBUG_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>zerofee feed debug</title>
<style>
  :root { --bg:#0e1116; --fg:#d7dde5; --dim:#7d8794; --line:#222a33; --buy:#3fb950; --sell:#f85149; --warn:#d29922; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace; }
  header { padding:10px 14px; border-bottom:1px solid var(--line); display:flex; gap:18px; flex-wrap:wrap; align-items:baseline; }
  header b { font-size:13px; }
  .stat { color:var(--dim); } .stat span { color:var(--fg); }
  main { display:grid; grid-template-columns: 1fr 1fr 1fr; gap:0; min-height: calc(100vh - 42px); }
  section { border-right:1px solid var(--line); overflow:hidden; display:flex; flex-direction:column; min-width:0; }
  section h2 { margin:0; padding:8px 12px; font-size:12px; color:var(--dim); border-bottom:1px solid var(--line); font-weight:normal; }
  .rows { overflow-y:auto; flex:1; }
  .row { padding:3px 12px; border-bottom:1px solid #161c23; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .buy { color:var(--buy); } .sell { color:var(--sell); } .dim { color:var(--dim); } .warn { color:var(--warn); }
  .lat { display:inline-block; min-width:62px; text-align:right; }
  a { color:inherit; }
  @media (max-width: 900px) { main { grid-template-columns: 1fr; } section { max-height: 50vh; } }
</style>
</head>
<body>
<header>
  <b>zerofee feed</b>
  <span class="stat">ws <span id="ws">connecting</span></span>
  <span class="stat">source <span id="src">-</span></span>
  <span class="stat">launches <span id="launches">0</span></span>
  <span class="stat">migrations <span id="migrations">0</span></span>
  <span class="stat">trades/s <span id="tps">0</span></span>
  <span class="stat">decode failures <span id="fails">0</span></span>
  <span class="stat">reconnects <span id="recon">0</span></span>
  <span class="stat">latency p50/p90 <span id="lat">-</span></span>
  <span class="stat">launch p50/p90 <span id="llat">-</span></span>
  <span class="stat">slot <span id="slot">-</span></span>
  <span class="stat">SOL <span id="sol">-</span></span>
</header>
<main>
  <section><h2>launches + migrations (latency = received - block time)</h2><div class="rows" id="launchRows"></div></section>
  <section><h2>trades (sampled)</h2><div class="rows" id="tradeRows"></div></section>
  <section><h2>pulse: new</h2><div class="rows" id="pulseRows"></div></section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (m) => m ? m.slice(0, 4) + ".." + m.slice(-4) : "";
const t = (ms) => new Date(ms).toLocaleTimeString();
const fmt = (n, d = 2) => (n == null || Number.isNaN(n)) ? "-" : Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
const pulse = new Map();
function addRow(el, html, max) {
  const div = document.createElement("div");
  div.className = "row";
  div.innerHTML = html;
  el.prepend(div);
  while (el.children.length > max) el.lastChild.remove();
}
function feed(items) {
  for (const it of items) {
    const lat = '<span class="lat ' + (it.latencyMs > 3000 ? "warn" : "dim") + '">' + fmt(it.latencyMs, 0) + " ms</span>";
    if (it.kind === "launch" || it.kind === "migration" || it.kind === "complete") {
      const tag = it.kind === "launch" ? "NEW " : it.kind === "migration" ? "MIGR" : "DONE";
      addRow($("launchRows"), lat + " " + t(it.blockTime) + " " + tag + " <b>" + esc(it.symbol || "?") + "</b> " + esc(it.name) + ' <span class="dim">' + short(it.mint) + "</span>", 300);
    } else {
      addRow($("tradeRows"), lat + " " + t(it.blockTime) + ' <span class="' + it.side + '">' + it.side.padEnd(4) + "</span> " + fmt(it.amountSol, 3) + " SOL <b>" + esc(it.symbol || short(it.mint)) + '</b> <span class="dim">' + it.venue + "</span>", 300);
    }
  }
}
function stats(s) {
  if (!s) return;
  $("src").textContent = s.source;
  $("launches").textContent = s.launches;
  $("migrations").textContent = s.migrations;
  $("tps").textContent = fmt(s.tradesPerSec, 1);
  $("fails").textContent = s.decodeFailures;
  $("recon").textContent = s.reconnects;
  $("lat").textContent = s.latency.p50 == null ? "-" : fmt(s.latency.p50, 0) + " / " + fmt(s.latency.p90, 0) + " ms";
  $("llat").textContent = s.launchLatency.p50 == null ? "-" : fmt(s.launchLatency.p50, 0) + " / " + fmt(s.launchLatency.p90, 0) + " ms";
}
function renderPulse() {
  const rows = [...pulse.values()].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, 100);
  $("pulseRows").innerHTML = rows.map((s) => '<div class="row">' + t(s.createdAt) + " <b>" + esc(s.symbol || "?") + "</b> " + fmt(s.mcSol, 1) + " SOL mc, " + fmt(s.bondingProgressBps / 100, 1) + "% " + (s.holders ?? "-") + " holders, top10 " + fmt(s.top10Pct, 1) + '% <span class="dim">' + short(s.mint) + "</span></div>").join("");
}
function connect() {
  const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
  ws.onopen = () => {
    $("ws").textContent = "open";
    for (const topic of ["debug", "pulse:new", "chain"]) ws.send(JSON.stringify({ type: "subscribe", topic }));
  };
  ws.onclose = () => { $("ws").textContent = "closed - retrying"; setTimeout(connect, 2000); };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.topic === "debug") {
      if (m.type === "snapshot") { feed(m.data.recent); stats(m.data.stats); }
      else { feed(m.data.feed); stats(m.data.stats); }
    } else if (m.topic === "pulse:new") {
      if (m.type === "snapshot") { pulse.clear(); for (const s of m.data.tokens) pulse.set(s.mint, s); }
      else {
        for (const p of m.data.upsert) pulse.set(p.mint, Object.assign(pulse.get(p.mint) || {}, p));
        for (const mint of m.data.remove) pulse.delete(mint);
      }
      renderPulse();
    } else if (m.topic === "chain") {
      const c = m.data;
      if (c.slot != null) $("slot").textContent = c.slot;
      if (c.solUsd) $("sol").textContent = "$" + fmt(c.solUsd.price, 2) + (c.solUsd.stale ? " (stale)" : "");
    }
  };
}
connect();
</script>
</body>
</html>`;
