import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

/*
 * Button anatomy follows Coinbase Advanced's order form: flat fills, no shadows, buy/sell
 * coloured only when the action is a buy or a sell, everything else neutral.
 * https://mobbin.com/screens/ff785484-4dd2-4fc0-a5f4-658e033b3b08
 */
export type ButtonVariant = "primary" | "buy" | "sell" | "ghost" | "outline" | "subtle" | "danger";
export type ButtonSize = "xs" | "sm" | "md" | "lg";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-fg text-on-primary hover:bg-fg/90 font-semibold",
  buy: "bg-buy text-on-buy hover:bg-buy/90 font-semibold",
  sell: "bg-sell text-on-sell hover:bg-sell/90 font-semibold",
  ghost: "text-muted hover:text-fg hover:bg-hover",
  outline: "border border-line-strong text-fg hover:bg-hover",
  subtle: "bg-elev text-fg hover:bg-hover border border-line",
  danger: "border border-sell/40 text-sell hover:bg-sell/10",
};

const SIZES: Record<ButtonSize, string> = {
  xs: "h-5 px-2 text-2xs gap-1 rounded-sm",
  sm: "h-6 px-2 text-xs gap-1 rounded-md",
  md: "h-7 px-3 text-sm gap-1 rounded-md",
  lg: "h-8 px-4 text-sm gap-2 rounded-md",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
}

export function Button({ variant = "subtle", size = "sm", icon, className, children, type, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? "button"}
      className={cn(
        "inline-flex shrink-0 items-center justify-center whitespace-nowrap transition-colors disabled:opacity-40",
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

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  size?: "xs" | "sm" | "md";
  active?: boolean;
}

const ICON_SIZES = { xs: "size-5", sm: "size-6", md: "size-7" };

export function IconButton({ label, size = "sm", active, className, children, type, ...rest }: IconButtonProps) {
  return (
    <button
      type={type ?? "button"}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-40",
        active ? "bg-elev text-fg" : "text-muted hover:bg-hover hover:text-fg",
        ICON_SIZES[size],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
