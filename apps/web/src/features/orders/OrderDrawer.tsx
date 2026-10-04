import { Check, Loader2, RotateCw } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { Age } from "../../components/ui/Age";
import { Button } from "../../components/ui/Button";
import { CopyButton } from "../../components/ui/controls";
import { Drawer } from "../../components/ui/Modal";
import { Num } from "../../components/ui/Num";
import { TokenAvatar } from "../../components/ui/TokenAvatar";
import { cn } from "../../lib/cn";
import { fmtClock, fmtDate, fmtFee, fmtInt, fmtMs, fmtSol, fmtTokens, shortAddr } from "../../lib/format";
import { LANDING_INFO } from "../../lib/landing";
import type { Order, OrderEvent } from "../../protocol";
import { useMarket } from "../../state/market";
import { isOpenOrder } from "../../state/orders";
import { MarketCap } from "../portfolio/quote";
import { useOrderQuotes } from "./liveQuotes";
import { DistanceCell, StatusCell, TriggerLabel, useLiveToken } from "./OrderCells";
import { canCancel, canRearm, KIND_NAME, nonceInfo, sizeText } from "./orderText";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="zf-label">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-h-7 grid-cols-[7rem_minmax(0,1fr)] items-baseline gap-3 border-b border-hairline py-1.5 last:border-b-0">
      <dt className="text-label text-fg-3">{label}</dt>
      <dd className="min-w-0 text-data text-fg-1">{children}</dd>
    </div>
  );
}

function when(ms: number): string {
  const today = new Date().toDateString() === new Date(ms).toDateString();
  return today ? fmtClock(ms) : `${fmtDate(ms)} ${fmtClock(ms)}`;
}

const EVENT_TEXT: Record<string, { label: string; dot: string }> = {
  armed: { label: "Armed", dot: "bg-info" },
  rearmed: { label: "Re-armed with fresh signatures", dot: "bg-info" },
  triggered: { label: "Trigger hit", dot: "bg-warn" },
  attempt: { label: "Attempt sent", dot: "bg-warn" },
  submitted: { label: "Sending", dot: "bg-warn" },
  filled: { label: "Filled", dot: "bg-fg-1" },
  failed: { label: "Attempt failed · nonce consumed", dot: "bg-sell" },
  stale: { label: "Needs re-arm", dot: "bg-warn" },
  cancelled: { label: "Cancelled · nonce advanced", dot: "bg-fg-4" },
};

function eventText(e: OrderEvent): { label: string; dot: string } {
  return EVENT_TEXT[e.kind] ?? { label: e.kind, dot: "bg-fg-3" };
}

/** Live "price checks" step for an open order: the server checks the trigger on every trade. */
function PriceChecks({ order }: { order: Order }) {
  const feedTrade = useMarket((s) => (order.mint ? (s.tokens[order.mint]?.lastTradeAt ?? null) : null));
  const quoteTrade = useOrderQuotes((s) => (order.mint ? (s.byMint[order.mint]?.lastTradeAt ?? null) : null));
  const lastTrade = feedTrade ?? quoteTrade;
  const { mcUsd, supply, priceSol } = useLiveToken(order.mint);
  if (!order.mint) {
    return (
      <span className="block text-label text-fg-3">
        Waiting for the leader's next buy; this browser builds and signs the copy when it lands.
      </span>
    );
  }
  const mcSol = priceSol !== null && supply !== null ? priceSol * supply : null;
  return (
    <span className="block text-label text-fg-3">
      Checked on every trade
      {lastTrade !== null && (
        <>
          {" "}
          · last <Age ts={lastTrade} className="text-fg-3" /> ago
        </>
      )}
      {mcSol !== null && (
        <>
          {" "}
          · now <MarketCap sol={mcSol} usd={mcUsd} className="text-fg-2" /> · <DistanceCell order={order} /> to trigger
        </>
      )}
    </span>
  );
}

/*
 * Order timeline (DESIGN.md 4.20: armed, price checks, attempts with slot, result). Times in a
 * left column after incident.io's timeline: https://mobbin.com/screens/0b441174-3405-416f-a142-dfbb383d21f9
 * Compact dot-and-line steps inside a details drawer after Revolut Business:
 * https://mobbin.com/screens/5cfe0e55-f260-4f13-98e4-e24e732c99a0
 */
