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

/** Bottom tab bar for narrow screens (PWA-style). */
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
            cn("flex flex-col items-center justify-center gap-0.5 text-[10px]", isActive ? "text-accent" : "text-muted")
          }
        >
          <Icon size={18} />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}
