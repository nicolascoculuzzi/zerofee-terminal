import { BriefcaseBusiness, Compass, Crosshair, ListChecks, Radar } from "lucide-react";
import { NavLink } from "react-router";
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
 * Active is text-1 with a 2px accent bar on top; inactive text-3. After Phantom's tab bar:
 * https://mobbin.com/screens/76e93b20-0652-4758-8e2d-4925312a1fba
 */
export function MobileNav() {
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
              "relative flex flex-col items-center justify-center gap-1 text-micro font-medium transition-colors",
              isActive ? "text-fg-1" : "text-fg-3",
            )
          }
        >
          {({ isActive }) => (
            <>
              {isActive && <span aria-hidden="true" className="absolute inset-x-4 top-0 h-0.5 rounded-b-xs bg-accent" />}
              <Icon className="icon-lg" />
              {label}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}
