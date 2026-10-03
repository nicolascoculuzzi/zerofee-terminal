import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

export type ButtonVariant = "primary" | "buy" | "sell" | "ghost" | "outline" | "subtle" | "danger";
export type ButtonSize = "xs" | "sm" | "md" | "lg";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg hover:brightness-110 font-semibold",
  buy: "bg-buy text-black hover:brightness-110 font-semibold",
  sell: "bg-sell text-white hover:brightness-110 font-semibold",
  ghost: "text-muted hover:text-fg hover:bg-hover",
  outline: "border border-line-strong text-fg hover:bg-hover",
  subtle: "bg-elev text-fg hover:bg-hover border border-line",
  danger: "bg-sell/15 text-sell border border-sell/30 hover:bg-sell/25",
};

const SIZES: Record<ButtonSize, string> = {
  xs: "h-6 px-2 text-[11px] gap-1 rounded",
  sm: "h-7 px-2.5 text-xs gap-1.5 rounded-md",
  md: "h-8 px-3 text-[13px] gap-2 rounded-md",
  lg: "h-10 px-4 text-sm gap-2 rounded-lg",
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
        "inline-flex shrink-0 items-center justify-center whitespace-nowrap transition-[background-color,filter,color] disabled:opacity-45",
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

const ICON_SIZES = { xs: "h-5 w-5", sm: "h-6 w-6", md: "h-7 w-7" };

export function IconButton({ label, size = "sm", active, className, children, type, ...rest }: IconButtonProps) {
  return (
    <button
      type={type ?? "button"}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded transition-colors disabled:opacity-40",
        active ? "bg-accent/15 text-accent" : "text-muted hover:bg-hover hover:text-fg",
        ICON_SIZES[size],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
