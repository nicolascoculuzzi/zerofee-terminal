import { BriefcaseBusiness, Compass, Crosshair, ListChecks, Radar } from "lucide-react";
import { NavLink, useLocation } from "react-router";
import { cn } from "../lib/cn";

const ITEMS = [
  { to: "/pulse", label: "Pulse", icon: Radar },
  { to: "/discover", label: "Discover", icon: Compass },
  { to: "/trackers", label: "Trackers", icon: Crosshair },
  { to: "/portfolio", label: "Portfolio", icon: BriefcaseBusiness },
  { to: "/orders", label: "Orders", icon: ListChecks },
] as const;

/*
 * Bottom tabs on phones (DESIGN.md 5.8): 56px plus the safe area, 20px icons, 10/500 labels.
 * Active is text-1 with a 2px text-1 bar on top (ink, never a hue); inactive text-3. After
 * Phantom's tab bar: https://mobbin.com/screens/76e93b20-0652-4758-8e2d-4925312a1fba
 *
 * A token page is a detail screen: it draws its own back header and ends in the sticky trade bar
 * (which takes the safe area), so the tabs step aside there, as on Coinbase Advanced's asset page:
 * https://mobbin.com/screens/f7580aa4-4e73-4a2a-800f-4682a03bbd30
 */
export function MobileNav() {
  const { pathname } = useLocation();
  if (pathname.startsWith("/t/")) return null;
  return (
    <nav
      aria-label="Main"
      className="grid h-[calc(56px+env(safe-area-inset-bottom))] shrink-0 grid-cols-5 border-t border-hairline bg-surface-1 pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {ITEMS.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) =>
            cn(
              "focus-inset relative flex flex-col items-center justify-center gap-1 text-micro font-medium transition-colors active:bg-surface-2",
              isActive ? "text-fg-1" : "text-fg-3 hover:text-fg-2",
            )
          }
        >
          {({ isActive }) => (
            <>
              {isActive && <span aria-hidden="true" className="absolute inset-x-5 top-0 h-0.5 bg-fg-1" />}
              <Icon className="icon-lg" />
              {label}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
