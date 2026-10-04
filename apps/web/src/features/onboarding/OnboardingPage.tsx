import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Logo } from "../../app/Logo";
import { fmtClock, fmtSol, fmtSolShort, shortAddr } from "../../lib/format";
import { closeTopOverlay } from "../../lib/overlayStack";
import { getServices } from "../../services";
import type { ConnectedWallet, SiwsSession, TradingWallet } from "../../services/walletService";
import { useSettings } from "../../state/settings";
import { useWallet } from "../../state/wallet";
import { Tag } from "../settings/ui";
import { ApprovalModal } from "../trade/ApprovalModal";
import { BackupStep } from "./BackupStep";
import { ConnectStep } from "./ConnectStep";
import { DoneStep } from "./DoneStep";
import { type FundResult, FundStep } from "./FundStep";
import { LimitsStep } from "./LimitsStep";
import { PROVIDER_NAME, STEP_TITLE_ID, type StepFrame } from "./parts";
import { SignInStep } from "./SignInStep";
import { StepProgress, Stepper } from "./Stepper";
import { WalletStep } from "./WalletStep";

const STEPS = [
  {
    id: "connect",
    label: "Connect wallet",
    title: "Connect your wallet",
    description: "Pick the wallet you sign in with. zerofee only sees its public address.",
  },
  {
    id: "signin",
    label: "Sign in",
    title: "Sign in",
    description: "Sign one message to prove the wallet is yours. No password, no email, no fee.",
  },
  {
    id: "wallet",
    label: "Trading wallet",
    title: "Create your trading wallet",
    description: "A separate wallet that signs your trades in this browser, so there is no popup per trade.",
  },
  {
    id: "backup",
    label: "Back up",
    title: "Back up the key",
    description: "Save it before any SOL goes in. Only this key can restore the wallet.",
  },
  {
    id: "limits",
    label: "Limits",
    title: "Set your limits",
    description: "The signer refuses anything above these, even if this page is compromised.",
  },
  {
    id: "fund",
    label: "Fund",
    title: "Fund the trading wallet",
    description: "Keep only what you're willing to trade with. Withdrawing back is one click.",
  },
  { id: "done", label: "Done", title: "You're set up", description: "Everything below is saved in this browser." },
] as const;

/*
 * Onboarding (DESIGN.md 4.19, 5.6): full screen, no top bar or status bar. The logo sits 24 px
 * from the top-left corner, a 280 px stepper rail starts at y 96, and the content column (max
 * 440 px) starts at x 344, y 64, top-left aligned. Phones get a 4 px segmented progress bar.
 * Stepper after OKX's deposit flow: https://mobbin.com/flows/a6c83dd1-51f7-4e6f-95da-faff776eb1ca
 */
