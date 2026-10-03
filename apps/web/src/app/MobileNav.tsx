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
 * Bottom tab bar for narrow screens (PWA layout), after Phantom's five-icon tab bar:
 * https://mobbin.com/screens/76e93b20-0652-4758-8e2d-4925312a1fba
 */
export function MobileNav() {
  return (
    <nav
      aria-label="Main"
      className="grid h-14 shrink-0 grid-cols-5 border-t border-line bg-panel pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {ITEMS.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) =>
            cn(
              "flex flex-col items-center justify-center gap-1 border-t-2 text-2xs",
              isActive ? "border-accent text-fg" : "border-transparent text-muted",
            )
          }
        >
          <Icon className="icon-lg" />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}
