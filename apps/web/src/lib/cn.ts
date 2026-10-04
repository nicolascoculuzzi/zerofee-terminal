/*
 * cn(): joins class names and resolves Tailwind conflicts so a later class wins over an earlier
 * one in the same group ("gap-2 … gap-1.5" keeps only gap-1.5). A small local take on
 * tailwind-merge that knows the groups this codebase uses (index.css @theme). Conflict keys
 * include the variant chain ("md:", "hover:", "group-hover/row:") and the important flag, so
 * "hover:bg-x" never removes "bg-y". Unknown classes are always kept. Results are cached by the
 * joined input string because rows call this on every render.
 */

type Resolver = string | ((v: string) => string | null);

const SIZES = new Set("micro label data body amount heading title display-1 display-2".split(" "));
const ALIGN = new Set("left center right justify start end".split(" "));
const LENGTH_ARB = /^[[(](length:|\d|\.\d|calc|clamp|min\(|max\()/;
const NUMERIC = /^\d+(\.\d+)?$/;
const WS = /\s+/;
const BG_OTHER =
  /^(none|linear|radial|cover|contain|auto|fixed|local|scroll|center|top|bottom|left|right|repeat|no-repeat|origin|clip|blend|\[url)/;

// Utility prefix -> conflict group. Prototype-free so "constructor" etc. stay unknown.
const R: Record<string, Resolver> = Object.create(null);
const def = (keys: string, r?: Resolver) => {
  for (const k of keys.split(" ")) R[k] = r ?? k;
};
const flag = (keys: string, g: string) => def(keys, (v) => (v ? null : g));
const SIDES = "x y t r b l s e".split(" ");
const CORNERS = "t r b l s e tl tr br bl".split(" ");

def(
  "gap gap-x gap-y w min-w max-w h min-h max-h size leading tracking opacity shadow cursor select " +
    "transition duration justify justify-items justify-self items self overflow overflow-x " +
    "overflow-y z inset inset-x inset-y top right bottom left start end grid-cols grid-rows " +
    "col-span row-span shrink grow basis order translate-x translate-y rounded",
);
def("icon", "size");
def("flex-shrink", "shrink");
def("flex-grow", "grow");
def("whitespace", "ws");
def("pointer-events", "pev");
flag("block inline-block inline inline-flex grid inline-grid hidden contents table flow-root", "d");
flag("static fixed absolute relative sticky", "pos");
flag("truncate", "tov");
flag("uppercase lowercase capitalize normal-case", "tt");
flag("underline no-underline line-through", "td");
flag("italic not-italic", "fst");
flag("visible invisible", "vis");
def("text", (v) => {
  const b = v.split("/")[0] ?? v;
  if (SIZES.has(b)) return "fs";
  if (ALIGN.has(b)) return "ta";
  if (b === "ellipsis" || b === "clip") return "tov";
  if (b === "wrap" || b === "nowrap" || b === "balance" || b === "pretty") return "tw";
  return LENGTH_ARB.test(b) ? "fs" : "tc";
});
def("font", (v) => (v === "sans" || v === "mono" || v === "serif" || v.startsWith("[family") ? "ff" : "fw"));
// Only background colours conflict here; image, size, position and repeat utilities are kept.
def("bg", (v) => (BG_OTHER.test(v) ? null : "bgc"));
def("flex", (v) =>
  v === ""
    ? "d"
    : v === "row" || v === "col" || v === "row-reverse" || v === "col-reverse"
      ? "fdir"
      : v === "wrap" || v === "nowrap" || v === "wrap-reverse"
        ? "fwrap"
        : "flex",
);
for (const s of ["", ...SIDES]) {
  const side = s && `-${s}`;
  // Border width vs style vs colour, per side.
  R[`border${side}`] = (v) =>
    v === "" || NUMERIC.test(v) || LENGTH_ARB.test(v)
      ? `bw${side}`
      : !s && " solid dashed dotted double none ".includes(` ${v} `)
        ? "bs"
        : `bc${side}`;
  if (s) R[`p${s}`] = `p${s}`;
  if (s) R[`m${s}`] = `m${s}`;
}
def("p m");
for (const c of CORNERS) R[`rounded-${c}`] = `rounded-${c}`;

/** Earlier classes in these groups are also dropped when the key group appears later. */
const CONFLICTS: Record<string, string[]> = Object.create(null);
const conf = (g: string, list: string[]) => {
  CONFLICTS[g] = list;
};
for (const k of ["p", "m", "bw-", "bc-"]) {
  const g = k.replace("-", "");
  conf(
    g,
    SIDES.map((s) => k + s),
  );
  conf(
    `${k}x`,
    ["r", "l", "s", "e"].map((s) => k + s),
  );
  conf(`${k}y`, [`${k}t`, `${k}b`]);
}
conf("gap", ["gap-x", "gap-y"]);
conf("size", ["w", "h"]);
conf("overflow", ["overflow-x", "overflow-y"]);
conf("inset", "inset-x inset-y top right bottom left start end".split(" "));
conf("inset-x", ["right", "left", "start", "end"]);
conf("inset-y", ["top", "bottom"]);
conf(
  "rounded",
  CORNERS.map((c) => `rounded-${c}`),
);

/** Conflict group of a bare utility (variants and "!" already removed), or null if unknown. */
export function classGroup(base: string): string | null {
  let p = base.charCodeAt(0) === 45 ? base.slice(1) : base; // leading "-" (negative values)
  let v = "";
  const a = p.indexOf("-[");
  const b = p.indexOf("-(");
  const cut = a < 0 ? b : b < 0 ? a : Math.min(a, b);
  if (cut > 0) {
    v = p.slice(cut + 1);
    p = p.slice(0, cut);
  }
  for (;;) {
    const r = R[p];
    if (r !== undefined) return typeof r === "string" ? r : r(v);
    const i = p.lastIndexOf("-");
    if (i <= 0) return null;
    v = v ? `${p.slice(i + 1)}-${v}` : p.slice(i + 1);
    p = p.slice(0, i);
  }
}

/** Splits "md:hover:px-2!" into ["md:hover:", "px-2!"], ignoring ":" inside brackets. */
function splitVariant(c: string): number {
  if (c.indexOf("[") < 0 && c.indexOf("(") < 0) return c.lastIndexOf(":") + 1;
  let depth = 0;
  let at = 0;
  for (let i = 0; i < c.length; i++) {
    const ch = c[i];
    if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") depth--;
    else if (ch === ":" && depth === 0) at = i + 1;
  }
  return at;
}

function merge(input: string): string {
  const list = input.split(WS);
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i];
    if (!c) continue;
    const at = splitVariant(c);
    let base = c.slice(at);
    let bang = "";
    if (base.endsWith("!")) {
      base = base.slice(0, -1);
      bang = "!";
    } else if (base.startsWith("!")) {
      base = base.slice(1);
      bang = "!";
    }
    const g = classGroup(base);
    if (g === null) {
      if (!seen.has(c)) out.push(c);
      seen.add(c);
      continue;
    }
    const prefix = c.slice(0, at) + bang;
    const key = prefix + g;
    if (seen.has(key)) continue;
    seen.add(key);
    const more = CONFLICTS[g];
    if (more) for (const m of more) seen.add(prefix + m);
    out.push(c);
  }
  out.reverse();
  return out.join(" ");
}

const CACHE_MAX = 1000;
const cache = new Map<string, string>();

/** Joins class names, skipping falsy values; later Tailwind classes override earlier ones. */
export function cn(...parts: (string | false | null | undefined | 0)[]): string {
  let s = "";
  for (const p of parts) {
    if (!p) continue;
    s = s ? `${s} ${p}` : p;
  }
  if (s.indexOf(" ") < 0 && !WS.test(s)) return s;
  let r = cache.get(s);
  if (r === undefined) {
    r = merge(s);
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(s, r);
  }
  return r;
}

let counter = 0;

/** Short unique id for client-side keys (not cryptographic). */
export function uid(prefix = "id"): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
