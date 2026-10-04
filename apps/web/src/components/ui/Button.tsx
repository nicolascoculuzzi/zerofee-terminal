import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/cn";

/*
 * Buttons per DESIGN.md 4.6. Hover and press change colour only (no scale, translate or
 * brightness). Solid buy/sell use ink text. Full-width side CTAs after OKX and Binance:
 * https://mobbin.com/screens/f26041bc-ccc7-43f8-b492-2959191e63ae
 * https://mobbin.com/screens/14a47c59-4122-498b-ab2e-4ff6d611c85c
 */
export type ButtonVariant = "primary" | "buy" | "sell" | "buy-tint" | "sell-tint" | "secondary" | "ghost" | "danger";
export type ButtonSize = "xs" | "sm" | "md" | "lg" | "xl";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-ink hover:bg-accent-hover active:bg-accent-press disabled:bg-surface-3 disabled:text-fg-4",
  buy: "bg-buy text-ink hover:bg-buy-hover active:bg-buy-press disabled:bg-surface-3 disabled:text-fg-4",
  sell: "bg-sell text-ink hover:bg-sell-hover active:bg-sell-press disabled:bg-surface-3 disabled:text-fg-4",
  "buy-tint":
    "border border-buy-edge bg-buy-tint text-buy hover:bg-buy-tint-hover active:bg-buy-tint-press disabled:border-transparent disabled:bg-surface-2 disabled:text-fg-4",
  "sell-tint":
    "border border-sell-edge bg-sell-tint text-sell hover:bg-sell-tint-hover active:bg-sell-tint-press disabled:border-transparent disabled:bg-surface-2 disabled:text-fg-4",
  secondary:
    "border border-hairline-strong bg-surface-3 text-fg-1 hover:bg-surface-3-hover active:bg-hairline-strong disabled:border-transparent disabled:bg-surface-2 disabled:text-fg-4",
  ghost: "text-fg-2 hover:bg-surface-3 hover:text-fg-1 active:bg-surface-3-hover disabled:bg-transparent disabled:text-fg-4",
  danger:
    "border border-sell-edge bg-sell-tint text-sell hover:bg-sell-tint-hover active:bg-sell-tint-press disabled:border-transparent disabled:bg-surface-2 disabled:text-fg-4",
};

/** Height · padding · label · icon size (12 / 14 / 14 / 16 / 16 px). */
const SIZES: Record<ButtonSize, string> = {
  xs: "h-5 px-1.5 gap-1 text-label font-medium [&_svg]:size-3",
  sm: "h-6 px-2 gap-1 text-data font-medium [&_svg]:size-3.5",
  md: "h-7 px-2.5 gap-1.5 text-data font-medium [&_svg]:size-3.5",
  lg: "h-8 px-3 gap-2 text-body font-semibold [&_svg]:size-4",
  xl: "h-(--zf-btn-xl) px-4 gap-2 text-body font-semibold [&_svg]:size-4",
};

export interface ButtonProps extends ComponentProps<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
}

export function Button({ variant = "secondary", size = "sm", icon, className, children, type, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? "button"}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-sm whitespace-nowrap transition-colors disabled:cursor-not-allowed",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  );
}

export interface IconButtonProps extends ComponentProps<"button"> {
  label: string;
  /** xs 20 / sm 24 / md 28 px with 12 / 14 / 14 px icons; "nav" is the 28 px top-bar version (16 px icon). */
  size?: "xs" | "sm" | "md" | "nav";
  active?: boolean;
}

const ICON_SIZES = {
  xs: "size-5 [&_svg]:size-3",
  sm: "size-6 [&_svg]:size-3.5",
  md: "size-7 [&_svg]:size-3.5",
  nav: "size-7 [&_svg]:size-4",
};

/** Square ghost button. Icon-only, so it always carries an aria-label and a tooltip. */
export function IconButton({ label, size = "sm", active, className, children, type, title, ...rest }: IconButtonProps) {
  return (
    <button
      type={type ?? "button"}
      aria-label={label}
      title={title ?? label}
      aria-pressed={active}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-sm transition-colors disabled:cursor-not-allowed disabled:bg-transparent disabled:text-fg-4",
        active
          ? "bg-surface-3 text-fg-1 hover:bg-surface-3-hover"
          : "text-fg-3 hover:bg-surface-3 hover:text-fg-1 active:bg-surface-3-hover",
        ICON_SIZES[size],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
