import { AppWindow, Ban, Copy, EyeOff, SquareArrowOutUpRight, Star } from "lucide-react";
import { useMemo } from "react";
import { Button } from "../../components/ui/Button";
import { Hotkey } from "../../components/ui/controls";
import { Modal } from "../../components/ui/Modal";
import { MenuItem, MenuSeparator, Popover } from "../../components/ui/Popover";
import { shortAddr } from "../../lib/format";
import { useSettings } from "../../state/settings";
import { blacklistDev, blacklistFunder, blacklistHandle, copyCa, hideToken, tokenFor } from "./actions";
import { menuAnchor, usePulseUi } from "./store";
import { openToken } from "./TokenCard";

/** An anchor at the pointer, for menus opened with a right-click. */
function pointAnchor(x: number, y: number) {
  const el = {
    getBoundingClientRect: () => new DOMRect(x, y, 0, 0),
    contains: () => false,
  } as unknown as HTMLElement;
  return { current: el };
}

/**
 * Per-card menu (DESIGN.md 4.17), one for the whole page: from a card's "more" button or a
 * right-click. Every item shows its Pulse hotkey. Blacklisting removes the card everywhere, with
 * an Undo toast; the dev blacklist asks first. Right-aligned shortcut hints after OKX:
 * https://mobbin.com/screens/a2bb80c5-27d1-4a5e-a87e-7c852a2d38f3
 */
export function TokenMenu() {
  const menu = usePulseUi((s) => s.menu);
  const keys = useSettings((s) => s.hotkeys);
  const watched = useSettings((s) => (menu ? s.watchlist.includes(menu.mint) : false));
  const toggleWatch = useSettings((s) => s.toggleWatch);
  const anchor = useMemo(() => (menu?.x !== undefined && menu.y !== undefined ? pointAnchor(menu.x, menu.y) : menuAnchor), [menu]);
  const close = () => usePulseUi.getState().openMenu(null);
  const t = menu ? tokenFor(menu.mint) : undefined;
  const run = (fn: () => void) => () => {
    close();
    fn();
  };

  return (
    <Popover open={!!menu && !!t} onClose={close} anchor={anchor} align={menu?.x === undefined ? "end" : "start"} width={248}>
      {menu && t && (
        <div role="menu" aria-label={`${t.symbol} actions`}>
          <MenuItem
            icon={<SquareArrowOutUpRight />}
            hint={<Hotkey binding={keys["pulse.open"]?.[0]} />}
            onSelect={run(() => openToken(t.mint, false))}
          >
            Open token page
          </MenuItem>
          <MenuItem
            icon={<AppWindow />}
            hint={<Hotkey binding={keys["pulse.openNew"]?.[0]} />}
            onSelect={run(() => openToken(t.mint, true))}
          >
            Open in a new tab
          </MenuItem>
          <MenuItem icon={<Copy />} hint={<Hotkey binding={keys["pulse.copy"]?.[0]} />} onSelect={run(() => copyCa(t.mint))}>
            Copy contract address
          </MenuItem>
          <MenuItem icon={<Star />} onSelect={run(() => toggleWatch(t.mint))}>
            {watched ? "Remove from watchlist" : "Add to watchlist"}
          </MenuItem>
          <MenuSeparator />
          <MenuItem danger icon={<EyeOff />} hint={<Hotkey binding={keys["pulse.hide"]?.[0]} />} onSelect={run(() => hideToken(t.mint))}>
            Hide {t.symbol}
          </MenuItem>
          <MenuItem
            danger
            icon={<Ban />}
            hint={<Hotkey binding={keys["pulse.blacklistDev"]?.[0]} />}
            onSelect={run(() => usePulseUi.getState().askBlacklistDev(t.mint))}
          >
            Blacklist dev
          </MenuItem>
          {t.fundingWallet && (
            <MenuItem danger icon={<Ban />} onSelect={run(() => blacklistFunder(t.mint))}>
              Blacklist the dev's funder
            </MenuItem>
          )}
          {t.socials.x && (
            <MenuItem danger icon={<Ban />} onSelect={run(() => blacklistHandle(t.mint))}>
              Blacklist @{t.socials.x}
            </MenuItem>
          )}
        </div>
      )}
    </Popover>
  );
}

/**
 * Dev blacklist confirm (DESIGN.md 4.17, 6.4 Shift+X): the title names the action, the body
 * states the consequence, and the buttons name both outcomes. Focus starts on the safe one.
 */
export function ConfirmDevDialog() {
  const mint = usePulseUi((s) => s.confirmDev);
  const close = () => usePulseUi.getState().askBlacklistDev(null);
  const t = mint ? tokenFor(mint) : undefined;
  return (
    <Modal
      open={!!t}
      onClose={close}
      title={t ? `Blacklist the dev of ${t.symbol}?` : ""}
      width={400}
      footer={
        <div className="flex justify-end gap-2">
          <Button size="md" variant="secondary" onClick={close} data-autofocus>
            Keep showing
          </Button>
          <Button
            size="md"
            variant="sell"
            onClick={() => {
              if (mint) blacklistDev(mint);
              close();
            }}
          >
            Blacklist dev
          </Button>
        </div>
      }
    >
      {t && (
        <p className="text-body text-fg-2">
          Every token created by <span className="font-mono text-fg-1">{shortAddr(t.creator)}</span> leaves all Pulse columns, now and
          later. You can show them again from Blacklist.
        </p>
      )}
    </Modal>
  );
}
