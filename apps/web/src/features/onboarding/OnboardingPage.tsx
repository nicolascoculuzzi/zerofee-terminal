import { ArrowRight } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Logo } from "../../app/Logo";
import { fmtClock, fmtSolShort, shortAddr } from "../../lib/format";
import { closeTopOverlay } from "../../lib/overlayStack";
import { getServices } from "../../services";
import type { TradeMode } from "../../services/tradeService";
import type { ConnectedWallet, SiwsSession, TradingWallet } from "../../services/walletService";
import { useSettings } from "../../state/settings";
import { useToasts } from "../../state/toasts";
import { useWallet } from "../../state/wallet";
import { MODE_INFO } from "../settings/modes";
import { Chip } from "../settings/ui";
import { ApprovalModal } from "../trade/ApprovalModal";
import { BackupStep } from "./BackupStep";
import { ConnectStep } from "./ConnectStep";
import { type FundResult, FundStep } from "./FundStep";
import { ModeStep } from "./ModeStep";
import { PROVIDER_NAME, STEP_TITLE_ID, type StepFrame } from "./parts";
import { SignInStep } from "./SignInStep";
import { StepList } from "./StepList";
import { WalletStep } from "./WalletStep";

const STEPS = [
  { id: "connect", title: "Connect wallet", description: "Pick the wallet you sign in with. zerofee only sees its public address." },
  { id: "signin", title: "Sign in", description: "Sign one message to prove the wallet is yours. No password, no email, no fee." },
  { id: "wallet", title: "Trading wallet", description: "A separate wallet for fast trades, generated and encrypted in this browser." },
  { id: "backup", title: "Back up", description: "Save the backup before you put any SOL in the trading wallet." },
  { id: "fund", title: "Fund", description: "Move SOL from your connected wallet into the trading wallet." },
  { id: "mode", title: "Default mode", description: "Choose who signs your trades. You can change it any time." },
] as const;

/*
 * Onboarding, full screen and outside the app shell. Compact, left-aligned two-column setup
 * (step list left, current step right) after Melio's and Mercury's account setup:
 * https://mobbin.com/screens/45acbdef-a8f5-466e-920c-3a2f4b3f8fb8
 * https://mobbin.com/screens/8b12e7b5-4bd6-4eea-9a61-7ebbcfa4f855
 */
