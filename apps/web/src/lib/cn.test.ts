import { describe, expect, test } from "bun:test";
import { classGroup, cn } from "./cn";

describe("cn joining", () => {
  test("skips falsy parts", () => {
    expect(cn("a", false, null, undefined, 0, "", "b")).toBe("a b");
    expect(cn()).toBe("");
    expect(cn("solo")).toBe("solo");
  });

  test("keeps unknown classes and their order", () => {
    expect(cn("group/row foo focus-inset num-dense", "bar")).toBe("group/row foo focus-inset num-dense bar");
  });

  test("collapses whitespace and duplicate classes", () => {
    expect(cn("  flex\n  items-center ", "foo foo")).toBe("flex items-center foo");
  });

  test("returns a stable cached string", () => {
    const a = cn("px-2 py-1", "px-3");
    expect(cn("px-2 py-1", "px-3")).toBe(a);
    expect(a).toBe("py-1 px-3");
  });
});

describe("cn conflicts: later wins", () => {
  test.each([
    ["gap-2", "gap-1.5", "gap-1.5"],
    ["gap-x-2", "gap-x-4", "gap-x-4"],
    ["p-2", "p-3", "p-3"],
    ["px-2", "px-pad", "px-pad"],
    ["pt-1", "pt-0", "pt-0"],
    ["m-1", "m-2", "m-2"],
    ["-mt-1", "mt-2", "mt-2"],
    ["mt-2", "-mt-px", "-mt-px"],
    ["w-4", "w-[120px]", "w-[120px]"],
    ["min-w-0", "min-w-[80px]", "min-w-[80px]"],
    ["max-w-full", "max-w-[200px]", "max-w-[200px]"],
    ["h-row", "h-6", "h-6"],
    ["min-h-0", "min-h-full", "min-h-full"],
    ["size-3", "size-4", "size-4"],
    ["icon-xs", "icon-sm", "icon-sm"],
    ["text-data", "text-label", "text-label"],
    ["text-display-2", "text-display-1", "text-display-1"],
    ["text-fg-3", "text-fg-1", "text-fg-1"],
    ["text-fg-2", "text-buy", "text-buy"],
    ["text-sell", "text-risk-high", "text-risk-high"],
    ["text-[11px]", "text-micro", "text-micro"],
    ["text-fg-1", "text-[var(--zf-buy)]", "text-[var(--zf-buy)]"],
    ["text-left", "text-right", "text-right"],
    ["font-medium", "font-semibold", "font-semibold"],
    ["font-sans", "font-mono", "font-mono"],
    ["bg-surface-1", "bg-surface-3", "bg-surface-3"],
    ["bg-buy-tint", "bg-transparent", "bg-transparent"],
    ["border-hairline", "border-hairline-strong", "border-hairline-strong"],
    ["border", "border-0", "border-0"],
    ["border-b", "border-b-2", "border-b-2"],
    ["border-b-hairline", "border-b-buy", "border-b-buy"],
    ["rounded-sm", "rounded-md", "rounded-md"],
    ["rounded-t-sm", "rounded-t-none", "rounded-t-none"],
    ["leading-4", "leading-none", "leading-none"],
    ["tracking-wide", "tracking-[0.02em]", "tracking-[0.02em]"],
    ["flex", "hidden", "hidden"],
    ["inline-flex", "grid", "grid"],
    ["block", "inline-block", "inline-block"],
    ["relative", "absolute", "absolute"],
    ["justify-between", "justify-end", "justify-end"],
    ["items-center", "items-baseline", "items-baseline"],
    ["self-start", "self-center", "self-center"],
    ["overflow-hidden", "overflow-auto", "overflow-auto"],
    ["overflow-x-auto", "overflow-x-hidden", "overflow-x-hidden"],
    ["opacity-0", "opacity-100", "opacity-100"],
    ["z-10", "z-popover", "z-popover"],
    ["inset-0", "inset-2", "inset-2"],
    ["top-0", "top-1/2", "top-1/2"],
    ["left-0", "-left-px", "-left-px"],
    ["grid-cols-2", "grid-cols-[1fr_auto]", "grid-cols-[1fr_auto]"],
    ["flex-1", "flex-none", "flex-none"],
    ["flex-row", "flex-col", "flex-col"],
    ["flex-wrap", "flex-nowrap", "flex-nowrap"],
    ["shrink", "shrink-0", "shrink-0"],
    ["grow", "grow-0", "grow-0"],
    ["whitespace-nowrap", "whitespace-normal", "whitespace-normal"],
    ["truncate", "text-clip", "text-clip"],
    ["cursor-pointer", "cursor-default", "cursor-default"],
    ["uppercase", "normal-case", "normal-case"],
  ])("%s then %s", (a, b, want) => {
    expect(cn(a, b)).toBe(want);
  });

  test("conflict keeps the position of the winner", () => {
    expect(cn("flex gap-2 px-2", "items-center gap-1.5")).toBe("flex px-2 items-center gap-1.5");
  });
});