function Timeline({ order }: { order: Order }) {
  const open = isOpenOrder(order);
  const steps = [...order.events].sort((a, b) => a.at - b.at);
  return (
    <ol aria-label="Order timeline" className="flex flex-col">
      {steps.map((e, i) => {
        const t = eventText(e);
        const last = i === steps.length - 1 && !open;
        const landed = e.kind === "filled" ? order.fillLatencyMs : null;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: events are append-only
          <li key={`${e.kind}-${e.at}-${i}`} className="grid grid-cols-[4.5rem_0.75rem_minmax(0,1fr)] gap-2">
            <span className="zf-num pt-px text-label text-fg-3">{when(e.at)}</span>
            <span className="relative flex justify-center pt-1.5">
              <span aria-hidden="true" className={cn("relative z-10 size-1.5 rounded-full", t.dot)} />
              {!last && <span aria-hidden="true" className="absolute top-3 -bottom-1.5 w-px bg-hairline" />}
            </span>
            <span className="pb-3">
              <span className="block text-data text-fg-1">
                {t.label}
                {landed !== null && <span className="zf-num text-fg-2"> in {fmtMs(landed)}</span>}
              </span>
              {e.reason && <span className="block text-label text-fg-2">{e.reason}</span>}
              {e.slot !== null && <span className="zf-num block text-label text-fg-3">Slot {fmtInt(e.slot)}</span>}
            </span>
          </li>
        );
      })}
      {open && (
        <li className="grid grid-cols-[4.5rem_0.75rem_minmax(0,1fr)] gap-2">
          <span className="pt-px text-label text-fg-3">Now</span>
          <span className="flex justify-center pt-1.5">
            <span aria-hidden="true" className="size-1.5 rounded-full border border-fg-3" />
          </span>
          <span className="pb-1">
            <span className="block text-data text-fg-1">{order.mint ? "Price checks" : "Watching the leader"}</span>
            <PriceChecks order={order} />
          </span>
        </li>
      )}
    </ol>
  );
}

function cancelStatus(order: Order, n: ReturnType<typeof nonceInfo>): { label: string; detail: string; ready: boolean } {
  if (order.status === "cancelled")
    return { label: "Fired", detail: "The nonce advanced, so the signed transactions can never land.", ready: false };
  if (order.status === "filled") return { label: "Not needed", detail: "The fill advanced the nonce.", ready: false };
  if (order.status === "failed")
    return { label: "Not needed", detail: "The failed attempt consumed the nonce. Re-arm signs a new one.", ready: false };
  if (n.text === "None") return { label: "Not needed", detail: "Nothing is pre-signed until the order fires.", ready: false };
  return {
    label: "Ready",
    detail: n.shared
      ? "Stored with the server. Firing it advances the shared nonce and stops both legs."
      : "Stored with the server. Firing it advances the nonce, so this order can never land.",
    ready: true,
  };
}

/*
 * Row detail drawer (DESIGN.md 4.20, 4.17): 560 px from the right; order details, the min-out
 * grid, the nonce account, the pre-signed cancel, and the timeline, with the SPEC rule in plain
 * text. Details drawer over the list after DoorDash: https://mobbin.com/screens/147163b2-eef8-40be-b199-dae113a33d9c
 */
export function OrderDrawer({
  order,
  label,
  rearming,
  onClose,
  onCancel,
  onRearm,
}: {
  order: Order | null;
  label: string;
  rearming: boolean;
  onClose: () => void;
  onCancel: (order: Order) => void;
  onRearm: (order: Order) => void;
}) {
  return (
    <Drawer open={order !== null} onClose={onClose} width={560} title={order ? `${label} · ${order.symbol}` : "Order"}>
      {order && <DrawerBody order={order} rearming={rearming} onCancel={onCancel} onRearm={onRearm} />}
    </Drawer>
  );
}