export default function OnboardingPage() {
  const navigate = useNavigate();
  const autoLockMinutes = useSettings((s) => s.autoLockMinutes);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState<ConnectedWallet | null>(null);
  const [session, setSession] = useState<SiwsSession | null>(null);
  const [created, setCreated] = useState<{ wallet: TradingWallet; phrase: string[] } | null>(null);
  const [backedUp, setBackedUp] = useState(false);
  const [funded, setFunded] = useState<FundResult | null>(null);
  const [fundSkipped, setFundSkipped] = useState(false);
  const [mode, setMode] = useState<TradeMode>(() => useSettings.getState().defaultMode);
  const mainRef = useRef<HTMLElement>(null);
  const stepRef = useRef<HTMLElement>(null);
  const shownStep = useRef(step);
  const simulated = getServices().simulated;

  // The shell's global hotkeys aren't mounted here, so Escape closes the wallet popup directly.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && closeTopOverlay()) e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // On every step change (not the first render): back to the top, and focus moves to the new
  // step so keyboard and screen-reader users land on its heading.
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    mainRef.current?.scrollTo({ top: 0 });
    stepRef.current?.focus({ preventScroll: true });
  }, [step]);

  const done = [connected !== null, session !== null, created !== null, backedUp, funded !== null || fundSkipped, false];
  const canVisit = (index: number) => done.slice(0, index).every(Boolean);
  const go = (index: number) => {
    if (index >= 0 && index < STEPS.length && canVisit(index)) setStep(index);
  };

  const summaries = [
    connected ? `${PROVIDER_NAME[connected.provider]} · ${shortAddr(connected.address, 4, 4)}` : null,
    session ? `Session until ${fmtClock(session.expiresAt, false)}` : null,
    created ? `${created.wallet.label} · ${shortAddr(created.wallet.address, 4, 4)}` : null,
    backedUp ? "Backup confirmed" : null,
    funded ? `${fmtSolShort(funded.sol)} SOL added` : fundSkipped ? "Skipped" : null,
    step === STEPS.length - 1 ? MODE_INFO[mode].label : null,
  ];

  const meta = STEPS[step] ?? STEPS[0];
  const frame: StepFrame = { index: step, total: STEPS.length, title: meta.title, description: meta.description };

  const finish = () => {
    if (!created) return;
    const settings = useSettings.getState();
    const wallet = useWallet.getState();
    settings.setDefaultMode(mode);
    wallet.setMode(mode);
    wallet.setActive(created.wallet.address);
    settings.setOnboarded(true);
    useToasts.getState().push({
      kind: "success",
      title: "Setup complete",
      body: `${created.wallet.label} is your active trading wallet, in ${MODE_INFO[mode].label} mode.`,
    });
    navigate("/pulse");
  };

  let content: ReactNode = null;
  if (step === 0) {
    content = (
      <ConnectStep
        frame={frame}
        connected={connected}
        onBusyChange={setBusy}
        onConnected={(wallet) => {
          // A new connection replaces the session; the new address must sign again.
          setConnected(wallet);
          setSession(null);
        }}
        onNext={() => go(1)}
      />
    );
  } else if (step === 1 && connected) {
    content = (
      <SignInStep
        frame={frame}
        connected={connected}
        session={session}
        onBusyChange={setBusy}
        onSigned={setSession}
        onBack={() => go(0)}
        onNext={() => go(2)}
      />
    );
  } else if (step === 2) {
    content = (
      <WalletStep
        frame={frame}
        created={created?.wallet ?? null}
        autoLockMinutes={autoLockMinutes}
        onBusyChange={setBusy}
        onCreated={(result) => {
          setCreated(result);
          setStep(3);
        }}
        onBack={() => go(1)}
        onNext={() => go(3)}
      />
    );
  } else if (step === 3 && created) {
    content = (
      <BackupStep
        frame={frame}
        wallet={created.wallet}
        phrase={created.phrase}
        backedUp={backedUp}
        onBusyChange={setBusy}
        onConfirmed={() => {
          setBackedUp(true);
          setStep(4);
        }}
        onBack={() => go(2)}
        onNext={() => go(4)}
      />
    );
  } else if (step === 4 && connected && created) {
    content = (
      <FundStep
        frame={frame}
        connected={connected}
        wallet={created.wallet}
        funded={funded}
        onBusyChange={setBusy}
        onFunded={setFunded}
        onSkip={() => {
          setFundSkipped(true);
          setStep(5);
        }}
        onBack={() => go(3)}
        onNext={() => go(5)}
      />
    );
  } else if (step === 5 && created) {
    content = (
      <ModeStep frame={frame} mode={mode} walletLabel={created.wallet.label} onMode={setMode} onBack={() => go(4)} onFinish={finish} />
    );
  }

  return (
    <div className="flex h-dvh flex-col bg-bg text-fg-1">
      <header className="flex h-topbar shrink-0 items-center gap-3 border-b border-hairline bg-surface-1 px-4">
        <Link to="/pulse" aria-label="zerofee home" className="shrink-0">
          <Logo />
        </Link>
        <span className="hidden text-data text-fg-2 sm:inline">Account setup</span>
        <div className="ml-auto flex items-center gap-3">
          {simulated && (
            <span className="hidden sm:inline-flex">
              <Chip tone="warn">Simulated</Chip>
            </span>
          )}
          <Link to="/pulse" className="inline-flex items-center gap-1 text-data text-fg-2 hover:text-fg-1">
            Skip, explore the demo <ArrowRight className="icon-sm" />
          </Link>
        </div>
      </header>

      <main ref={mainRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex max-w-5xl flex-col gap-6 px-4 py-6 sm:px-8 md:flex-row md:gap-8">
          <aside className="md:w-64 md:shrink-0">
            <h1 className="text-title font-semibold text-fg-1">Set up zerofee</h1>
            <p className="mt-1 mb-4 text-data text-fg-2">
              Connect your wallet, sign in, and create a trading wallet that stays encrypted in this browser.
              {simulated && " Everything here is simulated: no real wallet, keys or funds."}
            </p>
            <StepList steps={STEPS} current={step} done={done} summaries={summaries} canVisit={canVisit} onSelect={go} disabled={busy} />
          </aside>
          <section key={step} ref={stepRef} tabIndex={-1} aria-labelledby={STEP_TITLE_ID} className="min-w-0 max-w-2xl flex-1 outline-none">
            {content}
          </section>
        </div>
      </main>

      {/* The simulated wallet popup (sign-in, funding) lives in the shell, which isn't mounted here. */}
      <ApprovalModal />
    </div>
  );
}
