import { useNavigate } from "react-router";
import { Button } from "../../components/ui/Button";
import { StatusDot } from "../../components/ui/bits";
import { Hotkey, Switch } from "../../components/ui/controls";
import { fmtCount, fmtDate } from "../../lib/format";
import { getServices } from "../../services";
import { useSettings } from "../../state/settings";
import { useTrackers } from "../../state/trackers";
import { useUi } from "../../state/ui";
import { type AlertChannel, type AlertEvent, useAlertPrefs } from "./alerts";
import { Note, Row, Rows, SectionHeader, SubHeader, Tag } from "./ui";

const CHANNELS: { id: AlertChannel; label: string; help: string }[] = [
  { id: "push", label: "Web Push", help: "Browser notifications, also while the tab is closed. The browser asks for permission first." },
  { id: "telegram", label: "Telegram", help: "Messages from the zerofee bot. You confirm by sending /start to it." },
  { id: "discord", label: "Discord", help: "Direct messages from the zerofee app after you authorise it." },
];

const EVENTS: { id: AlertEvent; label: string; help: string }[] = [
  { id: "orderFilled", label: "Order filled", help: "An armed limit, take-profit or stop-loss landed." },
  { id: "orderFailed", label: "Order failed or needs re-arm", help: "An attempt failed, or an upgrade made a pre-signed order stale." },
  { id: "orderCancelled", label: "Order cancelled", help: "By you, by Panic, or because its OCO sibling filled." },
  { id: "trackedTrade", label: "Tracked wallet trades", help: "" },
  { id: "priceAlert", label: "Price alerts", help: "" },
  { id: "migration", label: "Held token migrated", help: "A bonding-curve token you hold moved to its pool." },
  { id: "connection", label: "Feed lost or restored", help: "The live feed dropped or came back." },
];

/*
 * Alerts (DESIGN.md 5.5): delivery channels with connection status and per-event switches.
 * "CONNECTED" chip with Disconnect after OpenSea's linked accounts; channel next to the rule
 * after Perplexity's price alert:
 * https://mobbin.com/flows/5ab8ab32-84d8-4c0b-81a8-9604e657b23e
 * https://mobbin.com/screens/05d1e5bc-6996-4d08-a5b2-81a9aca3684a
 */
export function AlertsSection() {
  const navigate = useNavigate();
  const closeSettings = useUi((s) => s.closeSettings);
  const channels = useAlertPrefs((s) => s.channels);
  const events = useAlertPrefs((s) => s.events);
  const setChannel = useAlertPrefs((s) => s.setChannel);
  const setEvent = useAlertPrefs((s) => s.setEvent);
  const trackedWithAlerts = useTrackers((s) => s.wallets.filter((w) => w.alerts).length);
  const alertKey = useSettings((s) => s.hotkeys["token.alert"]?.[0]);
  const simulated = getServices().simulated;
  const anyChannel = CHANNELS.some((c) => channels[c.id].connectedAt !== null);

  const help = (e: (typeof EVENTS)[number]) => {
    if (e.id === "trackedTrade") {
      return (
        <>
          {fmtCount(trackedWithAlerts)} tracked {trackedWithAlerts === 1 ? "wallet has" : "wallets have"} alerts on. Turn them on per wallet
          in{" "}
          <button
            type="button"
            onClick={() => {
              closeSettings();
              navigate("/trackers");
            }}
            className="font-medium text-fg-1 underline-offset-2 hover:underline"
          >
            Trackers
          </button>
          .
        </>
      );
    }
    if (e.id === "priceAlert") {
      return (
        <>
          Alerts you set on a token chart{alertKey && " with "}
          {alertKey && <Hotkey binding={alertKey} className="align-middle" />}.
        </>
      );
    }
    return e.help;
  };

  return (
    <>
      <SectionHeader
        title="Alerts"
        description="Where order and wallet events reach you when you aren't watching. Trade progress always shows in the app."
      />
      {simulated && <Note>Simulated: channels connect in place and nothing is sent anywhere.</Note>}

      <SubHeader anchor="channels">Channels</SubHeader>
      <Rows>
        <Row label="In app" help="Toasts and sounds while zerofee is open.">
          <Tag>Always on</Tag>
        </Row>
        {CHANNELS.map((c) => {
          const at = channels[c.id].connectedAt;
          return (
            <Row key={c.id} label={c.label} help={c.help}>
              {at !== null ? (
                <>
                  <StatusDot tone="buy" className="text-label text-fg-2">
                    Connected {fmtDate(at)}
                  </StatusDot>
                  <Button size="xs" variant="ghost" onClick={() => setChannel(c.id, false)}>
                    Disconnect
                  </Button>
                </>
              ) : (
                <>
                  <span className="text-label text-fg-3">Not connected</span>
                  <Button size="xs" variant="secondary" disabled={!simulated} onClick={() => setChannel(c.id, true)}>
                    Connect {c.label}
                  </Button>
                </>
              )}
            </Row>
          );
        })}
      </Rows>

      <SubHeader
        anchor="events"
        actions={!anyChannel ? <span className="text-label text-fg-3">Connect a channel to deliver these</span> : null}
      >
        Events
      </SubHeader>
      <Rows>
        {EVENTS.map((e) => (
          <Row key={e.id} label={e.label} help={help(e)}>
            <Switch checked={events[e.id]} onChange={(on) => setEvent(e.id, on)} label={e.label} />
          </Row>
        ))}
      </Rows>
    </>
  );
}