export default function OnboardingPage() {
  const navigate = useNavigate();
  const autoLockMinutes = useSettings((s) => s.autoLockMinutes);
  const caps = useSettings((s) => s.caps);
  // Live: a returning user starts from what is already true (connected wallet, session, the keystore's
  // first wallet and its backup) instead of creating another wallet. The simulation always walks the flow.
  const [initial] = useState(() => {
    const s = getServices();
    const st = s.wallet.getState();
    if (s.simulated) return { step: 0, connected: null, session: null, created: null, backedUp: false };
    const connected = st.connected;
    const session = connected && st.session?.address === connected.address ? st.session : null;
    const created = st.tradingWallets.find((w) => !w.archived) ?? null;
    const backedUp = created?.backedUpAt != null;
    const step = !connected ? 0 : !session ? 1 : !created ? 2 : !backedUp ? 3 : 4;
    return { step, connected, session, created, backedUp };
  });
  const [step, setStep] = useState(initial.step);
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState<ConnectedWallet | null>(initial.connected);
  const [session, setSession] = useState<SiwsSession | null>(initial.session);
  const [created, setCreated] = useState<TradingWallet | null>(initial.created);
  const [backedUp, setBackedUp] = useState(initial.backedUp);
  const [limitsSet, setLimitsSet] = useState(false);
  const [funded, setFunded] = useState<FundResult | null>(null);
  const [fundSkipped, setFundSkipped] = useState(false);
  const contentRef = useRef<HTMLElement>(null);
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
  // step so keyboard and screen-reader users land on its title.
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    window.scrollTo({ top: 0 });
    contentRef.current?.focus({ preventScroll: true });
  }, [step]);

  const done = [connected !== null, session !== null, created !== null, backedUp, limitsSet, funded !== null || fundSkipped, false];
  const canVisit = (index: number) => !busy && done.slice(0, index).every(Boolean);
  const go = (index: number) => {
    if (index >= 0 && index < STEPS.length && canVisit(index)) setStep(index);
  };
  const onBusyChange = useCallback((b: boolean) => setBusy(b), []);

  const sublabels = [
    connected ? `${PROVIDER_NAME[connected.provider]} · ${shortAddr(connected.address)}` : null,
    session ? `Session until ${fmtClock(session.expiresAt, false)}` : null,
    created ? `${created.label} · ${created.unlockMethod === "passkey" ? "passkey" : "passphrase"}` : null,
    backedUp ? "Verified" : null,
    limitsSet ? `${fmtSolShort(caps.perTradeSol)} SOL per trade · ${fmtSolShort(caps.dailySol)} a day` : null,
    funded ? `${fmtSol(funded.sol)} SOL` : fundSkipped ? "Skipped" : null,
    null,
  ];

  const meta = STEPS[step] ?? STEPS[0];
  const frame: StepFrame = {
    title: meta.title,
    description: meta.description,
    onBack: step > 0 && !busy ? () => go(step - 1) : null,
  };

  const finish = () => {
    if (!created) return;
    useWallet.getState().setActive(created.address);
    useSettings.getState().setOnboarded(true);
    // The finished checklist was the confirmation; no "setup complete" toast (DESIGN.md 4.13).
    navigate("/pulse");
  };

  let content: ReactNode = null;
  if (step === 0) {
    content = (
      <ConnectStep
        frame={frame}
        connected={connected}
        onBusyChange={onBusyChange}
        onConnected={(wallet) => {
          // A new connection replaces the session: the new address must sign again.
          setConnected(wallet);
          setSession(null);
          setStep(1);
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
        onBusyChange={onBusyChange}
        onSigned={(s) => {
          setSession(s);
          setStep(2);
        }}
        onNext={() => go(2)}
      />
    );
  } else if (step === 2) {
    content = (
      <WalletStep
        frame={frame}
        created={created}
        autoLockMinutes={autoLockMinutes}
        onBusyChange={onBusyChange}
        onCreated={(wallet) => {
          setCreated(wallet);
          setStep(3);
        }}
        onNext={() => go(3)}
      />
    );
  } else if (step === 3 && created) {
    content = (
      <BackupStep
        frame={frame}
        wallet={created}
        backedUp={backedUp}
        onBusyChange={onBusyChange}
        onConfirmed={() => {
          setBackedUp(true);
          setStep(4);
        }}
        onNext={() => go(4)}
      />
    );
  } else if (step === 4) {
    content = (
      <LimitsStep
        frame={frame}
        onDone={() => {
          setLimitsSet(true);
          setStep(5);
        }}
      />
    );
  } else if (step === 5 && connected && created) {
    content = (
      <FundStep
        frame={frame}
        connected={connected}
        wallet={created}
        funded={funded}
        onBusyChange={onBusyChange}
        onFunded={setFunded}
        onSkip={() => {
          setFundSkipped(true);
          setStep(6);
        }}
        onNext={() => go(6)}
      />
    );
  } else if (step === 6 && connected && created) {
    content = <DoneStep frame={frame} connected={connected} wallet={created} backedUp={backedUp} funded={funded} onOpen={finish} />;
  }

  return (
    <div className="relative min-h-dvh bg-bg text-fg-1">
      <header className="flex items-center gap-3 px-3 pt-4 md:absolute md:top-6 md:left-6 md:p-0">
        <Link to="/pulse" aria-label="zerofee, leave setup" className="shrink-0 rounded-sm">
          <Logo />
        </Link>
        {simulated && <Tag tone="warn">Simulated data</Tag>}
      </header>

      <div className="px-3 pb-16 md:grid md:grid-cols-[280px_minmax(0,440px)] md:gap-x-10 md:px-6">
        <aside className="pt-4 md:pt-24">
          <div className="md:hidden">
            <StepProgress current={step} total={STEPS.length} label={meta.label} />
          </div>
          <div className="hidden md:block">
            <Stepper steps={STEPS} current={step} done={done} sublabels={sublabels} canVisit={canVisit} onSelect={go} />
          </div>
        </aside>
        <main ref={contentRef} key={step} tabIndex={-1} aria-labelledby={STEP_TITLE_ID} className="min-w-0 pt-4 outline-none md:pt-16">
          {content}
        </main>
      </div>

      {/* The simulated wallet popup (sign-in, funding) lives in the shell, which isn't mounted here. */}
      <ApprovalModal />
    </div>
  );
}