describe("cn non-conflicts", () => {
  test.each([
    ["text-data text-fg-1"],
    ["text-label text-buy"],
    ["text-display-1 text-fg-2"],
    ["text-micro text-right"],
    ["font-mono font-medium"],
    ["border border-hairline"],
    ["border-b border-hairline-strong"],
    ["border-t border-b"],
    ["px-2 py-1"],
    ["w-4 h-4 min-w-0 max-w-full"],
    ["gap-x-2 gap-y-1"],
    ["flex flex-col flex-1 flex-wrap"],
    ["truncate whitespace-normal"],
    ["overflow-x-auto overflow-y-hidden"],
    ["table-auto table"],
    ["grid grid-cols-3 grid-flow-col"],
    ["leading-4 text-data"],
    ["bg-surface-2 bg-clip-padding"],
    ["bg-cover bg-center bg-no-repeat bg-surface-3"],
    ["bg-left-top bg-buy-tint"],
    ["justify-between justify-items-center justify-self-end"],
  ])("%s", (s) => {
    expect(cn(s)).toBe(s);
  });
});

describe("cn variants and important", () => {
  test("variant chains are separate groups", () => {
    expect(cn("bg-surface-1 hover:bg-surface-2")).toBe("bg-surface-1 hover:bg-surface-2");
    expect(cn("hover:bg-surface-2", "hover:bg-surface-3")).toBe("hover:bg-surface-3");
    expect(cn("md:px-2", "px-3")).toBe("md:px-2 px-3");
    expect(cn("max-md:hidden md:flex", "max-md:flex")).toBe("md:flex max-md:flex");
    expect(cn("group-hover:opacity-100", "group-hover:opacity-50")).toBe("group-hover:opacity-50");
    expect(cn("group-hover/row:opacity-100 opacity-0")).toBe("group-hover/row:opacity-100 opacity-0");
    expect(cn("md:hover:text-fg-1", "md:hover:text-fg-2")).toBe("md:hover:text-fg-2");
    expect(cn("hover:md:text-fg-1 md:hover:text-fg-2")).toBe("hover:md:text-fg-1 md:hover:text-fg-2");
  });

  test("arbitrary variants with colons", () => {
    expect(cn("[&>svg]:size-3", "[&>svg]:size-4")).toBe("[&>svg]:size-4");
    expect(cn("[&:hover]:bg-surface-2 bg-surface-1")).toBe("[&:hover]:bg-surface-2 bg-surface-1");
    expect(cn("data-[state=open]:bg-surface-2", "data-[state=open]:bg-surface-3")).toBe("data-[state=open]:bg-surface-3");
  });

  test("important is its own key", () => {
    expect(cn("p-2!", "p-3")).toBe("p-2! p-3");
    expect(cn("p-2!", "p-3!")).toBe("p-3!");
    expect(cn("!p-2", "p-3!")).toBe("p-3!");
  });
});

describe("cn cross-group conflicts", () => {
  test("shorthands override earlier longhands only", () => {
    expect(cn("px-2 pt-1", "p-3")).toBe("p-3");
    expect(cn("p-3", "px-2")).toBe("p-3 px-2");
    expect(cn("pl-1 pr-1", "px-2")).toBe("px-2");
    expect(cn("mt-2 mb-1", "my-0")).toBe("my-0");
    expect(cn("gap-x-2", "gap-1")).toBe("gap-1");
    expect(cn("gap-1", "gap-x-2")).toBe("gap-1 gap-x-2");
    expect(cn("w-4 h-4", "size-5")).toBe("size-5");
    expect(cn("top-0 left-0", "inset-0")).toBe("inset-0");
    expect(cn("rounded-t-sm", "rounded-md")).toBe("rounded-md");
    expect(cn("overflow-x-auto", "overflow-hidden")).toBe("overflow-hidden");
    expect(cn("border-t-2", "border")).toBe("border");
  });
});

describe("classGroup", () => {
  test("text sizes vs colours vs alignment", () => {
    for (const s of ["micro", "label", "data", "body", "amount", "heading", "title"]) expect(classGroup(`text-${s}`)).toBe("fs");
    expect(classGroup("text-display-1")).toBe("fs");
    expect(classGroup("text-display-2")).toBe("fs");
    expect(classGroup("text-[13px]")).toBe("fs");
    expect(classGroup("text-[length:var(--x)]")).toBe("fs");
    for (const c of ["fg-1", "fg-4", "buy", "sell", "warn", "info", "ink", "accent", "risk-low"])
      expect(classGroup(`text-${c}`)).toBe("tc");
    expect(classGroup("text-fg-1/60")).toBe("tc");
    expect(classGroup("text-center")).toBe("ta");
  });

  test("border width vs colour vs style", () => {
    expect(classGroup("border")).toBe("bw");
    expect(classGroup("border-2")).toBe("bw");
    expect(classGroup("border-[1.5px]")).toBe("bw");
    expect(classGroup("border-t")).toBe("bw-t");
    expect(classGroup("border-hairline")).toBe("bc");
    expect(classGroup("border-l-sell-edge")).toBe("bc-l");
    expect(classGroup("border-dashed")).toBe("bs");
  });

  test("unknown and prototype names", () => {
    expect(classGroup("constructor")).toBeNull();
    expect(classGroup("toString")).toBeNull();
    expect(classGroup("pointer-events-none")).toBe("pev");
    expect(classGroup("sr-only")).toBeNull();
    expect(cn("constructor", "toString")).toBe("constructor toString");
  });
});