function DrawerBody({
  order,
  rearming,
  onCancel,
  onRearm,
}: {
  order: Order;
  rearming: boolean;
  onCancel: (order: Order) => void;
  onRearm: (order: Order) => void;
}) {
  const live = useLiveToken(order.mint);
  const nonce = nonceInfo(order);
  const cancel = cancelStatus(order, nonce);
  const open = isOpenOrder(order);
  const landing = LANDING_INFO[order.landing];
  const liveMcSol = live.priceSol !== null && live.supply !== null ? live.priceSol * live.supply : null;
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="flex flex-col gap-4">
          <dl>
            <Row label="Status">
              <StatusCell order={order} />
              {order.statusReason && <span className="mt-0.5 block text-label text-fg-2">{order.statusReason}</span>}
            </Row>
            <Row label="Token">
              {order.mint ? (
                <Link to={`/t/${order.mint}`} className="group inline-flex max-w-full items-center gap-2">
                  <TokenAvatar mint={order.mint} symbol={order.symbol} imageUri={null} size="2xs" badge={false} />
                  <span className="truncate font-medium group-hover:underline">{order.symbol}</span>
                  <span className="font-mono text-label text-fg-3">{shortAddr(order.mint)}</span>
                </Link>
              ) : (
                <span className="text-fg-2">{order.symbol} · the mint is known only when it fires</span>
              )}
            </Row>
            <Row label="Type">
              {KIND_NAME[order.kind]} ·{" "}
              <span className={order.side === "buy" ? "text-buy" : "text-sell"}>{order.side === "buy" ? "Buy" : "Sell"}</span>
            </Row>
            <Row label="Trigger">
              <TriggerLabel order={order} />
            </Row>
            {open && order.mint && (
              <Row label="Now">
                <MarketCap sol={liveMcSol} usd={live.mcUsd} /> <span className="text-fg-3">·</span> <DistanceCell order={order} />
              </Row>
            )}
            <Row label="Size">{sizeText(order)}</Row>
            <Row label="Reserved">
              {open ? (
                <Num value={order.reservedSol} kind="sol" unit="SOL" />
              ) : (
                <span className="text-fg-3">Released ({fmtSol(order.reservedSol)} SOL)</span>
              )}
            </Row>
            <Row label="Lane">
              <span className={landing.risky ? "text-warn" : undefined}>{landing.label}</span>
              <span className="text-fg-3"> · {landing.route}</span>
            </Row>
            <Row label="Armed">
              {when(order.createdAt)} <span className="text-fg-3">·</span> <Age ts={order.createdAt} /> ago
            </Row>
            {order.fill && (
              <Row label="Fill">
                {order.side === "buy" ? "Bought" : "Sold"} {fmtTokens(order.fill.tokenAmount)} for{" "}
                <Num value={order.fill.solAmount} kind="sol" unit="SOL" /> at <Num value={order.fill.priceSol} kind="price" unit="SOL" />
              </Row>
            )}
            {order.signature && (
              <Row label="Signature">
                <span className="inline-flex items-center gap-1 font-mono text-fg-2">
                  {shortAddr(order.signature)}
                  <CopyButton text={order.signature} label="Copy signature" />
                </span>
              </Row>
            )}
          </dl>

          <Section title="Min-out grid">
            {order.grid.length > 0 ? (
              <>
                <table className="w-full text-data">
                  <thead>
                    <tr className="h-7 border-b border-hairline text-label text-fg-3">
                      <th scope="col" className="w-[8ch] text-left font-medium">
                        Variant
                      </th>
                      <th scope="col" className="text-right font-medium">
                        Min out
                      </th>
                      <th scope="col" className="w-[14ch] text-right font-medium">
                        Tip SOL
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {order.grid.map((v, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: the grid is fixed once signed
                      <tr key={i} className="h-6 border-b border-hairline last:border-b-0">
                        <td className="zf-num text-fg-3">{i + 1}</td>
                        <td className="text-right">
                          {order.side === "buy" ? (
                            <span className="zf-num text-fg-1">
                              {fmtTokens(v.minOut)} <span className="zf-unit">{order.symbol}</span>
                            </span>
                          ) : (
                            <Num value={v.minOut} kind="sol" unit="SOL" className="text-fg-1" />
                          )}
                        </td>
                        <td className="zf-num text-right text-fg-2">{fmtFee(v.tipSol)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="max-w-[72ch] text-label text-fg-3">
                  When the trigger fires the server submits the variant just below the live quote; it can't change the size, minimum
                  output, fees or destination.
                </p>
              </>
            ) : (
              <p className="text-data text-fg-2">
                None. This order's token isn't known in advance, so this browser builds and signs the transaction when it fires and must
                stay open.
              </p>
            )}
          </Section>

          <Section title="Nonce account">
            <p className="text-data text-fg-2">
              <span className="text-fg-1">
                {nonce.text === "None" ? "No durable nonce" : nonce.shared ? "Shared durable nonce (OCO)" : "Own durable nonce"}
                {order.nonceIndex !== null && <span className="zf-num"> #{order.nonceIndex}</span>}
              </span>
              {" · "}
              {nonce.title}
            </p>
            {order.nonceAccount && (
              <span className="inline-flex items-center gap-1 font-mono text-data text-fg-2">
                {shortAddr(order.nonceAccount)}
                <CopyButton text={order.nonceAccount} label="Copy nonce account" />
              </span>
            )}
          </Section>

          <Section title="Pre-signed cancel">
            <p className="flex items-start gap-2 text-data">
              {cancel.ready && <Check className="icon-xs mt-0.5 shrink-0 text-fg-1" aria-hidden="true" />}
              <span>
                <span className="text-fg-1">{cancel.label}</span>
                <span className="text-fg-2"> · {cancel.detail}</span>
              </span>
            </p>
          </Section>

          <Section title="Timeline">
            <Timeline order={order} />
          </Section>

          <p className="max-w-[72ch] border-t border-hairline pt-3 text-label text-fg-3">
            One landed attempt per nonce. A failed attempt consumes the nonce; re-arm to try again.
          </p>
        </div>
      </div>
      <div className="flex min-h-13 shrink-0 items-center gap-2 border-t border-hairline px-4 py-2">
        {order.mint && (
          <Link to={`/t/${order.mint}`} className="text-data text-fg-2 hover:text-fg-1 hover:underline">
            Open {order.symbol}
          </Link>
        )}
        <span className="ml-auto flex items-center gap-2">
          {canRearm(order) && (
            <Button
              variant="secondary"
              size="md"
              disabled={rearming}
              icon={rearming ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <RotateCw />}
              onClick={() => onRearm(order)}
            >
              Re-arm order
            </Button>
          )}
          {canCancel(order) && (
            <Button variant="danger" size="md" onClick={() => onCancel(order)}>
              Cancel order
            </Button>
          )}
        </span>
      </div>
    </div>
  );
}
