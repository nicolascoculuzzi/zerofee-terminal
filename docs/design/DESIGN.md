# zerofee design system

Version 1, 2026-10-03. Scope: `apps/web`, desktop first, mobile PWA second.

This is the spec engineers build against and reviewers check against. Every rule is meant to be verifiable from a screenshot, the DOM or the CSS. If the code disagrees with this document, the document wins until a PR changes it.

- Product and behaviour: [SPEC.md](../../SPEC.md). Axiom reconstruction and earlier Mobbin notes: [mobbin_ui_flows.md](../research_notes/Solana%20trading%20terminal%20teardown/mobbin_ui_flows.md), [axiom_feature_inventory.md](../research_notes/Solana%20trading%20terminal%20teardown/axiom_feature_inventory.md).
- Curated Mobbin references by component: [REFERENCES.md](REFERENCES.md).
- Citation format: `[App, screen](mobbin_url)`, followed by what we borrow. We borrow patterns and proportions, never a logo, wordmark or signature colour. No Mobbin images live in this repo. Pixel sizes quoted from Mobbin captures are estimates scaled from the capture width.

## Contents

0. [North star and the "not AI slop" banned list](#0-north-star)
1. [Principles](#1-principles)
2. [Tokens](#2-tokens)
3. [Data formatting](#3-data-formatting)
4. [Components](#4-components)
5. [Screen blueprints](#5-screen-blueprints)
6. [Interaction and motion rules](#6-interaction-and-motion-rules)
7. [Accessibility](#7-accessibility)
8. [Performance budgets](#8-performance-budgets)
9. [Implementation mapping for apps/web](#9-implementation-mapping-for-appsweb)
10. [Slop check](#10-slop-check)

---

## 0. North star

zerofee should feel like a precision instrument. A trader who glances at it for 300 ms sees three things: what is moving, what is risky, and what they own. Everything else is greyscale. Panels are tiled with hairlines like Coinbase Advanced's order book and kept calm like Linear. Numbers are tabular and never jump. Colour is reserved for buy, sell, risk and focus, and every action can be reached from the keyboard. The UI shows the cost and path of every trade (venue fee, tip, lane, latency, and a platform fee of 0), because "zero fee" is a claim we prove on every fill, not a banner. If a pixel doesn't help someone decide or act faster, it doesn't ship.

### Not AI slop: banned list

Each row is a blocking review finding.

| # | Banned | What it looks like | Do instead | How to check |
|---|---|---|---|---|
| 1 | Purple/blue gradients (all gradients) | Gradient backgrounds, buttons, borders, text, chart fills, avatars (the current `TokenAvatar` uses an HSL `linearGradient`), banner art like [Dropbox Dash's header](https://mobbin.com/screens/3695f322-3bac-43a3-8e96-e589434c3031) | Flat tokens. Chart areas use a single flat 10% tint. | `grep -rn "gradient" src` returns nothing |
| 2 | Glassmorphism | `backdrop-filter`, blurred translucent panels, frosted modals (the current `Modal` uses `backdrop-blur-[2px]`) | Opaque surfaces. Scrim without blur. | `grep -rn "backdrop" src` returns nothing |
| 3 | Neon glows | Coloured `box-shadow`, `text-shadow` or `drop-shadow`; glowing chart lines like the lime line on [OKX's coin page](https://mobbin.com/screens/3b440768-50c7-493d-9718-7921689ece5a) | No coloured shadows. Lines are flat, 1.5 px. | No shadow value uses a non-black colour |
| 4 | Heavy shadows | Blur above 24 px, y-offset above 8 px, alpha above 0.40 (dark) or 0.14 (light); any shadow on a panel or card. The current `--zf-shadow` is `0 12px 40px` at 0.55. | Only `e1` and `e2` (2.6), only on floating layers | Inspect computed `box-shadow` |
| 5 | Radii above 8 px | `rounded-xl` and up (the current `Modal` uses `rounded-xl`, 12 px) | 0, 2, 4, 6, 8 px. Pills (9999 px) only for the elements listed in 2.4. | `grep -rnE "rounded-(xl\|2xl\|3xl\|\[[0-9]{2}px)" src` |
| 6 | Emoji icons | Emoji as UI icons or fallback art (the current `TokenAvatar` falls back to 🐸🐶🚀; search sets a default 👀 on tracked wallets) | lucide icons and monograms (4.22). A wallet emoji the user picked is user data and only appears inside that wallet's avatar. | No emoji code points in `src/` outside fixtures |
| 7 | Decorative illustrations | 3D coins and rockets (the art on [Binance's share poster](https://mobbin.com/screens/fa184fc0-d47a-4ad5-a927-fd920bc4808f)), mascots, empty-state art | Text, plus an optional 16 px icon | Visual review |
| 8 | Airy padding | Panel padding above 12 px, desktop table rows above 32 px, gutters between tiled panels, roomy consumer tables like [Uniswap Tokens](https://mobbin.com/screens/e39f0d0f-bed1-49ff-92e0-c53d36d34de6) (rows around 60 px) | Density tokens (2.10) | Measure in devtools |
| 9 | Centered hero layouts in-app | A big centred headline, subtitle and CTA inside the product, like Uniswap's "Swap anytime, anywhere" ([flow](https://mobbin.com/flows/9aaa402b-0d7a-4960-8261-57602073bb6c)) | Top-left aligned content. Empty states are centred only inside their own panel. | Visual review |
| 10 | Decorative colour | Colour that encodes nothing: brand-coloured launchpad badges (the current `LAUNCHPADS` map), coloured column tops like [Basecamp's card table](https://mobbin.com/screens/52476c45-1afb-415f-826e-6f8ef09182df), rainbow chips, coloured icons | Greyscale chrome. Colour means buy, sell, risk, status or focus, nothing else. | Every coloured pixel maps to a token in 2.1 with a meaning |
| 11 | Inconsistent icon sizes | Icons at 10, 11, 13, 15 or 18 px, mixed stroke widths | 12, 14 and 16 px only, with a 1.5 px absolute stroke (2.11) | `grep -rn "size={" src` values are in {12, 14, 16} |
| 12 | Fake round numbers | Hard-coded demo values such as "$1,000,000", "+100%" or "1.2K holders" in components, docs or screenshots | Real or simulated, irregular data. Missing values show "–". | `grep` for currency literals in `src/components` and `src/features` |
| 13 | Generic card grids | Three or four identical rounded KPI tiles with an icon in the corner, like [Railway's usage tiles](https://mobbin.com/screens/00864e08-5edc-414f-9cea-ab40465e0cb7) | One stat strip with hairline dividers, like [Fey's stats row](https://mobbin.com/screens/7f8ae731-3b5f-42c7-bc83-dd04ecbd04f2) | Visual review |
| 14 | Fallback glyphs | Characters our fonts don't contain: subscript digits U+2080–2089 (the current `fmtSmall` emits them), `◎` (current `SolMark`), `≈ → ▲ ▼ ≥ ≤ ✓ ↵ ∞`, `⌘ ⇧ ⌥`, `𝕏` (current `XGlyph`) | Styled spans, words and SVG icons (2.2) | `grep -rnP "[\x{2080}-\x{2089}\x{25CE}\x{2248}\x{2192}\x{25B2}\x{25BC}\x{2264}\x{2265}\x{2713}\x{21B5}\x{221E}\x{2318}\x{21E7}\x{2325}\x{1D54F}]" src` |
| 15 | Idle or infinite animation | Pulsing live dots (current `.zf-live-dot`), shimmer skeletons, looping anything | Static states. Only an in-flight action may spin. | `grep -rn "infinite" src` matches only the spinner |
| 16 | Toasts for non-events | "Link copied", "Signature copied", "Preset P2 active", "Opened $X from clipboard" | Inline confirmation on the control (icon swap for 1,200 ms) | List of toast call sites |
| 17 | AI tropes | Sparkle icons, "AI analysis" pills, marketing copy, exclamation marks, "Supercharge your trading" | Plain verbs and facts | Copy review |
| 18 | Weak type hygiene | Text below 10 px (current `Tag` and `Kbd` use 9 px), italics, all-caps sentences, a third font family | Type scale in 2.2 | `grep -rn "text-\[9px\]\|italic" src` |

---

## 1. Principles

### 1.1 Colour is data
Chrome is greyscale. Colour appears only when it carries a meaning the trader must act on: side (buy or sell), direction (up or down), risk band, warning, focus.
- Observed: [OKX spot](https://mobbin.com/screens/c3ca83ef-f1de-4703-abbf-aa02ff6fa1ff) runs a black, white and grey interface where green and red appear only in prices and the order book. [Vercel deployments](https://mobbin.com/screens/e9576405-bcef-419a-922a-8fb84b044a54) colour nothing except status dots. [Linear in dark mode](https://mobbin.com/screens/e142df2a-3527-499c-8f81-1b715947ac0c) keeps meta grey and small.
- Rules:
  - The brand accent is neutral ink (`accent` = `text-1`). There is no brand hue in the UI. The logo mark is monochrome.
  - Prices, market caps, volumes and balances render in `text-1` or `text-2`. Only changes, PnL, sides and risk get colour.
  - Low-risk values don't shout: no fill, only a dimmer green value (`risk-low`).

### 1.2 Density with rhythm
Pack information the way pro books do, but on a strict 4 px grid with fixed row heights so the eye can find the next row without searching.
- Observed: [Coinbase Advanced](https://mobbin.com/screens/f8afc154-e5c8-4587-ab43-93c4799a979a) order book rows run about 18–19 px, with hairline-separated panels and no gutters. The [Binance spot](https://mobbin.com/screens/8d1b7823-6418-44c5-b3d5-ab69b3bfd6e3) book and tape sit at about 20 px. [Gemini ActiveTrader](https://mobbin.com/screens/2271e5e3-4a73-4fa3-aad3-24e7bd6e2ad1) fits book, chart and order form in one viewport.
- Rules:
  - Rows are 24 px (compact) or 28 px (comfortable). Tapes are 20 px or 24 px. Pulse cards are 68 px or 80 px.
  - Panels tile edge to edge with a 1 px hairline. Panel padding is 8 px or 12 px.
  - One base text size for data (12 px compact, 13 px comfortable). Hierarchy comes from weight and colour, not size jumps.

### 1.3 Numbers are the interface
Most of the screen is numbers. They are tabular, right-aligned in columns, formatted with fixed significant digits, and their units are dimmed.
- Observed: [Gemini's order book](https://mobbin.com/screens/2271e5e3-4a73-4fa3-aad3-24e7bd6e2ad1) dims trailing zeros in fixed-precision quantities, so decimals align and significant digits stand out. [Kraken Pro](https://mobbin.com/screens/5bdd6cb2-5040-44c4-8781-c70f3aea60a8) dims "USD" suffixes. [OpenSea's token table](https://mobbin.com/screens/a2072a4d-d59f-4b22-92be-ddcc3100db61) uses fixed-width numerals in every column.
- Rules:
  - IBM Plex Sans digits are tabular by default (verified, 2.2), so columns align without `font-feature-settings`.
  - Units ("SOL", "USD") use `text-3` at label size. Trailing zeros in fixed-precision columns use `text-3`.
  - Tiny prices use subscript-zero notation built from spans, never Unicode subscripts (3.3).

### 1.4 Calm under fire
Live data must never make the layout jitter, and the thing under the cursor never moves.
- Observed: [OpenSea](https://mobbin.com/screens/a2072a4d-d59f-4b22-92be-ddcc3100db61) shows a "Paused" state in its status bar for live tables. [Binance Smart Money](https://mobbin.com/screens/37ad2b16-f814-48d2-861a-6f396445f479) shows a visible refresh countdown ("30s"). Canny marks a paused source with a [quiet "Paused" chip](https://mobbin.com/screens/8794989c-4116-4894-9684-2fd8f4761652).
- Rules:
  - Fixed column widths and fixed row heights. A value change never changes layout.
  - Hovering or focusing a Pulse column freezes its order and membership. New items queue behind an "N new" bar (6.7).
  - Flashes are short (600 ms), throttled (at most 2 per second per element), and never used on Pulse cards (6.6).

### 1.5 Keyboard first, never keyboard only
Every action has a key path, a visible hint, and a mouse equivalent.
- Observed: [Fey's command menu](https://mobbin.com/screens/ff52ac90-4d18-4765-98da-df1e362a5ee1) lists actions for the selected ticker with single-key caps. [Linear's menus](https://mobbin.com/screens/14daab5b-7872-456a-8c5a-94f3d9d03a48) show "G then S" style chords next to items. [Obvious's shortcut sheet](https://mobbin.com/screens/d1f418bb-9d1a-40b6-a7b5-7b294ef64703) is searchable and grouped. Axiom's trade hotkeys are Space plus a key ([docs](https://docs.axiom.trade/axiom/swap/instant-trade)).
- Rules:
  - Trade hotkeys always need Space held (prevents accidental fills). Navigation uses single keys and G-chords.
  - Every tooltip on an actionable control ends with its keycaps.
  - `?` opens a searchable sheet that greys out shortcuts that don't apply in the current context.

### 1.6 Show the cost, the path, the proof
Before a trade: what it costs and where it goes. After: what happened and how long each step took.
- Observed: [Uniswap's review](https://mobbin.com/screens/a619a575-5745-4ad8-978c-b25aaaa9bfc5) lists fee, network cost, rate, max slippage, routing and price impact, each with an info icon. [Phantom's swap](https://mobbin.com/screens/65eff589-ab7c-4289-a456-68a161f019c2) says "Quote includes a 0.85% Phantom fee". [Binance's confirm](https://mobbin.com/screens/130eaf2a-8087-470d-961d-f9ac59767838) shows a "No Fees" chip. Phantom pairs an in-progress toast with a past-tense success toast ([opened](https://mobbin.com/screens/c5d3a411-f5d2-4618-bfb4-0eb2abcbf5d4)).
- Rules:
  - The trade panel's cost breakdown always includes the line "Platform fee 0".
  - Transaction toasts show stages (built, signed, sent, landed) with milliseconds, and expand into the full latency breakdown (4.13).

### 1.7 Friction proportional to risk
Routine trades within your caps take one click or key. Risky or irreversible actions get deliberate friction.
- Observed: [Monzo](https://mobbin.com/screens/c73a3c93-eb1e-4c54-80c9-27e68531e9d0) disables "Continue anyway (4s)" behind a countdown. [Phantom's quick sell](https://mobbin.com/screens/3fad6a3a-9806-46de-810b-ed318e331d59) offers "Don't show again". [Kraken](https://mobbin.com/screens/7e080d39-6f61-43d1-8a4d-78ddfa5da1f8) asks for an explicit acknowledgement checkbox on a restriction.
- Rules:
  - No confirmation for market trades within caps.
  - A 3 s countdown confirm for buys of tokens with Token-2022 danger flags or a high-risk band in 3 or more chips.
  - Hold-to-confirm (1,000 ms) for Panic, withdrawals to a new destination and key export.
  - A repeat guard drops an identical trade (same token, side and amount) fired within 600 ms by mouse. Keyboard repeats count only after the key is released (6.4).

---

## 2. Tokens

All values are final. Names map to CSS variables `--zf-<name>` and Tailwind utilities (section 9).

### 2.1 Colour

Built in OKLCH (hue 255 neutrals) and converted to sRGB. Contrast ratios were computed with the WCAG 2.x formula.

#### Core tokens

| Token | Dark (default) | Light | Role |
|---|---|---|---|
| `bg` | `#090A0C` | `#F5F6F7` | App canvas behind tiled panels. Hairline gaps show this colour. |
| `surface-1` | `#0F1113` | `#FFFFFF` | Panels, columns, tables: the default reading surface |
| `surface-2` | `#15171A` | `#F1F2F4` | Panel headers, inputs, popovers, menus and tooltips; row hover |
| `surface-3` | `#1E2124` | `#E6E8EA` | Selected row, active segment, chips, secondary buttons |
| `surface-3-hover` | `#25282C` | `#DDE0E3` | Hover on `surface-3` controls |
| `hairline` | `#232529` | `#DEE0E2` | 1 px separators between panels, header bottoms, grid rows |
| `hairline-strong` | `#32363B` | `#C6C9CD` | Input borders, borders of floating layers |
| `text-1` | `#E9EBEE` | `#13161B` | Primary text and numbers |
| `text-2` | `#B2B6BC` | `#494D54` | Secondary values, dense body copy |
| `text-3` | `#858A90` | `#5F646A` | Labels, units, column headers, timestamps, icons at rest |
| `text-4` | `#5A5E64` | `#94999E` | Disabled text, placeholders, "–" for unknown (exempt from contrast) |
| `accent` | `#E9EBEE` | `#13161B` | Neutral ink accent: primary button fill, active tab bar, switch on, slider fill, selection bar |
| `accent-hover` | `#F9FAFB` | `#2A2E34` | Hover on accent fills |
| `accent-press` | `#CED1D5` | `#040609` | Pressed accent fills |
| `ink` | `#090A0C` | `#FFFFFF` | Text and icons on `accent`, `buy` and `sell` solid fills |
| `focus` | `#75AEF5` | `#145EC1` | Focus ring only |
| `buy` | `#3DCA8D` | `#00774C` | Buy side, positive change, profit |
| `buy-hover` | `#4ED799` | `#00673F` | Hover on buy fills |
| `buy-press` | `#23BA7D` | `#005734` | Pressed buy fills |
| `sell` | `#FA6B6D` | `#BA2B2E` | Sell side, negative change, loss, errors |
| `sell-hover` | `#FF7A7B` | `#A71922` | Hover on sell fills |
| `sell-press` | `#E85B5E` | `#920917` | Pressed sell fills |
| `warn` | `#F3B743` | `#8F5805` | Warnings, mid-risk values, stale data, Fast-lane notice |
| `info` | `#73B0EE` | `#125FB3` | Informational notes, the tracked-wallet tag |
| `risk-low` | `#71B28F` | `#307252` | Low-risk chip values (dimmer than `buy` on purpose) |
| `risk-mid` | = `warn` | = `warn` | Mid-risk chip values |
| `risk-high` | = `sell` | = `sell` | High-risk chip values |

#### Measured contrast

| Foreground | Dark on surface-1 | Dark on surface-3 | Light on surface-1 | Light on surface-3 |
|---|---|---|---|---|
| `text-1` | 15.84 | 13.54 | 18.13 | 14.76 |
| `text-2` | 9.29 | 7.94 | 8.49 | 6.91 |
| `text-3` | 5.44 | 4.65 | 5.97 | 4.86 |
| `buy` | 9.04 | 7.73 | 5.61 | 4.57 |
| `sell` | 6.66 | 5.69 | 6.05 | 4.92 |
| `warn` | 10.51 | 8.99 | 5.89 | 4.79 |
| `info` | 8.27 | 7.07 | 6.34 | 5.16 |
| `risk-low` | 7.63 | 6.52 | 5.75 | 4.68 |
| `focus` (non-text, needs 3:1) | 8.23 | 7.03 | 6.17 | 5.03 |
| `ink` on `buy` fill | 9.46 | n/a | 5.61 | n/a |
| `ink` on `sell` fill | 6.97 | n/a | 6.05 | n/a |

Consequences:
- Solid buy and sell buttons use `ink` text. White on the dark-theme `sell` fill is only 2.84:1 and fails.
- `text-3` on `surface-3-hover` is 4.15:1 in dark, so labels inside a hovered chip or button switch to `text-2`.
- `text-4` is never used for information a user needs.

#### Derived tokens

| Token | Dark | Light | Definition and use |
|---|---|---|---|
| `buy-tint`, `sell-tint`, `warn-tint`, `info-tint`, `risk-low-tint` | 14% | 8% | `color-mix(in srgb, <token> N%, transparent)`. Chip and tinted-button fills. Over `surface-1` dark these resolve to buy `#152B24`, sell `#301E20`, warn `#2F281A`, info `#1D2732`, risk-low `#1D2824`; light to buy `#EBF4F1`, sell `#F9EEEE`, warn `#F6F2EB`, info `#ECF2F9`, risk-low `#EEF4F1`. Text on its own tint measures 5.0:1 or better everywhere (dark: buy 7.15, sell 5.55, warn 8.10, risk-low 6.13, info 6.61; light: buy 5.01, sell 5.32, warn 5.28, risk-low 5.16, info 5.62). |
| `buy-edge`, `sell-edge`, `warn-edge` | 32% | 28% | Same mix. 1 px borders of tinted buttons and high-risk chips. |
| `flash-buy`, `flash-sell` | 18% | 14% | Start colour of a value-change flash (dark buy `#173229`, sell `#392123` over `surface-1`) |
| `bar-buy`, `bar-sell` | 10% | 10% | Trade-size bars and depth bars (dark `#14241F` / `#271A1C`, light `#E6F1ED` / `#F8EAEA`) |
| `highlight` | `text-1` 6% | `text-1` 5% | Start colour of the new-row highlight (dark `#1C1E20`) |
| `scrim` | `rgb(0 0 0 / 0.56)` | `rgb(19 22 27 / 0.32)` | Behind modals, drawers and the palette. Never blurred. |

#### Chart tokens

| Token | Dark | Light | Use |
|---|---|---|---|
| `chart-bg` | = `surface-1` | = `surface-1` | Canvas |
| `chart-grid` | `#16181B` | `#EEF0F2` | Grid lines (quieter than `hairline`) |
| `chart-axis` | = `hairline` | = `hairline` | Axis borders |
| `chart-text` | = `text-3` | = `text-3` | Axis labels, 11 px |
| `chart-crosshair` | = `text-3` | = `text-3` | 1 px dashed (4 4) |
| `candle-up`, `candle-down` | = `buy`, `sell` | = `buy`, `sell` | Bodies and wicks |
| `volume-up`, `volume-down` | `buy` 35%, `sell` 35% | `buy` 30%, `sell` 30% | Volume histogram |
| `line-self` | = `text-1` at 80% | = `text-1` at 80% | Your average entry: 1 px, dashed 4 3 |
| `line-limit-buy`, `line-tp` | = `buy` | = `buy` | Order lines, solid 1 px |
| `line-limit-sell`, `line-sl` | = `sell` | = `sell` | Order lines, solid 1 px |
| `line-migration` | = `text-3` | = `text-3` | Dotted 1 3 |

#### Colour-vision palette

Settings > Display > Colour vision: "Default (green/red)" or "Blue/orange". Blue/orange swaps these tokens:

| Token | Dark | Light | Measured |
|---|---|---|---|
| `buy` | `#60AAF3` | `#125FB3` | 7.70 (dark, s1), 6.34 (light, s1), 5.16 (light, s3) |
| `sell` | `#F59740` | `#A14C00` | 8.45 (dark, s1), 5.92 (light, s1), 4.82 (light, s3) |
| `risk-low` | = `text-2` | = `text-2` | Low risk turns neutral |
| `risk-high` | = new `sell` | = new `sell` | High-risk chips also get a 1 px `sell-edge` border and a 600-weight value, so they never rely on hue against amber |

Why: under simulated deuteranopia (Machado 2009) the default buy and sell collapse to near-identical olive tones (RGB distance 40, luminance ratio 1.11). Blue and orange stay 197 apart.

Colour never carries meaning alone, in any palette. Side is also written ("B"/"S", "Buy"/"Sell"), direction also signed ("+"/"−"), and risk also numeric.

#### Where colour may appear

1. `buy`/`sell`: side cells, signed changes and PnL, solid trade CTAs, tinted trade buttons, candles, order lines, value flashes, size bars.
2. `risk-*`: risk chip values and fills; risk numbers in the token info grid.
3. `warn`: warning text and icons, stale-data marks, the Fast landing preset, the "Simulated data" badge.
4. `info`: informational icons, the "TRK" tag, links inside long-form help.
5. `focus`: the focus ring only.
6. Monogram fills (4.22): muted identity colours, chroma 0.05 or less.

Nothing else is coloured.

### 2.2 Typography

#### Families

| Role | Family | Package (pinned) | Licence | First-load bytes |
|---|---|---|---|---|
| UI text and all numbers | IBM Plex Sans Variable (wght 100–700, wdth 75–100) | `@fontsource-variable/ibm-plex-sans@5.3.0`, entry `standard.css` | SIL OFL 1.1, "Copyright 2019 IBM Corp." (checked in the package `LICENSE` and `metadata.json`) | 64.0 KB (latin woff2). latin-ext loads only when needed, via `unicode-range`. |
| Addresses, signatures, keys, keycaps, the SIWS message | IBM Plex Mono 400 and 500 | `@fontsource/ibm-plex-mono@5.3.0`, entries `400.css` and `500.css` | SIL OFL 1.1, "Copyright 2017 IBM Corp." | 14.4 KB + 14.5 KB |

Total font bytes on first load: 92.9 KB. Family names: `"IBM Plex Sans Variable"` and `"IBM Plex Mono"`.

Why Plex (verified by parsing the shipped woff2 files):
- Tabular digits by default. Every digit 0–9 in the Fontsource Plex Sans build has an advance of 600/1000 em. Numbers align in columns without `font-feature-settings`. The Inter and Mona Sans builds are proportional by default (Inter's digit advances range from 833 to 1323 per 2048 em).
- Fontsource builds come from Google Fonts and strip optional OpenType features. Inter's build has `tnum` but no `zero`, `ss01`, `cv11` or `case`. Plex Sans has no `tnum` or `zero` at all. So we never use `font-feature-settings`, and anything that would need a feature is designed out.
- The `wdth` axis (75–100) gives dense cells a slightly condensed setting (`font-stretch: 92%`) without loading a second family.
- It isn't Inter or Geist, the two defaults of generated UIs. Plex reads as an engineered data terminal without a custom licence.

Plex is open source and not any trading product's brand asset. We use it unmodified. OFL forbids selling the font on its own, not shipping it in an app; the licence text goes in `apps/web/NOTICE` (9.4).

#### Glyph coverage

Checked against the latin subset files we ship.

| Character | Plex Sans latin | Plex Mono latin | Rule |
|---|---|---|---|
| Subscript digits ₀–₉ (U+2080–2089) | missing | missing | Never output them. Render the zero count as a span with regular digits (3.3). |
| Minus − (U+2212) | present | present | Use for all negatives |
| Thin space (U+2009) | present | missing | Sans text only, between a value and its unit |
| Ellipsis … (U+2026) | present | present | Use for truncation |
| ↑ ↓ (U+2191, U+2193) | present | present | Allowed |
| → (U+2192), ≈ (U+2248), ◎ (U+25CE) | missing | missing | lucide `ArrowRight`; "~" for approximate; `SolGlyph` SVG |
| ▲ ▼ (U+25B2, U+25BC) | missing | missing | Use ↑ ↓ (present) or lucide `ArrowUp`/`ArrowDown` |
| ≥ ≤ (U+2265, U+2264) | missing | missing | Write it out in UI strings: "MC above 120K", "Red: 35% or more" |
| ✓ (U+2713), ∞ (U+221E), ↵ (U+21B5) | missing | missing | lucide `Check`; never show infinity; Enter keycap reads "Enter" or uses lucide `CornerDownLeft` |
| × · – • ± € | present | present | Allowed |
| ⌘ ⇧ ⌥ | missing | missing | Keycaps use lucide `Command`, `ArrowBigUp`, `Option` on macOS, and "Ctrl", "Shift", "Alt" text elsewhere |
| 𝕏 (U+1D54F) | missing | missing | Write the letter "X" in Plex Sans 600 |

Solana addresses are base58, which excludes 0, O, I and l. Address legibility doesn't depend on a slashed zero.

This document uses ≥, ≤, → and ⌘ for brevity in prose and tables. Strings that reach the UI follow the table above. Where a UI example below contains → or ⌘, it renders as the lucide icon.

#### Type scale

| Token | Size / line height | Weight | Tracking | Use |
|---|---|---|---|---|
| `display-1` | 28 / 32 px | 600 | −0.01em | Portfolio balance (one per screen) |
| `display-2` | 20 / 24 px | 600 | −0.005em | Token header market cap; mobile price block |
| `title` | 16 / 22 px | 600 | 0 | Onboarding step titles |
| `heading` | 14 / 20 px | 600 | 0 | Modal and drawer titles, page header labels |
| `body` | 13 / 18 px | 400 | 0 | Prose, toasts, form labels, settings rows |
| `data` | 12 / 16 px | 400, 500, 600 | 0 | Table cells, card values, control text, menu items |
| `label` | 11 / 14 px | 500 | 0.01em | Column headers, stat labels, chip values, helper text |
| `micro` | 10 / 12 px | 500 | 0.02em | Risk-chip letters, tags, keycaps, axis labels, badges |

Comfortable density raises `data` to 13/18 and `label` to 12/16. Nothing else changes.

Rules:
- Weights are 400, 500 and 600 only. No 700 anywhere, including the logo.
- Sentence case everywhere. Uppercase only for micro tags (YOU, DEV, TRK), risk-chip letters, and group labels in menus and the palette (10 px, 600, +0.06em).
- No italics. No underlines except links on hover and dotted metric-label underlines (4.14).
- Mono only for: addresses, signatures, hashes, keys, the SIWS message, keycaps, and latency figures inside the breakdown.
- `font-stretch: 92%` only for tape cells and Pulse card metrics in compact density (token `--zf-num-stretch`). Everywhere else 100%.
- Prose lines max 72ch.

### 2.3 Spacing

4 px grid. Allowed values: 0, 4, 8, 12, 16, 20, 24, 32, 40, 48 px. The 2 px value is allowed only inside chips and keycaps (vertical padding, icon-to-text gap).

| Context | Compact | Comfortable |
|---|---|---|
| Panel inner padding | 8 | 12 |
| Gap inside a control group (icon to label, chip to chip) | 4 | 4 |
| Gap between control groups | 8 | 12 |
| Gap between sections in a scrolling panel | 16 | 16 |
| Modal and drawer padding | 16 | 16 |
| Page side gutter, mobile only | 12 | 12 |
| Between tiled desktop panels | 0 (1 px hairline) | 0 (1 px hairline) |

### 2.4 Radii

| Token | Value | Used for |
|---|---|---|
| `radius-0` | 0 | Tiled panels, columns, tables, the chart, the top bar, the status bar |
| `radius-xs` | 2 px | Chips, tags, keycaps, risk chips, skeleton bars |
| `radius-sm` | 4 px | Buttons, inputs, segmented controls, menu items, token avatars (square) |
| `radius-md` | 6 px | Popovers, menus, tooltips, toasts, the Instant Trade window, docks |
| `radius-lg` | 8 px | Modals, the command palette, the share card |
| `radius-full` | 9999 px | Only: the Pulse quick-buy pill, switch track and knob, status dots, wallet avatars (circles), count badges |

Drawers have 0 radius (they meet the viewport edge).

### 2.5 Borders

- 1 px `hairline`: between tiled panels (use a hairline-coloured parent with `gap: 1px`, so adjacent panels never draw double borders), under panel headers, between rows of data grids (4.9).
- 1 px `hairline-strong`: inputs, popovers, menus, tooltips, toasts, modals, floating windows.
- 2 px: focus ring (outline), the active-tab underline, the selection bar on the left edge of the keyboard-cursor row, the stage bar in toasts.
- Nothing thicker than 2 px. No dashed borders except chart lines and the drop zone in import dialogs.

### 2.6 Elevation

| Level | Dark | Light | Used for |
|---|---|---|---|
| `e0` | none | none | Panels, cards, tables |
| `e1` | `0 2px 8px rgb(0 0 0 / 0.32)` | `0 2px 8px rgb(16 22 30 / 0.10)` | Menus, popovers, tooltips, select lists |
| `e2` | `0 8px 24px rgb(0 0 0 / 0.40)` | `0 8px 24px rgb(16 22 30 / 0.14)` | Modals, drawers, the palette, toasts, the Instant Trade window, docks |

Every elevated layer also gets a 1 px `hairline-strong` border; in dark mode the border, not the shadow, separates the layers. Floating layers use `surface-2` in dark and `surface-1` in light.

### 2.7 Z-index

| Token | Value | Layer |
|---|---|---|
| `z-base` | 0 | Page content |
| `z-sticky` | 10 | Sticky table and column headers |
| `z-chart-ui` | 20 | Chart labels, order-line handles |
| `z-dock` | 300 | Instant Trade window, tracker and social docks |
| `z-popover` | 400 | Menus, popovers, select lists |
| `z-drawer` | 500 | Drawers |
| `z-modal` | 600 | Modals |
| `z-palette` | 700 | Command palette |
| `z-toast` | 800 | Toasts (above modals: a fill can land while a modal is open) |
| `z-tooltip` | 900 | Tooltips |

A popover or menu opened inside a modal, drawer or palette takes the parent's z-index + 10, so it never renders behind its parent. The current code (`tooltip 200`, `toast 180`, `popover 150`, `modal 120`, `drawer 110`) is replaced by this scale.

### 2.8 Motion

| Token | Value | Use |
|---|---|---|
| `dur-1` | 80 ms | Hover colour changes |
| `dur-2` | 140 ms | Press feedback, toggles, menu and popover enter |
| `dur-3` | 200 ms | Modal, drawer and toast enter |
| `dur-flash` | 600 ms | Value-change flash fade-out |
| `dur-highlight` | 1,200 ms | New-row highlight fade-out |
| `ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | Enters and colour fades |
| `ease-exit` | `cubic-bezier(0.4, 0, 1, 1)` | Exits |

Rules:
- Exits take two-thirds of the enter duration (modal exit 130 ms, menu exit 90 ms).
- Animate only `opacity`, `transform` and colour. Never animate width, height, top or left on live data.
- Enter motion is opacity plus at most a 4 px translate (modals and popovers) or a 16 px slide (drawers, toasts). No scale, bounce or spring.
- `prefers-reduced-motion: reduce`: all durations go to 0 ms except opacity fades, which are capped at 80 ms. Flashes and highlights are replaced by static indicators (6.6). Spinners become an elapsed-time label.

### 2.9 Breakpoints

| Name | Min width | Layout |
|---|---|---|
| base | 0 | Mobile: one column, bottom tabs, sticky trade bar |
| `sm` | 640 px | Mobile layout, wider gutters |
| `md` | 768 px | Tablet: Pulse in 2 columns (third via tab); token page stacked (chart, trade panel, tables) |
| `lg` | 1024 px | Desktop compact: Pulse in 3 columns; token page with a 288 px right rail; token info as a table tab |
| `xl` | 1280 px | Right rail 300 px |
| `2xl` | 1440 px | Reference design. Right rail 320 px. |
| `3xl` | 1920 px | Pulse cards gain an extra metric column and mini chart (4.4) |

Tailwind v4 overrides: `--breakpoint-2xl: 90rem`, `--breakpoint-3xl: 120rem` (section 9).

### 2.10 Density modes

`<html data-density="compact">` is the default at 1024 px and up with a fine pointer. `comfortable` is the default with a coarse pointer, and users can switch in Settings > Display or with `T then D`.

| Token | Compact | Comfortable |
|---|---|---|
| `--zf-row` (data grids, lists) | 24 px | 28 px |
| `--zf-row-dense` (tapes, live feeds) | 20 px | 24 px |
| `--zf-header-row` (table headers) | 28 px | 32 px |
| `--zf-card` (Pulse card, incl. 1 px divider) | 68 px | 80 px |
| `--zf-card-avatar` | 40 px | 48 px |
| `--zf-control` (default control height) | 24 px | 28 px |
| `--zf-topbar` | 40 px | 44 px |
| `--zf-panel-header` (tab bars, panel titles) | 32 px | 36 px |
| `--zf-col-header` (Pulse column header) | 36 px | 40 px |
| `--zf-pad` (panel padding) | 8 px | 12 px |
| `--zf-font-data` / line height | 12 / 16 px | 13 / 18 px |
| `--zf-font-label` / line height | 11 / 14 px | 12 / 16 px |
| `--zf-num-stretch` | 92% | 100% |
| `--zf-statusbar` | 24 px | 24 px |

Mobile (below 768 px) ignores these and uses touch sizes: 44 px minimum targets, 64 px list rows, 16 px inputs so iOS doesn't zoom.

### 2.11 Icons and imagery

- Library: `lucide-react` only, named imports (tree-shaken).
- Sizes: 12 px (inline in data and chips), 14 px (controls, menus, buttons), 16 px (top bar, modal close, empty states).
- Stroke: `strokeWidth={1.5}` with `absoluteStrokeWidth`, so every icon has a 1.5 px stroke at any size.
- Colour: `currentColor`. `text-3` at rest, `text-1` on hover or when active. Coloured icons only for status (warn triangle, failed X) and side arrows.
- No brand logos (X, Telegram, launchpads). X links show the letter "X" in Plex Sans 600; Telegram uses `Send`; websites use `Globe`. The one exception: in the connect step, wallets show the icon they supply through Wallet Standard, so users can recognise their own wallet.
- An icon alone is allowed only with a tooltip and an `aria-label`. Destructive actions always carry a text label.
- Token images: real images (proxied) render in a 4 px-radius square with a 1 px inner `hairline`. Missing images use monograms (4.22), never generated art.

---

## 3. Data formatting

### 3.1 General rules

- One formatter module (`src/lib/format.ts`) and one `<Num>` component (9.4) produce every number. Components never call `toFixed` or `toLocaleString` directly (check with `grep`).
- Locale is fixed to en-US: comma thousands separator, dot decimal. Screenshots and share cards look the same for everyone.
- Every formatted value carries a plain-text form for `aria-label`, `title` and the clipboard: full-precision decimal, no K/M suffix, no subscript.
- Unknown or missing values show "–" (en dash) in `text-4`. Never "0" for unknown, and never "NaN", "Infinity", "undefined" or "null".
- Negative numbers use U+2212 "−", not a hyphen.

### 3.2 USD

**Compact** (market cap, liquidity, volume, USD fees, holder value):
- 3 significant digits, keeping trailing zeros. Suffixes K (1e3), M (1e6), B (1e9), T (1e12).
- Below $1,000: 3 significant digits with at most 2 decimals. Below $0.01: "<$0.01".
- Round before choosing the suffix. $999,950 shows "$1.00M", never "$1000K".

| Raw | Display |
|---|---|
| 0.004 | <$0.01 |
| 8.4237 | $8.42 |
| 842.4 | $842 |
| 12,345 | $12.3K |
| 120,050 | $120K |
| 999,950 | $1.00M |
| 1,240,000 | $1.24M |
| 12,400,000 | $12.4M |

**Exact** (balances, PnL, trade totals): 2 decimals with thousands separators up to $99,999.99, compact from $100,000. Examples: "$3,812.40", "−$12.08", "$148.20", "$124K".

Changes and PnL always carry a sign: "+$12.08", "−$3.10".

### 3.3 Prices per token

| Range | Rule | Example |
|---|---|---|
| p ≥ 1,000 | 2 decimals, separators | $1,234.50 |
| 1 ≤ p < 1,000 | 4 significant digits, at least 2 decimals | $1.234, $12.35, $123.40 |
| 0.0001 ≤ p < 1 | 4 significant digits | $0.01235, $0.0001235 |
| p < 0.0001 (4 or more zeros after the decimal point) | Subscript-zero notation: "0.0", then the zero count as a span, then 4 significant digits (trailing zeros kept) | 0.000004123 shows as `0.0₅4123`; 0.00000002796 as `0.0₇2796`; 0.0000041 as `0.0₅4100` |

The subscript is the number of zeros after the decimal point (0.000004123 has five).

Rendering (fonts have no subscript glyphs, see 2.2):

```html
<span class="zf-num" aria-label="0.000004123">0.0<span class="zf-zc" aria-hidden="true">5</span>4123</span>
```

```css
.zf-zc { font-size: 0.72em; line-height: 0; vertical-align: -0.28em; margin: 0 0.06em; }
```

Prices in SOL follow the same rules without "$". On cards and charts, market cap is the primary number. Price appears in tooltips and the second line of the token header.

### 3.4 SOL amounts

The unit is a " SOL" suffix in `text-3` at label size in forms, toasts and detail rows. In tight cells (Pulse pill, Instant Trade buttons, tapes) the unit is omitted and stated in the column header or tooltip. Where neither fits (the top-bar balance), a 12 px `SolGlyph` SVG prefix is allowed.

| Magnitude | Decimals | Examples |
|---|---|---|
| ≥ 10,000 | compact, 3 significant digits | 12.3K |
| 1,000–9,999.9 | 1, with separator | 1,234.5 |
| 100–999.99 | 2 | 123.45 |
| 1–99.999 | up to 3, trailing zeros trimmed to a minimum of 2 | 1.25, 12.346 |
| 0.01–0.9999 | up to 4, trimmed to a minimum of 2 | 0.50, 0.0125, 0.2512 |
| 0.0001–0.009999 | up to 6, trimmed | 0.000312, 0.005 |
| < 0.0001 | "<0.0001" | <0.0001 |

- **Tape columns** (fixed precision): exactly 3 decimals with trailing zeros in `text-3`. 0.5 renders "0.5" in the side colour followed by "00" in `text-3`. Below 0.001: "<0.001".
- **Fees, tips and rent:** up to 9 decimals, trailing zeros trimmed, never compact or subscript: "0.000005", "0.0001", "0.00106". The tooltip adds lamports ("5,000 lamports").
- **User-entered amounts** (presets, quick-buy) display exactly as entered, normalised: "0.25", "1", "0.05".

### 3.5 Percentages

| Range | Format | Examples |
|---|---|---|
| \|x\| < 1 | 2 decimals | 0.42% |
| 1 ≤ \|x\| < 100 | 1 decimal | 12.3%, 99.9% |
| 100 ≤ \|x\| < 10,000 | 0 decimals, separators | 248%, 1,234% |
| ≥ 10,000 | compact | 12.3K% |

- Changes and PnL are always signed (+/−). Zero is "0.00%" in `text-3`, unsigned.
- Supply shares (holders, top 10, dev) are unsigned.
- Risk chips: an integer from 10 up, 1 decimal below 10, "<0.1%" for tiny non-zero values, "0%" for zero. So "18%", "4.5%".
- PnL % with a zero or unknown cost basis shows "–", never "+Infinity%" (keep the current `fmtPnlPct` behaviour).
- Bonding progress: an integer ("87%"). At 100% it reads "Migrating" until the pool exists.

### 3.6 Counts

Below 10,000: an integer with separators ("1,234"). From 10,000: compact with 3 significant digits ("12.3K").

### 3.7 Ages and times

| Elapsed | Format | Re-render cadence |
|---|---|---|
| < 60 s | `12s` | every 1 s |
| < 60 min | `4m` | at each minute boundary |
| < 24 h | `3h` | at each hour boundary |
| < 30 d | `2d` | at each day boundary |
| < 365 d | `5mo` | daily |
| ≥ 365 d | `1y` | daily |

- One shared 1 Hz clock. Each row computes when its label next changes and subscribes only until then. No per-row `setInterval` (check with `grep`).
- Width: ages reserve 4ch. In tapes they are right-aligned; on cards, left-aligned.
- Colour: `text-2`. Younger than 60 s: `text-1`.
- Absolute times: 24-hour `14:32:05` in tooltips and expanded rows. Dates are "Oct 3", or "Oct 3, 2025" outside the current year.

### 3.8 Addresses and signatures

- Default truncation is head 4, ellipsis, tail 4: `7xKX…sAsU`.
- Mints ending in "pump" (pump.fun vanity addresses) show head 6 and the literal tail: `9Hd4cZ…pump`. The tail "pump" identifies nothing, so we spend the characters on the head.
- Signatures: head 4, tail 4.
- Mono font, `text-2`. Clicking copies; the icon swaps to a check for 1,200 ms. No toast.
- The tooltip shows the full string in mono, 11 px, `word-break: break-all`.
- Known wallets show their label instead of the address: YOU, DEV, a user label (at most 16 characters, then an ellipsis), with the address in the tooltip.

### 3.9 USD/SOL toggle

- One global `quote` setting (USD by default). It changes market cap, liquidity, volume, values and PnL. Amounts the user enters are always in SOL.
- Toggle from the status bar chip or `T then C`.
- SOL values follow 3.4 (`SolGlyph` prefix in compact cells, " SOL" suffix elsewhere).
- Conversion uses the live SOL/USD shown in the status bar. If that price is older than 60 s, USD values render in `text-3` and the status bar shows "SOL/USD stale 64s" in `warn`.

### 3.10 Sign and colour rules

| Quantity | Positive | Negative | Zero | Unknown |
|---|---|---|---|---|
| Price or market-cap change, PnL (absolute and %) | `buy`, "+" | `sell`, "−" | `text-3`, "0.00%" or "$0.00" | `text-4` "–" |
| Trade side in tapes | "B" and the SOL amount in `buy` | "S" and the SOL amount in `sell` | n/a | n/a |
| Prices, market caps, volumes, balances, counts | `text-1` / `text-2`; never coloured except the 600 ms flash in the token header | | | |
| Fees and tips | Always `text-2`. Fees are not good or bad. | | | |
| "Platform fee 0" | `text-1` | | | |

Never colour a whole row. Never use red or green for neutral facts. Direction arrows (↑ ↓) appear only on mobile change values, and always next to the sign.

### 3.11 Risk chip thresholds

Bands are evaluated on the displayed (rounded) value, so a chip reading "20%" is always amber, never green. The definitions are the published ones in SPEC.md. Users can override thresholds in Settings > Display; the tooltip always shows the active bands.

| Metric (chip letter) | Low: `risk-low`, no fill | Mid: `risk-mid` + `warn-tint` fill | High: `risk-high` + `sell-tint` fill + 1 px `sell-edge` border | Special cases |
|---|---|---|---|---|
| Top 10 % (T) | < 20% | 20% to < 35% | ≥ 35% | Excludes the curve PDA, AMM vaults, burn addresses and lockers |
| Dev % (D) | < 5% | 5% to < 10% | ≥ 10% | When the dev has sold 100%: "DS" in `text-2`, no fill, tooltip "Dev sold 100% at 12m" |
| Snipers % (S) | < 5% | 5% to < 15% | ≥ 15% | |
| Insiders % (I) | < 3% | 3% to < 10% | ≥ 10% | Stricter, because insiders are funded by the creator |
| Bundlers % (B) | < 5% | 5% to < 15% | ≥ 15% | |

Related flags (not banded chips):
- **T22:** any Token-2022 danger flag. `sell-tint` chip with the text "T22". Buying requires the 3 s countdown confirm (1.7).
- **DEX:** Dex Paid. Neutral outline chip. It says nothing about safety.
- **LP:** migrated, non-pump pools only. "LP 100%" neutral; below 100% amber; 0% red.
- **Not computed yet** (the first slots after creation): the chip shows "–" in `text-4`, tooltip "Computing (needs 3 slots)".

### 3.12 Edge cases

| Case | Display |
|---|---|
| NaN, Infinity, null | "–" in `text-4` |
| −0 | "0" (no sign) |
| PnL with zero cost basis (airdrop) | Absolute PnL shown; % shows "–" |
| Market cap without a supply | "–" |
| Price feed older than 5 s for a focused token | Value in `text-3` plus a "Stale 6s" chip in the panel header |
| Values that don't fit their column | Never wrap or overflow. Fall back to the compact form, then ellipsis, with the full value in the tooltip. |

---

## 4. Components

Each component lists anatomy, sizes (compact / comfortable), states, keyboard behaviour, and the Mobbin screens it borrows from. Heights refer to density tokens (2.10).

### 4.1 App shell and top bar

```
| mark+zerofee | Discover Pulse Trackers Portfolio Orders(7) | [/ Search token, CA or wallet] ...
  ... [zap 0.25 SOL] [P1|P2|P3] [shield Reduced] [Instant|Direct] [lock 2.412 SOL v] [Fund] [gear] |
```

- **Bar:** height `--zf-topbar` (40 / 44 px), `surface-1`, 1 px `hairline` at the bottom, horizontal padding 12 px. 16 px between logo and nav; 8 px between groups.
- **Logo:** 20 px monochrome mark plus "zerofee" at 13/600 `text-1` (4.22 and 9.4).
- **Nav tabs:** 24 px tall, 8 px padding, 4 px radius, 12/500. Inactive `text-3` (hover `text-1`). Active `text-1` on `surface-3`. The Orders tab shows its armed count in a neutral count badge (4.5), never coloured.
- **Search trigger:** control height, 320 px wide (shrinks to 200 px), `surface-2`, 1 px `hairline-strong`, `Search` icon at 14 px `text-3`, placeholder "Search token, CA or wallet" in `text-4`, a "/" keycap on the right. Click opens the palette (4.15).
- **Quick-buy amount:** a 96 px number input with `Zap` 12 px `text-3`, the value at 12/600 and "SOL" in `text-3`. Tooltip: "Default quick-buy amount for the pills on Pulse. Columns can override it."
- **Preset segmented** P1 / P2 / P3 (4.8). Hotkeys Alt+1, Alt+2, Alt+3. Switching gives the chosen segment a `highlight` fill that fades over 600 ms, instead of a toast.
- **Landing chip:** `ShieldCheck` 14 px and the label "Reduced" or "Secure" in `text-2`. "Fast" uses `Zap` and `warn` because it carries sandwich risk. Click opens the preset editor on its Landing tab. The current code colours the three presets buy, info and warn; only Fast keeps a colour.
- **Mode switch:** segmented Instant | Direct, tooltip from the current code.
- **Wallet button:** control height, `surface-2`, 1 px `hairline-strong`: lock icon (`Lock` `text-3` when locked, `LockOpen` `text-2` when unlocked), the wallet label in `text-3` (hidden below 1440 px), the balance at 12/600 `text-1` with "SOL" in `text-3`, `ChevronDown` 12 px. The menu is the current `WalletMenu` restyled with these tokens.
- **Fund:** a `secondary` button. Primary emphasis belongs to the step the user is on, not to the top bar.
- **Settings:** a 28 px icon button with a 16 px icon.
- **Responsive:** below 1440 px the mode switch moves into the wallet menu. Below 1280 px the landing chip moves into the preset popover. Below 1024 px the quick-buy amount and presets hide (Pulse column headers still have them) and the nav collapses into a menu. Below 768 px the mobile header takes over (5.8).
- Borrowed from:
  - [Kraken Pro](https://mobbin.com/screens/5bdd6cb2-5040-44c4-8781-c70f3aea60a8): balance chip, Deposit and a ⌘K search pill on one row.
  - [Coinbase Advanced](https://mobbin.com/screens/f8afc154-e5c8-4587-ab43-93c4799a979a): one row carrying market context and a Transfer action.
  - [OKX spot](https://mobbin.com/screens/c3ca83ef-f1de-4703-abbf-aa02ff6fa1ff): header height and quiet monochrome nav.

### 4.2 Bottom status bar

- 24 px, `surface-1`, 1 px `hairline` on top, label 11/14 `text-3`, padding 8 px, 12 px between items, with 1 × 12 px hairline separators between groups.
- **Left, in order:**
  1. Dock toggles: "Wallets" (`Wallet` 12 px) with an unread count badge, and "X" (letter) for the social dock. Active toggles are `text-1` on `surface-3`.
  2. Connection: a 6 px static dot (`buy` live, `warn` connecting or degraded, `sell` offline), then "Live", "Reconnecting 3" or "Offline", then "6 Hz · lag 120 ms · 4.2K ev/s" in `text-3`.
  3. "Slot 312,456,789".
  4. SOL/USD "$119.50" in `text-2`. Stale for more than 60 s: `warn` and "stale 64s".
  5. `Timer` 12 px + "Last fill 412 ms". Click opens the latency breakdown (4.13).
- **Right, in order:** "7 armed" (link to Orders, number in `text-1`), the USD | SOL segmented control (xs), a density toggle (`Rows3` 12 px), the "Simulated data" badge (`warn` text on `warn-tint`, mock mode only), "? Shortcuts".
- No ticker tape. A scrolling tape is constant motion with no decision value.
- Borrowed from:
  - [Kraken Pro](https://mobbin.com/screens/5bdd6cb2-5040-44c4-8781-c70f3aea60a8): "● Online" plus favourites at the left of a thin bar, feedback at the right.
  - [Gemini ActiveTrader](https://mobbin.com/screens/2271e5e3-4a73-4fa3-aad3-24e7bd6e2ad1): "● Online" status bar. We drop its ticker tape.
  - [OpenSea](https://mobbin.com/screens/a2072a4d-d59f-4b22-92be-ddcc3100db61): Live/Paused state plus Crypto/USD and Collector/Pro toggles in the status bar.

### 4.3 Pulse column and column header

- **Column:** `surface-1`, minimum 320 px wide, equal widths (`1fr`), separated by 1 px hairlines. The list is virtualised (`@tanstack/react-virtual`) with a fixed item size equal to the card height and overscan 4.
- **Header:** sticky (`z-sticky`), `--zf-col-header` (36 / 40 px), 1 px `hairline` at the bottom, padding 8 px.

```
| New Pairs 214  [Paused]          [search] [zap 0.25] [P1|P2|P3] [filters 2] [...] |
```

  - Title at 12/600 `text-1`. Count at 11/500 `text-3`, tabular.
  - "Paused" chip (only while paused): `Pause` 10 px + "Paused" in micro type, `text-2` on `surface-3`.
  - Search: a 24 px icon button that expands to a 160 px input in place (or press "/" while the column has focus). It filters by name, ticker or CA.
  - Quick-buy amount: a 76 px input (`Zap` 12 px + value). It overrides the global amount for this column.
  - Preset segmented P1 | P2 | P3, 22 px per segment. Hidden below 380 px column width (available in the "..." menu).
  - Filters: a 24 px button, `SlidersHorizontal` 14 px, with an active-count badge.
  - "..." menu: sound, sort, show legend, hide column.
- **Active-filters row** (only when at least one filter is active): 24 px under the header. Segmented chips like Fey's, each 20 px tall, 2 px radius, `surface-2`, 1 px `hairline`: label in `text-3` ("MC"), value in `text-1` ("$5K–$50K"), then an `X` 12 px. Overflow collapses to "+3".
- **"N new" bar:** sticky at the top of the list while paused with queued items: 24 px, `surface-2`, "↑ 12 new" at 11/500 `text-1`, then "· click or move away to show" in `text-3`. Click applies immediately.
- **Legend row** (toggle in the menu; forced on for narrow cards): 20 px, micro type in `text-3`: "T Top 10 · D Dev · S Snipers · I Insiders · B Bundlers".
- **Column definitions** (title tooltip):
  - New Pairs: "Tokens on a bonding curve, newest first."
  - Final Stretch: "Bonding progress 80% or more, highest progress first." (Default threshold; confirm with the data pipeline owner.)
  - Migrated: "Graduated to an AMM pool, newest first."
- **States:**
  - Empty: "No tokens match these filters", with "Edit filters" (secondary) and "Reset" (ghost).
  - Loading: 8 skeleton cards.
  - Hover or keyboard focus pauses the column (6.7).
- **Keyboard:** `1`/`2`/`3` or `H`/`L` focus a column. `J`/`K` (or arrow keys) move the card cursor. `F` opens filters. `P` pauses or resumes. `/` searches the focused column.
- Borrowed from:
  - Axiom's Pulse header ([docs](https://docs.axiom.trade/axiom/finding-tokens/pulse)): search, quick-buy amount, P1–P3 and filters per column.
  - [Fey screener](https://mobbin.com/screens/0caf65f6-dcdc-451d-ae2c-5e8c47e1efff): "label | value ×" active-filter chips.
  - [Binance Meme Rush](https://mobbin.com/screens/972c602f-95aa-44ba-9cd3-1f869d9a58c3): a column legend ("Age / Holders / Top 10") that explains compact rows.
  - [Canny](https://mobbin.com/screens/8794989c-4116-4894-9684-2fd8f4761652): a quiet "Paused" chip.
  - [OpenSea](https://mobbin.com/screens/a2072a4d-d59f-4b22-92be-ddcc3100db61): a visible paused state for live data.

### 4.4 Token card (Pulse)

Variants by column width: **narrow** (< 424 px), **wide** (424–599 px, the reference), **wide+** (≥ 600 px, which includes 1920 px viewports with 639 px columns).

**Wide, compact (68 px including the 1 px divider).** Padding 8 px. Grid columns: avatar 40 | 8 | main (min 216) | 8 | metrics 72 | 8 | pill (min 56, all pills in a column share one width).

```
+--------+-------------------------------------------+-----------+--------+
| [ava]  | WIF  dogwifhat  [copy]                    | MC $11.2K |        |
| [ring] | 25s  X web tg   holders 505  pro 14  eye 2 | V  $5.04K | [z .25]|
| [bdg]  | [T 18%][D 2.0%][S 0%][I 0%][B 6.0%] DEX   | TX 52 ==- |        |
+--------+-------------------------------------------+-----------+--------+
```

- **Avatar** (4.22): 40 px square, 4 px radius.
  - Bonding ring: a 2 px stroke around the square, track `hairline-strong`, fill `text-2`, length equal to progress.
  - Launchpad badge: 16 px, bottom-right, offset −3 px, `surface-3` with a 2 px `bg` ring, one 10 px letter in `text-2`: P pump, M Mayhem, B Bonk, G Bags, S StonkFun, R LaunchLab, D Meteora DBC, O Moonit, X other.
- **Line 1 (18 px):** ticker at 13/600 `text-1` (max 10 characters, ellipsis), name at 12/400 `text-3` (truncates first), copy-CA icon button (`Copy` 12 px in a 20 × 20 hit area, `text-3`, hover `text-1`).
- **Line 2 (16 px):**
  - Age (3.7), reserving 4ch.
  - Socials: X letter, `Globe`, `Send`, each 12 px in a 16 × 16 hit area, `text-3`. Hover shows the handle or URL. A tweet link shows the tweet preview popover.
  - Counters: `Users` 12 px + holders; `BadgeCheck` 12 px + pro traders; `Eye` 12 px + tracked wallets holding (only when above 0, value in `info`). Counter values are 11/500 `text-2`.
- **Line 3 (18 px):** five risk chips T D S I B (4.5), 4 px apart, then flags (DEX, T22, LP).
- **Metrics (72 px, right-aligned):**
  - Line 1: "MC" in micro `text-3`, value at 12/600 `text-1`.
  - Line 2: "V" in micro `text-3`, value at 12/400 `text-2`.
  - Line 3: "TX" in micro `text-3`, count at 11/500 `text-2`, and a 24 × 2 px ratio bar: `buy` share on the left, `sell` on the right, 1 px gap.
  - Values use `font-stretch: var(--zf-num-stretch)`.
- **Pill:** the quick-buy pill (4.6), vertically centred.
- **States:**
  - Hover: background `surface-2`; pauses the column.
  - Keyboard cursor: `surface-2` plus a 2 px `accent` bar on the left edge.
  - Open in the token page: `surface-3`.
  - New: the `highlight` fade (6.6).
  - Stale (New Pairs with no update for 30 s or more): metrics in `text-3`.
  - Blacklisted dev, funder or ticker: the card is removed, not dimmed.
- **Clicks:** the card body opens the token page; middle-click or ⌘-click opens a new tab. The pill, copy button and social icons never open the page.
- **Narrow (< 424 px):** avatar 32 px; grid avatar | main | pill. MC moves to the right end of line 1 (value only, 12/600) and V to the right end of line 2. The TX bar hides. Chip letters hide and the legend row is forced on (each chip shrinks to about 30 px).
- **Wide+ (≥ 600 px):** a second 72 px metrics column with "F 1.24" (fees paid, SOL) and "NB +$3.2K" (net buy, signed colour), plus a 64 × 24 px mini chart between main and metrics: a 1-minute line over the last 30 minutes, 1 px `text-2`, no fill, a 3 px dot on the last point.
- **Comfortable (80 px):** padding 10 px, avatar 48 px, line heights 20 / 18 / 20 px with 2 px gaps.
- Borrowed from:
  - Axiom's card ([docs](https://docs.axiom.trade/axiom/finding-tokens/pulse)): three lines, risk chips on line 3, MC / V / TX on the right, one-click buy.
  - [Binance Meme Rush](https://mobbin.com/screens/2aa0b210-3bdf-44dd-b04a-8fa2556db2f5): square avatar with a status border and launchpad badge; top-10 share turning red when high.
  - [Binance Meme Rank](https://mobbin.com/screens/55442959-3968-4340-9c27-3efe6dfffeb5): per-card metric chips with a Buy action on every card.
  - [Coinbase Wallet trending swaps](https://mobbin.com/screens/5420b26c-19a1-4d3b-bb6e-7b68d373d175): a bought/sold split bar.

### 4.5 Risk chips, tags and badges

**Risk chip**
- 16 px tall, 3 px horizontal padding, 2 px radius, `min-width: 40px` (so chips line up from card to card; the rare "100%" grows to 44 px).
- Letter: micro 10/500 uppercase `text-3`. Value: 11/500 in the band colour, right-aligned inside the chip. 2 px gap between them.
- Low: no fill, no border. Mid: `warn-tint` fill. High: `sell-tint` fill plus 1 px `sell-edge` border.
- "DS" and "–": per 3.11.
- Tooltip: 4.14. `aria-label`: "Top 10 holders 18 percent, low".

**Tags** (wallet tags in tables and the palette): 16 px tall, 4 px padding, 2 px radius, micro 10/600 uppercase, +0.02em.

| Tag | Style |
|---|---|
| YOU | `text-1` text, 1 px `text-1` border, no fill. It stands out by contrast, not hue. |
| DEV | `warn` on `warn-tint` |
| SNP, INS, BND | `sell` on `sell-tint` |
| TRK, KOL | `info` on `info-tint` |
| PRO, WHALE | `text-2` on `surface-3` |
| CURVE, POOL | `text-3`, no fill |

**Count badge:** pill, 16 px tall, min-width 16 px, 4 px padding, `surface-3`, micro 10/600 `text-1`.

**Status dot:** 6 px circle plus a label (4.20).

Borrowed from:
- Axiom's five percentage chips ([docs](https://docs.axiom.trade/axiom/finding-tokens/pulse)): we replace its icon metaphors with letters.
- [Railway](https://mobbin.com/screens/ea8d53dc-8270-430d-bbdd-1df73b4ca531): severity chips (tint + border + matching text) that stay legible on dark.
- [Xero](https://mobbin.com/screens/faf352c0-6e0c-4bcd-8d48-afd5393107b1): small rectangular status chips.
- [Vercel](https://mobbin.com/screens/e9576405-bcef-419a-922a-8fb84b044a54): a dot plus a label for status.

Why letters instead of icons (the current `RiskChips` uses Crown, ChefHat, Crosshair, Ghost and Boxes): five unrelated metaphors are slower to learn than T/D/S/I/B, cute icons (a chef hat for "dev") read as gimmicky, and letters fit five chips in 216 px with room for "100%".

### 4.6 Buttons

**Sizes**

| Size | Height | Padding x | Label | Icon |
|---|---|---|---|---|
| `xs` | 20 px | 6 px | 11/500 | 12 px |
| `sm` | 24 px | 8 px | 12/500 | 14 px |
| `md` | 28 px | 10 px | 12/500 | 14 px |
| `lg` | 32 px | 12 px | 13/600 | 16 px |
| `xl` | 36 px compact, 40 px comfortable, 44 px mobile | 16 px | 13/600 | 16 px |

Radius 4 px for all except the pill.

**Variants**

| Variant | Rest | Hover | Press | Disabled | Use |
|---|---|---|---|---|---|
| `primary` | `accent` fill, `ink` text | `accent-hover` | `accent-press` | `surface-3`, `text-4` | Non-trade primary: Save, Apply, Unlock, Continue |
| `buy` | `buy` fill, `ink` text | `buy-hover` | `buy-press` | `surface-3`, `text-4` | Trade CTA (buy) |
| `sell` | `sell` fill, `ink` text | `sell-hover` | `sell-press` | `surface-3`, `text-4` | Trade CTA (sell), final destructive confirmation |
| `buy-tint` | `buy-tint` fill, `buy` text, 1 px `buy-edge` | `buy` 20% fill | `buy` 28% fill | `surface-2`, `text-4` | Instant Trade buy amounts, quick buys |
| `sell-tint` | as above with `sell` | `sell` 20% | `sell` 28% | `surface-2`, `text-4` | Instant Trade sell %, quick sells |
| `secondary` | `surface-3` fill, `text-1`, 1 px `hairline-strong` | `surface-3-hover` | `hairline-strong` fill | `surface-2`, `text-4` | Fund, Export, Cancel, Re-arm |
| `ghost` | transparent, `text-2` | `surface-3`, `text-1` | `surface-3-hover` | `text-4` | Toolbar and tertiary actions |
| `danger` | `sell-tint`, `sell` text, 1 px `sell-edge` | `sell` 20% | `sell` 28% | `surface-2`, `text-4` | Destructive secondary: Cancel order, Remove |
| `icon` | Square ghost: 20 / 24 / 28 px with 12 / 14 / 14 px icons (16 px icon in the 28 px top-bar version) | | | | |

**Quick-buy pill**
- 24 px tall (32 px visual and a 44 px hit area on mobile), pill radius, 6 px padding, `surface-3` fill, 1 px `hairline-strong`. `Zap` 12 px `text-3` plus the amount at 12/600 `text-1`.
- Hover: `buy-tint` fill, `buy-edge` border, `buy` text and icon. Press: `buy` fill, `ink` text.
- After a click: 300 ms pressed state, then idle. The toast carries progress.
- Disabled for the card's first 250 ms on screen (mis-click guard).
- Locked keystore: shows `Lock` 12 px instead of `Zap`; click opens unlock.
- Tooltip: "Buy 0.25 SOL" plus the keycaps Space B.

**Rules**
- Labels are a verb plus an object: "Buy WIF · 0.50 SOL", "Sell 50%", "Arm 3 orders", "Cancel order". Never "Submit", "OK" or "Confirm" alone.
- Trade buttons never show a spinner (the toast carries progress). Other async buttons replace their icon with a 14 px spinner and keep their width.
- Hover and press change colour only: no scale, no translate, no `brightness()` filter (the current `Button` uses `hover:brightness-110`). Transition `background-color`, `color` and `border-color` over 80 ms.

Borrowed from:
- [OKX](https://mobbin.com/screens/f26041bc-ccc7-43f8-b492-2959191e63ae) and [Binance](https://mobbin.com/screens/14a47c59-4122-498b-ab2e-4ff6d611c85c): full-width side-coloured Buy/Sell CTAs.
- Axiom's Instant Trade ([docs](https://docs.axiom.trade/axiom/swap/instant-trade)): outlined green buy pills and red sell pills.
- [Public options ticket](https://mobbin.com/screens/00b5bb2e-ab18-40db-abe1-26a5248bed62): a grid of instant action buttons.

### 4.7 Amount input with preset chips

```
Amount                                    Bal 2.412 SOL · Max
[                                        0.50   SOL]
[ 0.1 ][ 0.25 ][ 0.5 ][  1  ]  [pencil]
```

- **Label row (16 px):** "Amount" at 11/500 `text-3` on the left. On the right, "Bal 2.412 SOL · Max" at 11 `text-3`, with "Max" as a `text-1` text button. Max leaves the reserve for fees, tip and rent.
- **Input:** 32 px (36 comfortable, 44 mobile), 4 px radius, `surface-2`, 1 px `hairline-strong`. Value at 14/500 `text-1`, right-aligned, followed by "SOL" at 12 `text-3`. Focus: 2 px `focus` ring.
- **Presets:** four chips of equal width, 24 px tall, 4 px apart, 4 px radius, `surface-2` with a 1 px `hairline` border, label 12/500 `text-2`. The chip matching the current value is `text-1` with a 1 px `text-2` border.
- **Edit mode:** a 24 px pencil button at the row's end turns the chips into inputs. Enter saves, Esc cancels.
- **Sell mode:** chips 10% / 25% / 50% / 100%, plus an xs "% | SOL" segmented control.
- **Keyboard:** Up/Down steps by 0.01 below 1 SOL and 0.1 from 1 SOL; Shift multiplies by 10. Accepts "1.5", "1,5" and "2k". Enter fires the panel's primary CTA. Esc blurs.
- **Validation** (11 px line under the input):
  - Over balance: `sell` text "Exceeds balance by 0.12 SOL". CTA disabled.
  - Over the per-trade cap: `warn` text "Above your 5 SOL per-trade cap · Change". CTA disabled; "Change" opens Settings > Limits.
  - Below the minimum: `warn` "Minimum 0.001 SOL".
- Borrowed from:
  - [Coinbase Advanced](https://mobbin.com/screens/f8afc154-e5c8-4587-ab43-93c4799a979a): an amount field with 25% / 50% / MAX chips under it.
  - [Gemini](https://mobbin.com/screens/2271e5e3-4a73-4fa3-aad3-24e7bd6e2ad1): 25 / 50 / 75 / 100% / Custom chips.
  - [Gamma](https://mobbin.com/screens/a9f1af57-9e9e-4f7d-9931-6132b939300e): presets sitting beside the value.
  - [Whop](https://mobbin.com/screens/b5f3bb6c-2fc1-497f-8386-29d3a6f7e763): the selected-chip state.
  - [Phantom auto close](https://mobbin.com/screens/279487cb-c28e-4e7a-9581-8d41e4f89e06): +10% / +25% / +50% / +100% chips.

### 4.8 Segmented controls and tabs

**Segmented control**
- `sm`: 24 px container (1 px `hairline-strong` border, 2 px padding), 18 px segments, label 11/500.
- `xs`: 20 px container, 14 px segments, label 10/500.
- Segment radius 2 px. Inactive `text-3`, hover `text-1`. Active: `surface-3` fill, `text-1`.
- Side variant (trade panel Buy | Sell): 28 px. Active Buy is `buy-tint` with `buy` text; active Sell is `sell-tint` with `sell` text.
- Keyboard: `role="radiogroup"`, Left/Right change the selection, Home/End.

**Panel tabs**
- Height `--zf-panel-header`, label 12/500. Inactive `text-3`, hover `text-2`. Active: `text-1` with a 2 px `accent` bar inset at the bottom.
- Counts follow the label in `text-3` ("Trades 1.2K"). Overflow goes into a "More" menu.
- Keyboard: `role="tablist"` with roving tabindex, Left/Right, Home/End. Shift+1 to Shift+6 switch the token page's bottom tabs.
- Underline tabs for panels, segmented controls for modes. No third (pill-tab) pattern.

Borrowed from:
- [Coinbase Advanced](https://mobbin.com/screens/f8afc154-e5c8-4587-ab43-93c4799a979a): "Price chart | Depth chart" underline tabs.
- [OKX](https://mobbin.com/screens/c3ca83ef-f1de-4703-abbf-aa02ff6fa1ff): panel tabs.
- [Kraken Pro](https://mobbin.com/screens/5bdd6cb2-5040-44c4-8781-c70f3aea60a8): closable panel tabs with "+".
- [Binance](https://mobbin.com/screens/14a47c59-4122-498b-ab2e-4ff6d611c85c): side-tinted Buy/Sell segmented.

### 4.9 Tables

**Base rules**
- **Header:** `--zf-header-row` (28 / 32 px), sticky, `surface-1`, 1 px `hairline` at the bottom. Labels 11/500 `text-3`, sentence case, units in the header ("SOL", "MC").
- **Sorting:** sortable headers show `ChevronsUpDown` 12 px on hover and `ArrowUp`/`ArrowDown` 12 px `text-2` when sorted.
- **Rows:** `--zf-row` (24 / 28 px); tapes and live feeds use `--zf-row-dense` (20 / 24 px). Cells at data size, 8 px horizontal padding. No zebra striping.
- **Dividers:** tapes and feeds have none. Data grids (positions, holders, top traders, orders) get 1 px `hairline` row dividers.
- **Alignment:** text left, numbers right, icons centred. Columns have fixed widths in `ch` (below), except one flexible label column.
- **States:** hover `surface-2`, selected `surface-3`, keyboard cursor `surface-2` plus a 2 px `accent` bar on the left.
- **Empty and loading:** 4.18. Virtualise above 100 rows.
- **Columns popover:** drag handles plus switches, saved per table.

**Trades** (token page, the default tab), dense rows:

| Column | Width | Content |
|---|---|---|
| Age | 5ch | Ticking, right-aligned |
| Side | 3ch | "B" or "S" in micro 10/600 side colour, on a 16 × 16 px side-tint square, 2 px radius |
| MC | 8ch | Market cap at trade time (USD or SOL per the toggle) |
| Price | 10ch | Hidden by default |
| SOL | 10ch | Exactly 3 decimals in the side colour; trailing zeros `text-3`; size bar behind the row |
| Tokens | 8ch | Compact, `text-2` |
| USD | 8ch | `text-2` |
| Trader | flex, min 16ch | Label or short address (mono) plus tags |
| Tx | 3ch | `ArrowUpRight` 12 px link to the explorer |

- **Size bar:** behind the row, anchored to the right edge, width = 60% × min(1, log10(1 + sol) / log10(11)) (10 SOL fills it), `bar-buy` or `bar-sell`.
- **Toolbar** (28 px above the table): segmented All | You | Dev | Tracked; a 64 px "Min SOL" input; a "Candle 14:32:05 ×" chip while filtered by a candle click; a `Pause` toggle for the tape.

**Holders** (data grid):

| # | Wallet | % supply | Tokens | Value | Avg entry (MC) | Realized | Unrealized | Funded by | Actions |
|---|---|---|---|---|---|---|---|---|---|
| 3ch | flex (avatar 16 + label or address + tags) | 12ch: value + 40 px inline bar (`text-3` at 50% on a `surface-3` track) | 8ch | 8ch | 8ch | 9ch, signed colour | 9ch, signed colour | 12ch, short address or label | 6ch: track (`Star` 12), copy |

- Above the grid, a 28 px summary strip: "1,284 holders · Top 10 18% · Dev 2.1% · Snipers 4.5% · Insiders 0% · Bundlers 6.0%" (values in band colours), then a segmented filter All | Insiders | Snipers | Bundlers | Tracked.

**Top traders:** # · Wallet · Bought (SOL, `buy`) · Sold (SOL, `sell`) · Realized PnL (signed) · Unrealized · Remaining % · Held for · Last tx (age).

**Positions** (token page tab and portfolio): Token (avatar 20 + ticker + name) · Bought · Sold · Holding (tokens + value) · Avg entry (MC) · PnL (absolute + %) · Actions: Sell 25 / 50 / 100 (`sell-tint` xs buttons) and Share (`Share2` 12 px).

**Orders** (token page tab): Status (dot + label) · Type · Trigger · Distance · Size · Armed (age) · Actions (Cancel, Re-arm). The full list is 4.20.

Borrowed from:
- [Binance](https://mobbin.com/screens/8d1b7823-6418-44c5-b3d5-ab69b3bfd6e3) market trades: side colour on the figure that matters, time right-aligned.
- [Coinbase Advanced](https://mobbin.com/screens/f8afc154-e5c8-4587-ab43-93c4799a979a): depth bars behind order-book rows.
- [Uniswap transactions](https://mobbin.com/screens/9a89244a-9b7b-49c1-9d6c-28cd7abdfa3f): a type filter dropdown in the header.
- [OpenSea tokens](https://mobbin.com/screens/a2072a4d-d59f-4b22-92be-ddcc3100db61): tabular numbers in every column, sortable headers, small NEW tags.
- [Perplexity holders](https://mobbin.com/screens/d265c7a4-c61e-46bc-b525-beb10db72df8): holder-type tabs, signed change colouring.
- [OKX assets](https://mobbin.com/screens/da509525-ceef-4935-aa96-01a2f52521a6): two-line cells (value over its converted value).
- [Shopify](https://mobbin.com/screens/909c6cdb-f0a1-4183-ab1c-b64f3f2c9aa2): a columns popover with drag handles and visibility toggles.
- [Linear](https://mobbin.com/screens/e142df2a-3527-499c-8f81-1b715947ac0c): no zebra, grey right-aligned meta, group header bars.

### 4.10 Chart chrome

Library: TradingView Lightweight Charts v5, in a lazy chunk. The attribution logo stays on (bottom-left), as the Apache-2.0 NOTICE requires.

**Toolbar** (32 px, `surface-1`, 1 px `hairline` at the bottom, padding 8 px):

```
[1s 15s 1m 5m 15m 1h] [candles v] [Indicators v]        [MC|Price] [USD|SOL] [Markers v] [camera] [maximize]
```

- **Markers menu** (checkbox items, 28 px): My trades · Dev trades · Tracked wallets · Snipers and bundlers · Average entry/exit lines · Open order lines · Migration line · Click a candle to filter trades.
- **Legend** (top-left overlay, 8 px inset, 11 px):
  - "WIF/SOL · pump curve · 1s" in `text-3`.
  - "O 12.1K H 12.4K L 11.9K C 12.3K": values `text-1`, letters `text-3`.
  - The change ("+1.52%") in signed colour, and "V 84.2 SOL".
  - It follows the crosshair and otherwise shows the last candle.
- **Axes:** price axis on the right, 11 px `chart-text`. The last-value chip uses the candle colour with `ink` text at 11/600. MC mode uses compact USD (3.2).
  - Exception to rule 14: in price mode, canvas axis labels may use Unicode subscript digits, because canvas text can't be styled per glyph. MC mode, the default, never needs them.
- **Crosshair:** dashed 1 px `chart-crosshair`; label chips `surface-3` with `text-1` at 11 px.
- **Markers:**
  - You and dev: 16 px circles filled with the side colour (buys below the bar with a 2 px gap, sells above), a 10/600 `ink` letter: "Y" or "D".
  - Tracked wallets: 14 px circles filled `surface-3` with a 2 px side-coloured ring, showing the wallet's emoji (user data) or the first letter of its label.
  - Snipers and bundlers: 6 px `sell` dots, off by default.
  - Clusters: more than 3 markers on one candle at the current zoom collapse into one 16 px neutral marker (`surface-3`, count in `text-1`); hover lists the entries.
  - Implementation: `createSeriesMarkers` for simple shapes, a custom primitive for letter and emoji bubbles.
- **Average entry line (yours):** 1 px dashed 4 3, `text-1` at 80%. Axis chip "AVG 12.4K": `surface-3`, 1 px `text-1` border, `text-1` label. After partial sells, an average exit line: dotted 1 3 `text-2`, chip "EXIT 15.0K".

**Draggable order line** (limit buy, limit sell, TP, SL, alert)
- A 1 px solid line in its colour (alerts: `text-2`, dashed 2 2).
- Handle chip at the left edge (8 px inset): 20 px tall, 4 px radius, `surface-2`, 1 px border in the line colour, label 11/500 "Limit buy 0.50 SOL · 9.80K", plus an `X` 12 px to remove. An axis chip on the right shows the value.
- **Drag:** `ns-resize` cursor on the line (8 px hit area) or the chip. While dragging, the chip shows "−20.1% vs now", and the order form updates live (two-way binding). On release the line stays as a dashed "Draft" until armed.
  - Esc during a drag reverts.
  - Snaps to 0.5% steps of current MC. Holding Alt disables snapping.
- **Keyboard:** Tab focuses the handle chip (focus ring). Up/Down move 0.5%; Shift+Up/Down move 5%. Enter arms (opening the arm confirmation if one is needed). Delete removes a draft. Esc blurs.
- **New lines:** right-click the chart (or the "+" on the crosshair price label) for "Limit buy at 9.80K", "Limit sell at 9.80K", "Alert at 9.80K".

**Other chart rules**
- **Migration line:** dotted `text-3` with a chip "Migration 69.0K".
- **Click a candle** (when enabled): filters the Trades table to that candle's time bucket; the candle gets a 1 px `text-2` outline.
- **States:**
  - Loading: the real toolbar plus a `surface-1` canvas with "Loading 1s candles…" at 12 `text-3` top-left. No spinner.
  - Error: "Couldn't load candles · Retry".

Borrowed from:
- [Coinbase Advanced](https://mobbin.com/screens/4ed27744-549c-4cb7-894f-e2bc1f04c623): toolbar and chart-type menu.
- [Binance](https://mobbin.com/screens/9ee1d184-7edd-4bb9-9250-bd49a1a53a53): a chart settings menu with Open orders, Order history, Average price, Price alert and Price line toggles.
- [Kraken Pro](https://mobbin.com/screens/5bdd6cb2-5040-44c4-8781-c70f3aea60a8): a labelled "Preview – Buy – Limit" order line on the chart.
- [Phantom](https://mobbin.com/screens/c5d3a411-f5d2-4618-bfb4-0eb2abcbf5d4): an "Entry" label on a dashed line.
- [Gemini](https://mobbin.com/screens/51336744-d390-48af-8815-0c4fbb57a0d0): a floating line toolbar with drag handle, width and lock.
- [OKX](https://mobbin.com/screens/a2bb80c5-27d1-4a5e-a87e-7c852a2d38f3): a drawing menu with right-aligned shortcut hints.
- [Railway](https://mobbin.com/screens/14f51fd0-7ad0-4c59-a44c-9f35b2056107): a compact chart tooltip with tabular values.
- Axiom ([docs](https://docs.axiom.trade/axiom/swap/limit-orders)): MarketCap/Price and USD/SOL toggles, a draggable "Limit Order Target", wallet bubbles on the price.

### 4.11 Trade panel

A right rail 320 px wide (300 at `xl`, 288 at `lg`), `surface-1`, 1 px `hairline` on the left, padding 12 px. Sections top to bottom (compact heights):

1. **Side:** segmented Buy | Sell, 28 px, full width.
2. **Order type:** underline tabs Market | Limit | Advanced, 28 px.
3. **Amount:** 4.7.
4. **Limit only:**
   - "Trigger" label with an xs MC | Price segmented control.
   - A 32 px input ("9.80K" with "MC" in `text-3`).
   - A slider from −100% to +100% (4.23) with ticks at −50, −25, 0, +25 and +50.
   - Helper at 11 `text-3`: "−20.1% vs current MC 12.3K".
   - "Expires: never (durable nonce)" in `text-3`.
5. **Advanced only (exit ladder):**
   - Rows of 28 px: [TP1] [+50% input, 64 px] [sell 25% input, 56 px] [`X` remove]; "+ Add take profit" ghost xs; an SL row [SL] [−30%] [sell 100%].
   - Quick chips +25% / +50% / +100%, and a mode segmented control "% PnL | MC".
   - Note in `text-3`: "Arms 3 orders on 2 nonce slots after the buy fills."
6. **Execution summary** (24 px): xs P1 | P2 | P3, then chips "Slip 20%", "Prio 0.0001", "Tip 0.00001", "Reduced" (`ShieldCheck`), 11 px `text-2`.
   - Clicking opens the preset editor popover: slippage %, priority fee, tip, and landing preset with the SPEC descriptions. Fast shows the sandwich note in `warn`.
7. **Cost breakdown:**
   - Collapsed: one 24 px row "Total 0.5084 SOL · Platform fee 0" with `ChevronDown`.
   - Expanded: 20 px rows, label 11 `text-3` with an `Info` 12 px tooltip, value 11 `text-2` on the right:
     - You receive (est.): ~1.24M WIF (`text-1`)
     - Price impact: 0.42%
     - Venue fee (pump.fun 1.25%): 0.0063 SOL
     - Priority fee: 0.0001 SOL
     - Tip (Reduced lane): 0.00001 SOL
     - Network base fee: 0.000005 SOL
     - Rent, refundable (first buy only): 0.00204 SOL
     - Platform fee: 0 (`text-1`, with the 12 px slashed-zero mark)
     - Total: 0.5084 SOL (12/600 `text-1`, `hairline` above)
8. **Primary CTA** (`xl`):
   - "Buy WIF · 0.50 SOL" (`buy`), "Sell 50% · ~0.61 SOL" (`sell`), "Arm limit buy · 0.50 SOL @ 9.80K" (`buy`).
   - Disabled labels say why: "Enter an amount", "Exceeds balance", "Feed offline". A locked keystore shows "Unlock to trade" (`secondary` with `Lock`); no wallet shows "Connect wallet".
   - Below it (16 px, only while focus is inside the panel): an "Enter" keycap and "or Space+B" in `text-3`.
9. **Position strip** (48 px, `hairline` above): four cells, Bought / Sold / Holding / PnL, each a micro `text-3` label over a 12/500 value. A $/SOL toggle. PnL in signed colour. A "Sell initials" ghost xs and `Share2` (opens the PnL card).
10. **Token info** (`hairline` above; 32 px header "Token info" at 12/600 plus a "Methodology" link in `text-3`):
    - A 3-column grid with 40 px rows. Each cell is a label (11 `text-3`, dotted underline, metric tooltip) over a value (13/600, band colour or `text-1`): Top 10 · Dev · Snipers / Insiders · Bundlers · LP burned / Holders · Pro traders · Dex paid.
    - Token-2022 flags, listed in `sell-tint` chips when present.
    - Dev row: "Dev 9xQ3…F1aB · 12 launches · 2 migrated", with copy and "Track dev".

- **States:**
  - Direct mode: the CTA reads "Buy in Phantom · 0.50 SOL", with "Approve in your wallet" under it.
  - Simulated: unchanged (the status bar badge covers it).
  - Locked keystore: CTA "Unlock to trade", hotkey `U`.
- **Keyboard:** `B`/`S` switch side and `M`/`L`/`A` switch order type (outside inputs). Tab order: side, type, amount, presets, trigger, summary, CTA. Enter in the amount field submits. Global trade hotkeys: Space+1–4, Space+Q/W/E/R, Space+T, Space+B.
- Borrowed from:
  - Axiom's trade panel ([docs](https://docs.axiom.trade/axiom/swap/market)): Buy/Sell, Market/Limit/Advanced, editable presets, a one-line settings summary, the Bought/Sold/Holding/PnL strip.
  - [Coinbase Advanced](https://mobbin.com/screens/9b76c57a-9ae9-408f-bbd1-f4955a00d544): "Available to trade", Subtotal / Fee / Total, the fee explained right next to the number.
  - [Uniswap's review](https://mobbin.com/screens/a619a575-5745-4ad8-978c-b25aaaa9bfc5): fee rows, each with an info icon.
  - [Phantom](https://mobbin.com/screens/65eff589-ab7c-4289-a456-68a161f019c2): the fee disclosure line, which we invert to "Platform fee 0".
  - [Gemini](https://mobbin.com/screens/f58f1725-5477-40de-9271-bfac6f2fadfe): a "Current market price" helper under the limit price.
  - [Binance](https://mobbin.com/screens/14a47c59-4122-498b-ab2e-4ff6d611c85c): slider stops and a TP/SL toggle in the order form.

### 4.12 Instant Trade floating window

- 296 px wide (320 comfortable), height auto, 6 px radius, `surface-2` (dark) or `surface-1` (light), 1 px `hairline-strong`, `e2`, `z-dock`.
- **Header (28 px):** a drag area across the header (`GripHorizontal` 14 px centred), an xs P1 | P2 | P3 segmented control, a hotkeys toggle (`Keyboard` 14 px: on = `text-1` on `surface-3`, off = `text-3`), a wallet picker ("1 wallet v", xs), `X` 14 px. On Pulse the header also shows the target ticker ("WIF") so the user can't trade the wrong token.
- **Buy section** (padding 8 px):
  - Row (16 px): "Buy" at 11/500 `text-3`; right: "Bal 2.412 SOL" in `text-3`.
  - Four `buy-tint` buttons, 28 px, label 12/600: 0.05 · 0.1 · 0.5 · 1.
  - With hotkeys on: "Space+1 · 2 · 3 · 4" at 10 px `text-3` under the grid.
  - Settings line (20 px): "Slip 20% · Prio 0.0001 · Tip 0.00001 · Reduced" at 11 `text-3`. Click opens the preset editor.
- `hairline` divider.
- **Sell section:**
  - Row (16 px): "Sell", an xs "% | SOL" toggle; right: "1.24M WIF · $612" in `text-3`.
  - Four `sell-tint` buttons: 10% · 25% · 50% · 100%.
  - Hint: "Space+Q · W · E · R".
  - Row: "Sell initials · 0.50 SOL" (`secondary` xs, full width), with PnL "+0.12 SOL (+24.0%)" on the right.
- **Behaviour:**
  - Dragged by the header. Snaps to viewport edges and the right-rail edge within 12 px, and always keeps at least 24 px on screen.
  - Position is persisted per breakpoint in `localStorage`, wrapped in try/catch.
  - Double-clicking the header collapses it to the 28 px header.
  - Shift+I or the token header button toggles it. Esc only blurs it.
  - Targets: the open token on token pages; the hovered or cursor card on Pulse.
  - No confirmations (SPEC). The repeat guard applies (6.4).
  - Locked keystore: buttons show `Lock` 12 px and open unlock.
- Borrowed from:
  - Axiom's Instant Trade ([docs](https://docs.axiom.trade/axiom/swap/instant-trade)): P1–P3, wallet picker, 4 buys, 4 sell %, % ⇄ SOL, Sell Init., hotkey toggle.
  - [Public options ticket](https://mobbin.com/screens/00b5bb2e-ab18-40db-abe1-26a5248bed62): a grid of instant action buttons.
  - [Kraken Pro](https://mobbin.com/screens/25b67ef9-d56e-4f69-865f-16a702da74b7): movable widget panels with persisted layout.
  - [Gemini](https://mobbin.com/screens/51336744-d390-48af-8815-0c4fbb57a0d0): a compact floating toolbar with a drag handle.

### 4.13 Transaction toasts

- **Container:** bottom-right by default (Settings: top-right, bottom-left, top-centre), 12 px from the viewport edges (the bottom offset clears the status bar: 24 + 8 px). 8 px between toasts, at most 4 visible (older ones collapse into a "+3 more" chip), newest nearest the anchor corner.
- **Toast:** 340 px wide, padding 10 × 12 px, 6 px radius, `surface-2` (light: `surface-1`), 1 px `hairline-strong`, `e2`. One toast per trade id, updated in place from pending to landed or failed.

```
[spin] Buying WIF · 0.50 SOL
       Built 4 ms · Signed 9 ms · Sent 38 ms · Landing...          312 ms
       4xQe...9KmP [copy]  Solscan ->                         Latency v
==========-----  (2 px stage bar)
```

- **Line 1** (13/600): a status icon (14 px) and the verb phrase.
  - Pending: a spinner in `text-2` and "Buying WIF · 0.50 SOL" ("Buying" in `buy`).
  - Landed: `Check` in `text-1` and "Bought 1.24M WIF for 0.50 SOL" ("Bought" in `buy`).
  - Failed: `XCircle` in `sell` and "Buy failed · Slippage exceeded".
  - Sells: "Selling 50% of WIF", then "Sold 620K WIF for 0.61 SOL" ("Sold" in `sell`).
- **Line 2** (11 `text-2`):
  - Pending: completed stages with their milliseconds, and a running "312 ms" counter on the right.
  - Landed: "Landed in 412 ms · slot 312,456,789 · Reduced".
  - Failed: the reason plus the cost ("0.50 SOL not spent", or "Fee 0.000005 SOL charged").
- **Line 3** (11 `text-3`): the signature `4xQe…9KmP` (mono) with `Copy` 12 px, "Solscan" with `ArrowUpRight` 12 px, then a "Latency" `ChevronDown` toggle on the right.
- **Expanded breakdown** (`hairline` above, 18 px rows, mono 11 px):

  | Step | Delta | Bar |
  |---|---|---|
  | Click → built (the arrow is the `ArrowRight` 10 px icon) | +4 ms | 48 px bar, `text-3` fill on a `surface-3` track |
  | Built → signed | +9 ms | |
  | Signed → server | +38 ms | |
  | Sent · Helius Sender | +12 ms | |
  | Sent · Jito | +15 ms | |
  | Landed | +341 ms | Largest segment in `text-2` |
  | Total | 419 ms | |

- **Failed actions:** "Retry" (`secondary` xs, same parameters) and, for slippage failures, "Raise slippage to 30%" (ghost xs).
- **Stage bar** (pending only): 2 px along the bottom edge, 4 segments filled `text-2` as stages complete, current segment `text-3`. Only the fill changes; nothing loops.
- **Timing:** pending persists. Landed dismisses after 4,000 ms (paused on hover or focus). Failed persists until dismissed. Esc dismisses the focused toast.
- **Accessibility:** pending and landed use `role="status"` with `aria-live="polite"`; failed uses `role="alert"`. No other toast has a live region.
- **Other toasts** (non-trade events only): server-side armed, filled or cancelled orders, connection restored, alert triggered. Same container, an icon plus one line plus an optional action ("Undo", "View"), 4,000 ms, no live region.
- **Never toast:** copy confirmations, preset switches, navigation results, "settings saved" (show "Saved" inline).
- Borrowed from:
  - Phantom: an in-progress toast followed by a past-tense success ([opened](https://mobbin.com/screens/c5d3a411-f5d2-4618-bfb4-0eb2abcbf5d4)), and a one-line "Swapped Cash → SOL" ([flow](https://mobbin.com/flows/cf0c99a3-89db-459f-a7ea-069e4856dc5f)).
  - [Solflare](https://mobbin.com/flows/3a34df63-f2e0-454d-8a1a-d95d5fd95f4c): a success state with Transaction ID and Explorer rows.
  - [Binance](https://mobbin.com/screens/14a47c59-4122-498b-ab2e-4ff6d611c85c): a top-right order-cancelled toast with icon, title and body.
  - [Origin](https://mobbin.com/screens/8ba60340-dbbf-4a23-985a-4cd6b27f7653): status icon, title, body and close.
  - [Canny](https://mobbin.com/screens/8794989c-4116-4894-9684-2fd8f4761652): an inline "Undo" action.
  - [Mercury](https://mobbin.com/screens/0903bf94-3358-4414-8806-7f26e941f9c0): a compact dark one-liner.

### 4.14 Metric tooltips and tooltips

- **Trigger:** metric labels get a 1 px dotted underline in `text-3` (2 px offset) and `cursor: help`.
- **Timing:** 400 ms hover delay, or immediate if another tooltip closed less than 500 ms ago. Focus shows it immediately. On touch, tapping the label toggles a popover with the same content and a close button.
- **Box:** max 280 px wide, padding 8 × 10 px, 6 px radius, `surface-3` (dark) or `surface-1` (light), 1 px `hairline-strong`, `e1`, `z-tooltip`, `pointer-events: none` (the touch popover accepts pointer events). Placed on top, flipping to the bottom, 6 px offset, no arrow.
- **Metric content:**
  1. The label at 12/600 `text-1` on the left, the current value in band colour on the right.
  2. The definition at 11/400 `text-2`, at most 3 lines, from SPEC "Token metric definitions".
  3. Bands at 10 px `text-3`, written out (no ≥ glyph, see 2.2): "Green under 20% · Amber 20–35% · Red 35% or more".
  4. "Updated 2s ago" at 10 px `text-3`; the touch popover adds "Methodology", which opens `/metrics`.
- **Generic tooltip:** one line at 11/400 `text-1`, optionally ending in keycaps ("Buy 0.25 SOL" + Space B).
- Borrowed from:
  - [OKX](https://mobbin.com/screens/f26041bc-ccc7-43f8-b492-2959191e63ae): dotted-underlined labels ("Equity", "In use") that carry definitions.
  - [Coinbase Advanced](https://mobbin.com/screens/9b76c57a-9ae9-408f-bbd1-f4955a00d544): the fee-tier explanation right next to the number.
  - [Kraken](https://mobbin.com/screens/7e080d39-6f61-43d1-8a4d-78ddfa5da1f8): a dotted "Incl. $0.72 fee" label.
  - [Binance Smart Money](https://mobbin.com/screens/09771a99-b9ea-406e-b3de-aed9a2fe4fb3): dotted "Exit Rate" and "Max Gain" labels.

### 4.15 Command palette

- **Open:** ⌘K / Ctrl+K, or "/" outside inputs, or a click on the top-bar search.
- **Frame:** 640 px wide (max `calc(100vw - 32px)`), max 520 px tall, 12vh from the top, 8 px radius, `surface-2` (light: `surface-1`), 1 px `hairline-strong`, `e2`, `z-palette`, over the scrim (no blur).
- **Input row** (44 px): `Search` 16 px `text-3`, the input at 14/400 (placeholder "Search token, CA, wallet or command" in `text-4`), a scope chip ("Tokens ×"), an "Esc" keycap.
- **Scope row** (28 px): All · Tokens · Wallets · Devs · Actions. Tab and Shift+Tab cycle.
- **Results:** group labels at 10/600 uppercase, +0.06em, `text-3`, 24 px tall: RECENT, TOKENS, WALLETS, DEVS, ACTIONS.
  - Token row (36 px): avatar 20 · ticker 13/600, name 12 `text-3`, `CA…pump` mono 11 `text-3` · age 11 `text-2` · MC 12 `text-1` (8ch, right) · liquidity 12 `text-2` (8ch) · 1h change, signed (7ch) · quick-buy pill on hover or selection.
  - Wallet row (32 px): avatar 16, label or address (mono), tags, a "Track" `secondary` xs, holdings count in `text-3`.
  - Action row (28 px): icon 14 px `text-3`, label 12 `text-1`, keycaps on the right.
  - Selected row: `surface-3` with a 2 px `accent` bar on the left. Pointer hover moves the selection.
  - An exact pasted CA puts "Open WIF · exact match" first, with the line "Buy 0.25 SOL" and its keycaps (⌘ Enter).
- **Preview pane** (viewport 1280 px and up): the palette widens to 880 px and gains a 240 px column with a 1-hour mini chart, MC / liquidity / volume / holders in a 2 × 2 grid, the risk chips and dev info. Updates on selection, debounced 80 ms.
- **Footer** (28 px, `hairline` on top), 11 `text-3` with keycaps: "↑↓ navigate · Enter open · ⌘ Enter buy 0.25 SOL · ⌘ C copy CA · Tab scope · Esc close" (⌘ as the `Command` icon on macOS, "Ctrl" elsewhere). On the right: "128 results".
- **Empty:** "No matches for "bonkk"", then "Paste a contract address to open any token" in `text-3`. **Loading:** 3 skeleton rows, shown only after 150 ms.
- **Keyboard:** Up/Down, PgUp/PgDn, Home/End. Enter opens. ⌘Enter quick-buys. ⌘C copies the CA or address. Tab/Shift+Tab change scope. Esc clears the query, then closes.
- **Actions included:** Go to Pulse (G P), Toggle USD/SOL (T C), Switch to P2 (Alt 2), Toggle Instant Trade (Shift I), Lock keystore (⌘⇧L), Open settings (⌘,), Show shortcuts (?), Export trading key (opens its settings section), Panic (opens the hold-to-confirm dialog).
- Borrowed from:
  - [Vapi](https://mobbin.com/screens/593d7acd-2e16-4365-bcd6-02ce52f48f3b): Actions / Recent / All sections, footer key hints, result count.
  - [Fey](https://mobbin.com/screens/ff52ac90-4d18-4765-98da-df1e362a5ee1): context actions for the selected ticker with single-key caps.
  - [Superhuman](https://mobbin.com/screens/85dc5994-9360-428d-9092-7425e070ed7f): a keycap on every command.
  - [Dropbox Dash](https://mobbin.com/screens/0567ef26-d68b-4674-a6ee-8d255bbe7990): a preview pane and footer action keys.
  - [OpenSea search](https://mobbin.com/screens/f603ab17-6650-4db3-ad20-56b6e5579863): category scopes, compact result rows with tabular counts.
  - [Uniswap](https://mobbin.com/screens/864dda50-5223-47c7-ad05-80bc1ddb77fd): recent searches and popular tokens with price and 24h change.
  - [Linear search](https://mobbin.com/screens/d0b98680-66e2-47d4-9dc4-28bc9450c27f): scope chips and a plain "No results found for…".

### 4.16 Filter modal (Pulse)

- **Modal:** 720 px wide, max 640 px tall, centred, 8 px radius.
- **Header (44 px):** "Filters" at 14/600, column tabs (New Pairs 3 · Final Stretch · Migrated 1, counts = active filters). Right: preset slots 1 | 2 | 3 (xs segmented), Import (`Upload` 14), Export (`Download` 14), Share (`Link` 14), `X`.
- **Body:**
  - Left nav, 168 px (`surface-1`, `hairline` on the right): Keywords · Protocols · Quote tokens · Audit · $ Metrics · Socials. 28 px items at 12/500, with a 6 px `text-1` dot after sections that have active filters.
  - Right content scrolls, padding 16 px.
- **Range rows** (Audit, $ Metrics): 28 px tall, laid out as label column 160 px | min 88 px | "–" `text-3` | max 88 px | clear `X` on hover.
  - Labels at 12/500 `text-1` with the unit at 11 `text-3` ("Top 10 holders (%)").
  - Inputs 24 px, values right-aligned, placeholders "Min" and "Max" in `text-4`. Accept "5k" and "1.2m".
  - Min above max: both borders `sell` and the helper "Min is above max" at 11 `sell`.
  - Group headers at 11/600 `text-3`, 24 px, 16 px above.
- **Protocols:** 24 px checkbox rows (14 px checkbox, label 12, live token count in `text-3` on the right), with "Select all / None".
- **Keywords:** Include and Exclude inputs (28 px) with chip tokens, comma-separated. Help: "Matches name or ticker, case-insensitive."
- **Socials:** checkboxes: Has X, Has website, Has Telegram, At least one social, Dex paid.
- **Footer** (52 px, `hairline` on top): left, "Reset column" (ghost) and "Apply to all columns" (`secondary`); right, a live count "128 tokens match now" at 12 `text-2` and "Apply" (`primary`, ⌘↵).
- **Behaviour:**
  - Edits update the live count (debounced 250 ms, against the in-memory feed). Apply commits.
  - Unknown is not zero. A metric the server sends as `null` (MC, price, liquidity or volume in SOL for a token quoted in a mint with no known SOL value; audit metrics before they are computed) fails any min or max set on it, so the token drops out while that filter is active. "Max MC 50 SOL" must not let an exotic-quoted token through as "0 SOL". The copy-trade filters and price alerts follow the same rule (packages/protocol `market.ts` header).
  - Esc with unsaved changes shows "Discard changes? Press Esc again" in the footer; a second Esc discards.
  - Presets: 3 slots per column. ⌘S saves to the current slot. Import accepts our versioned JSON and Axiom-style exports (field names per the feature inventory).
- **Keyboard:** Up/Down between rows, Tab between inputs, Ctrl+1 to Ctrl+6 jump to sections, ⌘↵ applies, ⌘S saves, Esc as above.
- Borrowed from:
  - Axiom ([inventory](../research_notes/Solana%20trading%20terminal%20teardown/axiom_feature_inventory.md)): per-column filters, the 14 metrics, 3 presets, import/export/share, Apply All.
  - [Juicebox](https://mobbin.com/screens/b94f8a11-6713-466e-a9d5-d08e558ba525): left section nav with active dots, a live match count, a save action.
  - [OKX filter drawer](https://mobbin.com/screens/e1788cb5-4baf-4097-966e-527f1193cc64): a label plus min–max pair per row, Reset/Apply footer.
  - [Wellfound](https://mobbin.com/screens/cf9f9476-04ad-4123-8f82-d733fd122ed6): active chips and a results count.
  - [GetYourGuide](https://mobbin.com/screens/6a1fb39a-89fe-45ae-9c8a-10cc20e4664a): "Show 128 results".
  - [Fey](https://mobbin.com/screens/0caf65f6-dcdc-451d-ae2c-5e8c47e1efff): the active-filter chips echoed back in the column header.

### 4.17 Drawers, modals, popovers and menus

**Modal**
- Widths: 400 px (confirm), 560 px (forms), 720 px (filters), 880 px (share). 8 px radius. `surface-2` (light: `surface-1`).
- Header 44 px: title at 14/600 (an optional 12 px `text-3` description raises it to 60 px) and a 28 px close button with a 16 px icon. Body padding 16 px. Footer 52 px with a `hairline` on top, buttons right-aligned, primary last.
- Motion: enter is opacity plus translateY 4 px → 0 over 200 ms; exit 130 ms. Over the scrim.
- Focus is trapped. Esc closes (dirty forms use the two-press rule). Focus returns to the trigger.
- **Confirm dialog:** the title names the action ("Cancel 3 armed orders for WIF?"), the body states the consequence in one sentence, and the buttons name both outcomes: "Keep orders" (`secondary`) and "Cancel orders" (`sell`). Never "Are you sure?".
- **Countdown confirm:** the primary button reads "Buy anyway (3)", counting down 3 → 1, then enables as "Buy anyway".
- **Hold-to-confirm:** the button fills left to right over 1,000 ms while pressed (pointer, or Space/Enter held). Releasing early cancels. With reduced motion it shows "Hold 1 s" and a numeric countdown.

**Drawer:** from the right; 400, 560 or 720 px wide; full viewport height; 0 radius; 1 px `hairline-strong` on the left; `e2`. Header 48 px. Enter: 16 px slide plus fade over 200 ms.

**Popover:** 6 px radius, padding 4 px (menus) or 12 px (forms), `surface-2` (light: `surface-1`), `hairline-strong`, `e1`, `z-popover` (+10 inside overlays). 4 px from its anchor, flips to stay in the viewport. Closes on outside pointerdown, Esc, or another click on the anchor.

**Menu items:** 28 px tall, 8 px padding, icon 14 px `text-3`, label 12 `text-1`, right side keycaps (`text-3`) or `ChevronRight` 12 px for submenus. Separators are 1 px `hairline` with 4 px vertical margin. Group labels at 10/600 uppercase `text-3`. Checkbox items show `Check` 14 px on the left. Keyboard: Up/Down, Home/End, type-ahead, Enter/Space, Right opens a submenu, Left closes it, Esc closes the menu.

Borrowed from:
- [OKX](https://mobbin.com/screens/a2bb80c5-27d1-4a5e-a87e-7c852a2d38f3): menu items with right-aligned shortcut hints.
- [Linear](https://mobbin.com/screens/ed670cda-0527-4716-a1a6-0159f12c4f42): a filter menu with submenus.
- [DoorDash](https://mobbin.com/screens/147163b2-eef8-40be-b199-dae113a33d9c): a details drawer over a list.
- [Monzo](https://mobbin.com/screens/c73a3c93-eb1e-4c54-80c9-27e68531e9d0): a countdown-enabled "Continue anyway (4s)".
- [Mintlify](https://mobbin.com/screens/a704b533-fd36-4209-9f6e-30f49be34cde): a two-column danger zone with explicit consequences.

### 4.18 Empty, loading and error states

**Empty** (inside its panel): vertically centred in the panel's first 240 px, max 320 px wide, an optional 16 px icon in `text-3`, a title at 13/500 `text-2`, one sentence at 12 `text-3` saying what fills the panel and when, and at most one action (`secondary` sm). Examples:
- Trades: "No trades yet" / "New trades appear within about a second of landing."
- Positions: "No open positions" / "Buy from Pulse, or press / to search."
- Armed orders: "No armed orders" / "Arm a limit, take-profit or stop-loss from any token page." + "Open Pulse".

**Loading:**
- Skeleton rows at the exact row height, under the real headers. Bars are 8 px tall, 2 px radius, `surface-3`; text cells 60% of the column width, numeric cells 40% and right-aligned; avatars as squares.
- No shimmer and no pulse. After 3 s, the panel header adds "Still loading · feed lag 4.2 s" in `text-3`.
- Spinners only for in-flight user actions: 14 px, linear 1 s rotation, `text-2`.

**Error:** inline in its panel.
- `AlertTriangle` 14 px `warn`, "Couldn't load holders. Retrying in 5 s.", and "Retry now" (ghost xs).
- After 3 failures: a `sell` icon, "Holders unavailable", and "Retry".
- A failed panel never replaces the page.

**Connection loss:** the status bar shows "Reconnecting 3" with a `warn` dot, and a 28 px banner appears under the top bar (`warn-tint`, `warn` text): "Live data paused. Reconnecting… Trading is disabled until the feed is live." Trade CTAs read "Feed offline".

**Stale data:** a panel whose data is more than 5 s old shows a "Stale 6s" chip (`warn` on `warn-tint`) in its header and renders values in `text-3`.

Borrowed from:
- [Coinbase Advanced](https://mobbin.com/screens/f8afc154-e5c8-4587-ab43-93c4799a979a): a small icon and "No orders" inside the table.
- [OKX](https://mobbin.com/screens/f26041bc-ccc7-43f8-b492-2959191e63ae): one line and one action ("Try it now").
- [fal](https://mobbin.com/screens/a8b7726c-26bd-49bc-8cc6-f0a6d03d47c8): an info icon and one sentence.
- [Square](https://mobbin.com/screens/09371ef3-f0d0-4fc9-8ab1-607ab3d0e4ab) and [DoorDash](https://mobbin.com/screens/f470af91-c889-487f-a2a2-87d69a60a781): skeleton rows under real headers.
- [Gemini](https://mobbin.com/screens/c6637b1c-7ddc-4343-b390-1840fe6dc4a5): an inline widget error. We add retry timing.

### 4.19 Onboarding steps

**Desktop layout:** no top-bar nav and no status bar. The logo sits top-left, 24 px from the edges. A left rail (280 px) holds a vertical stepper. The content column is at most 440 px wide and starts 64 px from the top.

**Stepper:**
- Items 44 px tall. Numbered circles 20 px:
  - Done: `Check` 12 px in `ink` on `accent`.
  - Current: `accent` fill with the number in `ink` at 11/600.
  - Upcoming: a 1 px `hairline-strong` ring with the number in `text-3`.
- A 1 px `hairline` connects the circles.
- Labels at 12/500 (`text-1` when current, `text-3` otherwise), with an 11 px `text-3` sub-label once done ("Phantom · 7xKX…sAsU").

**Steps:**
1. **Connect wallet.** 44 px rows: the wallet's icon (24 px, supplied by Wallet Standard), the name at 13/500, and a "Detected" tag (`text-2` on `surface-3`), or "Not installed" in `text-3` with an install link. The row being connected shows a spinner on its right.
2. **Sign in.** A mono block (`surface-2`, 4 px radius, padding 12 px, mono 11/400 `text-2`) showing the exact SIWS message: domain, full address, statement, nonce, issued at, expires at. Copy: "This signature proves you own this wallet. It can't move funds." Primary: "Sign in with Phantom".
3. **Create the trading wallet.** Segmented "Passkey (recommended) | Passphrase". The passphrase path has an input, a confirm input, and a live checklist ("12+ characters", "Not a common password"; `Check` 12 px turns `buy` when met). Note in `text-3`: "The key is generated and encrypted in this browser. zerofee never receives it." Primary: "Create wallet".
4. **Back up.**
   - The key is masked with "•" characters (no blur).
   - "Hold to reveal" (600 ms, or hold Space) shows the base58 key in mono 13/500, visually grouped in 4-character blocks with 4 px gaps. Copy copies it without the grouping.
   - Actions: "Copy" and "Download encrypted backup (.json)".
   - Verification: "Enter characters 7, 19 and 41 of your key" with three 32 × 32 px single-character inputs. A check appears when they're correct.
   - Primary "I saved it" stays disabled until verified. This step can't be skipped (SPEC).
5. **Limits.** Per-trade cap (default 5 SOL), daily cap (50 SOL) and auto-lock (15 min), each with help text. A summary of the default preset P1 (slippage, priority, tip, Reduced) with an "Edit" link.
6. **Fund.** Segmented "From Phantom | Deposit address".
   - From Phantom: an amount input with presets 0.5 / 1 / 2 / 5 and "Transfer 1 SOL" (opens the wallet approval).
   - Deposit address: a 160 px QR on a white plate with 4 px radius (for scan contrast in dark mode), the full address in mono (`break-all`), Copy, and "Send SOL on Solana only."
   - A watcher row reads "Waiting for deposit · 0 SOL" (`text-3`), then "Received 1.00 SOL" (`buy`) with the slot.
   - "Skip for now" (ghost) is allowed on this step only.
7. **Done.** A status checklist: Signed in as 7xKX…sAsU; Trading wallet created (passkey); Backup verified; Funded 1.00 SOL (or "Not funded · Fund later" in `warn`). Primary: "Open Pulse". Tip: "Press ? any time for shortcuts."

**Mobile:** the stepper becomes a segmented progress bar at the top (4 px tall) with "Step 2 of 7" at 11 `text-3`.

**Rules:** no illustrations, no hero text, one primary action per step, a "Back" ghost xs (`ArrowLeft` 14 px) at the top-left of the content. Only Fund can be skipped.

Borrowed from:
- [OKX deposit](https://mobbin.com/flows/a6c83dd1-51f7-4e6f-95da-faff776eb1ca): a vertical stepper with numbered circles and checks.
- [Uniswap](https://mobbin.com/flows/9aaa402b-0d7a-4960-8261-57602073bb6c): wallet rows with a spinner on the one connecting.
- [Tally](https://mobbin.com/flows/7791b9e6-611e-4cb0-ae5c-b767bd662931): a wallet list with badges.
- [Phantom](https://mobbin.com/screens/fa3d1040-f206-4de4-b236-435f1760fd1e) and [MoonPay](https://mobbin.com/screens/948ec472-ffa7-464e-b166-0ca51ee60fc6): a secret hidden until revealed, and "OK, I saved it".
- [Family](https://mobbin.com/flows/3b9d8526-346d-4f7e-a778-6d35de6de9de): the reveal interaction and a recovery phrase / private key toggle.
- [Lloyds](https://mobbin.com/screens/4a81b310-337b-404b-8e19-efc674b8ca31): verifying characters at given positions.
- [Marcus](https://mobbin.com/screens/2fb82752-386b-4dbd-a84d-49c5b75eab7e): a live requirement checklist.
- [Proton](https://mobbin.com/flows/62f54e4d-a558-4be2-98e2-6dcb560ca29f): a recovery status checklist.
- [Base](https://mobbin.com/screens/21ac15ea-e128-4153-a664-722950025ce9): a segmented step bar on mobile.

### 4.20 Armed-orders list

**Header strip** (48 px, `surface-1`, `hairline` at the bottom, padding 12 px):
- "Armed orders" at 14/600.
- Summary at 12 `text-2`: "7 armed · 3 need re-arm · 12.5 SOL reserved".
- Nonce meter: "Nonce slots 7/10", a 64 × 4 px bar (`accent` on `surface-3`), "0.0074 SOL rent" in `text-3`, and "Manage" (ghost xs).
- On the right, "Panic": `danger` styling with hold-to-confirm (1,000 ms) and the label "Hold to cancel all and lock".

**Tabs** (32 px): All 12 · Armed 7 · Needs re-arm 3 · Filled 2 · Consumed 1 · Cancelled.

**Table** (data grid, 28 / 32 px rows), grouped by token. Group headers are 28 px: avatar 16, ticker, "Holding 1.24M · avg 12.4K", and "Cancel all for WIF" (ghost xs) on the right.

| Column | Width | Content |
|---|---|---|
| Status | 16ch | 6 px dot + label: Armed (`info`), Sending (`warn`, with elapsed time), Filled (`Check` 12 px `text-1`, "Filled 412 ms"), Consumed (`sell`, "Consumed · re-arm"), Needs re-arm (`warn`, reason in a tooltip such as "pump.fun upgrade changed accounts"), Cancelled (`text-4`) |
| Type | 10ch | Limit buy, Limit sell, TP1, SL, Migration sell, Trailing |
| Trigger | 14ch | "MC above 120K", "MC below 8.0K" (words, not ≥ ≤) |
| Distance | 8ch | Signed % from current MC, in `text-2` (a distance is not PnL) |
| Size | 12ch | "Sell 25%", "Buy 0.50 SOL" |
| Variants | 10ch | "6 · 3 tips" (min-out grid size × tip levels) |
| Nonce | 8ch | "#4", plus a link icon when OCO-shared |
| Lane | 8ch | "Jito" |
| Armed | 5ch | Age |
| Actions | 12ch | "Cancel" (`danger` xs), "Re-arm" (`secondary` xs), "..." |

**Row detail:** clicking a row opens a 560 px drawer with the order details, the min-out grid (variant, min out, tip), the nonce account (mono), the pre-signed cancel status ("Ready"), and a timeline (armed, price checks, attempts with slot, result). The SPEC rules appear as plain text: "One landed attempt per nonce. A failed attempt consumes the nonce; re-arm to try again."

**Keyboard:** Up/Down rows, Enter opens details, Delete cancels (confirm dialog), `R` re-arms, `G O` opens the page.

Borrowed from:
- [Vercel deployments](https://mobbin.com/screens/e9576405-bcef-419a-922a-8fb84b044a54): a status dot plus label plus duration.
- [Square orders](https://mobbin.com/screens/14618499-6730-4721-9822-bad566504229): status tabs with counts.
- [Railway](https://mobbin.com/screens/ea8d53dc-8270-430d-bbdd-1df73b4ca531): severity tints.
- [Phantom](https://mobbin.com/screens/14c8763d-ef0c-4cad-b0b4-97eca2a52c43): an "Auto Close: set take profit and stop loss" entry card on the position.

### 4.21 PnL share card

**Dialog:** 880 × 560 px. The card preview sits on the left (rendered to PNG with Satori and scaled to fit 520 px), controls on the right (320 px).

**Card formats:** landscape 1200 × 675 (default, for X and Telegram) and portrait 1080 × 1350.
- Background: flat (`#090A0C` for the dark template, `#F5F6F7` light, or pure black/white for Mono). No gradient, glow or illustration. 48 px safe margin.
- Top-left: the zerofee mark (32 px) and wordmark (24/600). Top-right: "Oct 3, 2026 · 14:22 UTC" at 20 px `text-3`.
- Token row: avatar 72 px (image or monogram), "$WIF" at 48/600 `text-1`, the name at 24 px `text-2`.
- Hero: PnL % "+248.6%" at 128/600 in `buy` (`sell` when negative). Under it, "+1.24 SOL · $148.20" at 36/500 `text-1`.
- Stats row, 4 columns (labels 18 px `text-3`, values 28/600 `text-1`): Invested 0.50 SOL · Returned 1.74 SOL · Held 18m · Entry → exit MC 12.4K → 43.2K (the arrow is SVG, not a glyph).
- Optional mini chart in the right third: the position's path as a 3 px `text-2` line, with entry (`buy` dot) and exit (`sell` dot), no fill.
- Footer: "zerofee · 0% platform fee" at 20 px `text-3`, plus an optional 96 px QR that links to the home page (no referral IDs).

**Controls:**
- Primary metric: segmented % | SOL | USD.
- Template: Dark | Light | Mono.
- Toggles: Include chart; Show amounts (off = % only); Show wallet label (off by default, for privacy).
- Format: Landscape | Portrait.
- Actions: "Copy image" (`primary`, ⌘C), "Download PNG" (`secondary`), "Post to X" (`secondary`; opens the intent URL with prefilled text only after the click).

**Rules:** the card uses Plex (Satori loads the same font files), numbers follow section 3, and every value comes from real fills.

Borrowed from:
- [Binance's poster](https://mobbin.com/screens/fa184fc0-d47a-4ad5-a927-fd920bc4808f): the hierarchy (ROI big, PnL, cut-off time, brand footer with QR). We drop its 3D art.
- [Public](https://mobbin.com/screens/5be7661b-2f1b-4af1-98ca-abe4cf3edb63): a $ / % toggle and template switching.
- [Perplexity](https://mobbin.com/screens/bf6f870b-1e78-404c-944b-0769c8ee0606): Copy image / Download image and a show/hide toggle.
- [OKX](https://mobbin.com/flows/da0213e4-f24e-49db-8b9f-b0db144267b3): the card on the left with share options on the right.

### 4.22 Token avatars and monograms

- **Token image:** a square with 4 px radius (sizes 16, 20, 28, 32, 40, 48 px) and a 1 px inner `hairline` (`box-shadow: inset 0 0 0 1px`), `object-fit: cover`, `loading="lazy"`, `decoding="async"`. Images come through our image proxy (CSP `img-src 'self'`).
- **Missing image:** a monogram. One or two characters (the ticker's first characters, uppercase; digits allowed), Plex Sans 600 at 40% of the box height, `text-1`, on one of 8 muted backgrounds picked by `hash(mint) % 8`:
  - Dark: `#603D3C` `#5B422A` `#494A2A` `#31503C` `#225052` `#304B61` `#474361` `#593D52` (`text-1` contrast 7.5–7.9:1)
  - Light: `#F5D5D4` `#EFDAC6` `#DFE1C6` `#CDE5D4` `#C4E6E7` `#CCE1F4` `#DDDBF4` `#EED6E7` (13.3–13.7:1)
- **Wallet avatars:** circles of 16, 20 or 24 px. A user-chosen emoji is centred at 70% size; otherwise a 2-letter monogram from the label (or the first 2 address characters) on the same palette.
- Bonding ring and launchpad badge: 4.4.
- Borrowed from:
  - [Xero](https://mobbin.com/screens/44ed8739-8ccb-4d6f-a532-7a31b1fa5c5f): initials on muted squares.
  - [Binance Meme Rush](https://mobbin.com/screens/972c602f-95aa-44ba-9cd3-1f869d9a58c3): a status border and launchpad badge on the avatar.

### 4.23 Inputs, switches, checkboxes, sliders and keycaps

- **Text and number inputs:** control height (24 / 28 px), 4 px radius, `surface-2`, 1 px `hairline-strong`, 8 px padding, text at data size (14 px for amount inputs), placeholders in `text-4`.
  - Focus: 2 px `focus` ring outside, border unchanged.
  - Invalid: `sell` border and an 11 px `sell` helper.
  - Disabled: `surface-1`, `text-4`.
  - Numbers are right-aligned; units are a `text-3` suffix.
- **Select:** the same frame with `ChevronDown` 12 px `text-3`. It opens a menu (4.17).
- **Switch:** a 28 × 16 px pill track.
  - Off: `surface-3` with 1 px `hairline-strong`, a 12 px `text-3` knob. On: `accent` track, `ink` knob.
  - The knob moves over 140 ms. The label sits on the left (12 `text-1`), with help text under it.
- **Checkbox:** 14 × 14 px, 2 px radius, 1 px `hairline-strong`. Checked: `accent` fill with `Check` 12 px in `ink`. Indeterminate: `Minus` 12 px.
- **Slider:** a 2 px `surface-3` track, `accent` fill, a 12 px `accent` circle thumb with a 2 px `bg` ring, 1 × 4 px `hairline-strong` ticks. Keyboard: Left/Right step, Shift multiplies by 10, Home/End.
- **Keycap:** 16 px tall, min-width 16 px, 4 px padding, 2 px radius, `surface-3`, 1 px `hairline-strong`, Plex Mono 500 at 10 px `text-2`.
  - Modifiers: `Command`, `ArrowBigUp` and `Option` icons (10 px) on macOS; "Ctrl", "Shift", "Alt" elsewhere.
  - Chords read "G then P", with "then" at 10 px `text-3`. Space is written "Space".
- **Copy control:** `Copy` 12 px `text-3` swaps to `Check` 12 px `text-1` for 1,200 ms, and its `aria-label` becomes "Copied".
- Borrowed from:
  - [Gemini](https://mobbin.com/screens/2271e5e3-4a73-4fa3-aad3-24e7bd6e2ad1) and [OKX](https://mobbin.com/screens/c3ca83ef-f1de-4703-abbf-aa02ff6fa1ff): dark filled inputs with unit suffixes.
  - [Perplexity](https://mobbin.com/screens/b0a63cb0-ff2e-49a9-90ab-b4dff7f8084d) and [Obvious](https://mobbin.com/screens/d1f418bb-9d1a-40b6-a7b5-7b294ef64703): keycaps and modifier legends.

---

## 5. Screen blueprints

The reference viewport is 1440 × 900 CSS px with compact density. The y values below are the top edges of each band.

### 5.1 Pulse

```
y=0    +----------------------------------------------------------------------------------------+
       | Top bar 40                                                                             |
y=40   +----------------------------------------------------------------------------------------+
       | Pulse toolbar 32: [Columns v] [Display v] [Blacklist 14] [Sound]    [Live|Calm] [Pause all] [Legend] |
y=72   +------------------------------+-----------------------------+---------------------------+
       | New Pairs 214    ...  hdr 36 | Final Stretch 38  ... hdr 36| Migrated 61   ...  hdr 36 |
y=108  +------------------------------+-----------------------------+---------------------------+
       | card 68                      | card 68                     | card 68                   |
       | card 68                      | card 68                     | card 68                   |
       | ... 11 full cards            | ...                         | ...                       |
       | 480 px                       | 479 px                      | 479 px                    |
y=876  +------------------------------+-----------------------------+---------------------------+
       | Status bar 24                                                                          |
y=900  +----------------------------------------------------------------------------------------+
```

- **Columns:** three `1fr` tracks separated by 1 px hairline gaps (480 / 479 / 479 px).
- **Cards visible per column:**

| Viewport | Column width | Card variant | Full cards visible |
|---|---|---|---|
| 1440 × 900 | 479 px | wide | 11 (Axiom's docs screenshot shows about 9) |
| 1920 × 1080 | 639 px | wide+ | 13 |
| 1280 × 800 | 426 px | wide | 9 |
| 1024 × 768 | 341 px | narrow | 9 |

- **Toolbar (32 px):**
  - Columns menu: show, hide and reorder columns via drag handles.
  - Display popover: card fields as a list with drag handles and switches (socials, counters, mini chart, F/NB), plus card density.
  - Blacklist: opens a modal with tokens, devs, funding wallets and X handles; the button shows the count.
  - Sound: toggle.
  - Insert mode "Live | Calm" (6.7), "Pause all" (Shift+P), legend toggle.
- **768–1023 px:** two columns. Column 1 is New Pairs; column 2's header switches between Final Stretch and Migrated.
- **Below 768 px:** 5.8.
- Display popover borrowed from:
  - [Shopify columns popover](https://mobbin.com/screens/909c6cdb-f0a1-4183-ab1c-b64f3f2c9aa2): drag handles plus visibility toggles.
  - [Kraken widget toggles](https://mobbin.com/screens/25b67ef9-d56e-4f69-865f-16a702da74b7): checkbox list with drag handles.

### 5.2 Token page

```
y=0    | Top bar 40                                                                                 |
y=40   +--------------------------------------------------------------------------------------------+
       | [ava28] WIF dogwifhat   | MC $12.3K | Price 0.0(5)1234 | Liq $8.42K | Vol $31.2K | 5m +12.4% | ... |  [star][bell][share][Instant] |
       | 9Hd4cZ...pump  2m X w t |  (display-2) stats strip with hairline dividers                    |  48 px |
y=88   +------------------------------------------------------------------+-------------------------+
       | Chart toolbar 32                                                 | Trade panel 320         |
y=120  | Chart canvas 1119 x 409                                          |  side 28 / type 28      |
       |                                                                  |  amount + presets 76    |
       |                                                                  |  summary 24 / cost 24   |
       |                                                                  |  CTA 36                 |
y=529  +--------------------- splitter (1 px, 8 px hit area) --------------+-------------------------+
       | Tabs 32: Trades 1.2K | Positions | Orders 2 | Holders 1,284 | Top traders | Dev tokens   | Position strip 48 |
y=561  | Trades toolbar 28                                                +-------------------------+
y=589  | 14 rows x 20 px                                                  | Token info 32 + 3 x 40  |
y=876  +------------------------------------------------------------------+-------------------------+
       | Status bar 24                                                                              |
```

- **Token header (48 px):**
  - Left block: two 20 px lines.
    - Line 1: avatar 28, ticker 14/600, name 12 `text-3`.
    - Line 2: CA (mono) with copy, age, socials.
  - Stats strip, each cell a micro label over a data value, with hairline dividers between cells: MC (`display-2`), Price, Liquidity, Volume 24h, 5m / 1h / 24h change, Holders, and on the curve "BC 87%" with a 32 × 2 px bar.
  - Actions on the right: watchlist `Star`, alert `Bell`, `Share2`, and an "Instant" toggle for the Instant Trade window.
- **Main area (88–876, 788 px):**
  - Chart panel defaults to 56% (toolbar 32 + canvas 409). The splitter is persisted per user, with minimums of 240 px (chart) and 160 px (tables).
  - Tables take the remaining 347 px: tabs 32, toolbar 28, then 14 dense rows.
- **Right rail:** 320 px, scrolls independently: trade panel (4.11), position strip, token info.
- **Instant Trade default position:** x = 1440 − 320 − 296 − 12 = 812, y = 88 + 32 + 12 = 132 (the chart's top-right corner).
- **Other viewports:**
  - 1920 × 1080: chart 1599 px wide; 968 px of main area gives the chart 542 px and the tables 18 rows.
  - 1280 × 800: rail 300 px; chart 385 px, tables 303 px.
  - 1024–1279 px: rail 288 px; token info moves into an "Info" table tab.
  - 768–1023 px: stacked. Header on two rows, chart 360 px, trade panel full width (amount and presets on the left, summary and CTA on the right), then tables.
- Header stats strip borrowed from:
  - [OpenSea PENGU](https://mobbin.com/screens/d07a9d5b-cd19-4c4b-a600-0ba26e29c68c): micro labels over values in the top-right.
  - [Fey](https://mobbin.com/screens/7f8ae731-3b5f-42c7-bc83-dd04ecbd04f2): one strip with dividers instead of cards.
  - [Base](https://mobbin.com/screens/5d35e943-618c-402a-a9e8-2d8addd1f612): market cap as the headline number with price underneath.

### 5.3 Portfolio

```
y=0    Top bar 40
y=40   +-------------------------------------------------------------------------------------------+
       | Balance $3,812.40 | Available 2.412 SOL | Unrealized +$124.10 | Realized 30d +$1,204.88 | Win rate 58% |
       |   (display-1)     |   ...stat strip, hairline dividers...        [7d|30d|Max]  [Search other wallets 240] | 64
y=104  +-----------------------------------------------------------+-------------------------------+
       | PnL chart 1119 x 240 (baseline at 0: buy above, sell below) | Performance 320               |
       |                                                           |  Total PnL +$4.13K            |
       |                                                           |  Trades 252  [buy|sell bar]   |
       |                                                           |  >500%      3  ===            |
       |                                                           |  200-500%   7  =====          |
       |                                                           |  0-200%    96  ============   |
       |                                                           |  0 to -50% 121 ==============|
       |                                                           |  < -50%    25  ====           |
y=344  +-----------------------------------------------------------+-------------------------------+
       | Tabs 32: Active positions 12 | History | Activity | Wallets 3        [Show hidden] [USD|SOL]  |
y=376  | Positions grid, 28 px rows (17 visible)                                                    |
y=876  Status bar 24
```

- **Header strip:** the balance in `display-1`. Other cells are micro labels over 13/600 values; PnL values signed. Win rate counts closed positions only (SPEC).
- **PnL chart:** a Lightweight Charts baseline series at 0. Fill above is `buy` at 10%, below `sell` at 10%; the line is 1.5 px in the same colours. No gradient. The crosshair tooltip shows date and PnL.
- **Performance:**
  - Total PnL at 16/600, signed.
  - Trade count with a 4 px buy/sell split bar.
  - Five bucket rows (24 px): a 6 px dot (`buy` for the three positive buckets, `sell` for the two negative), label, count on the right, and a proportional bar in `text-3` at 50%.
- **History tab:** a "List | Calendar" toggle.
  - Calendar (P1): a 7-column month grid with 32 px cells, the day's PnL at 10 px in signed colour, a flat `buy-tint` or `sell-tint` cell fill (no intensity scale), and the month total in the header.
- **Wallets tab:** label, address, balance, holdings, SOL reserved by armed orders, and actions (Fund, Withdraw, Export with hold-to-confirm, Archive).
- **Viewing another wallet:** entering an address shows that wallet read-only, with a 28 px banner "Viewing 7xKX…sAsU · read-only · Back to my portfolio".
- Borrowed from:
  - Axiom's portfolio ([docs](https://docs.axiom.trade/axiom/portfolio)): balance, PnL chart, performance buckets, positions, activity, search other wallets.
  - [Binance assets](https://mobbin.com/screens/5acd0f5e-9019-4e1f-95e1-1446bbccd036): balance, today's PnL, period toggle, "Hide assets <1 USD".
  - [Binance copy-trader performance](https://mobbin.com/screens/b92a460e-23dc-40d5-8a9b-cd79d8eb9b7d): ROI/PnL toggle with win rate, positions and drawdown as dotted-label rows.
  - [Gemini](https://mobbin.com/screens/fe564b29-e2e7-43ff-8c21-9d9861d24ea1): a chart coloured above and below a reference line.
  - [Origin](https://mobbin.com/screens/c70e093b-4236-4168-b870-9200d0fe71a3): a "Pro view" density toggle and return chips.

### 5.4 Trackers

```
Top bar 40
Toolbar 40: Tabs [Wallets 128] [Live trades] [Monitor] [X (P1)]           [Search 240] [Import] [Export] [Add wallet]
At 1280 px and up: left 400 px = Wallet manager | right flex = Live trades or Monitor (tabs)
Below 1280 px: one pane, chosen by tab
```

- **Wallet manager** (28 px rows): checkbox 14 · avatar 16 (emoji or monogram) with name at 12/500 · short mono address with copy · alerts toggle (`Bell`/`BellOff` 14) · Added (age) · Last trade (age) · "..." (edit, remove).
- **Add wallet modal** (400 px): emoji (optional, no default), name, address (validated base58), alerts switch, "Add wallet".
- **Live trades** (dense rows): age · wallet (avatar 16 + name) · side B/S · token (avatar 16 + ticker + token age in `text-3`) · SOL (side colour, 3 decimals) · MC at trade · quick-buy pill.
  - Toolbar (28 px): side segmented All / Buys / Sells, Min SOL, MC range, launchpad menu, "Only tokens under 1h".
- **Monitor** (28 px rows): token · tracked holders (`Eye` + count) · net flow over 15 minutes (signed SOL) · first tracked buy (age) · MC · risk chips · quick-buy. Sorted by tracked holders.
- **Docks:** the status-bar toggles open a floating dock (360 × 420 px, 6 px radius, `e2`, `z-dock`) anchored bottom-left above the status bar, with compact live trades in dense rows. This matches Axiom's bottom-left tracker placement.
- Borrowed from:
  - Axiom's wallet tracker ([docs](https://docs.axiom.trade/wallet-tracking/adding-wallets)): Wallet Manager and Live Trades, import/export, alerts bell.
  - [Binance Smart Money](https://mobbin.com/screens/37ad2b16-f814-48d2-861a-6f396445f479) and its [signal timeline](https://mobbin.com/screens/09771a99-b9ea-406e-b3de-aed9a2fe4fb3): "N smart wallets bought" with exit rate and max gain, the model for Monitor.
  - [Base social feed](https://mobbin.com/screens/0ee5ef3f-8693-4e21-971f-8975e9157712): "someone bought $X" rows tied to a token card.

### 5.5 Settings

A right drawer, 720 px wide.

```
+------------------------------------------------------------------+
| Settings                                                [X]  48  |
+--------------+---------------------------------------------------+
| [search]     | Section title 14/600                              |
| Trading      | Description 12 text-3                             |
|   Presets    | Row: label 12/500 + help 11 text-3  | control 200 |
|   Landing    | Row ...                       (min 44 px, hairline)|
|   Limits     |                                                   |
| Hotkeys      |                                                   |
| Display      |                                                   |
| Wallets and  |                                                   |
|   security   |                                                   |
| Alerts       |                                                   |
| Metrics      |                                                   |
| About        |                                                   |
| 176 px       | 544 px (padding 16)                               |
+--------------+---------------------------------------------------+
```

- **Nav:** a search input at the top, then 28 px items at 12/500; the active item is `text-1` on `surface-3`.
- **Rows:** at least 44 px, `hairline` between them. A flexible label column (label 12/500, help 11 `text-3`) and a 200 px control column, right-aligned.
- **Presets:**
  - Tabs P1 / P2 / P3. For each side (Buy, Sell): slippage %, priority fee, tip.
  - Landing preset as radio rows showing route, tip and note from the SPEC table. Fast's note is in `warn`.
  - Amounts: trade-panel buys ×4, sell % ×4, Instant buys ×4, Instant sell % ×4 and SOL ×4.
- **Hotkeys editor:**
  - A "Trade hotkeys" master switch, search (240 px) and "Reset all" (ghost).
  - 32 px rows: action (12) · bindings as keycaps (click one to record; "+" adds a second) · reset (ghost xs).
  - Recording: the cell shows "Press keys…" with the focus ring; Esc cancels.
  - Conflicts show inline in `warn`: "Used by Buy preset 1 · Replace".
  - Groups: General, Trading, Pulse, Token page, Navigation.
- **Display:** Theme (Dark | Light | System), Density, Colour vision, Quote currency (USD | SOL), Pulse insert mode, toast position, risk thresholds (five min/max rows prefilled with 3.11 defaults, plus "Reset"), sound volume, "Confirm trades on touch devices" (5.8).
- **Wallets and security:**
  - Trading wallets, auto-lock minutes, passkey or passphrase change.
  - Export key: hold-to-confirm, then the reveal flow (4.19).
  - Withdrawal destinations: the connected wallet by default; others show an "Active in 23h 12m" badge (24 h delay).
  - Nonce slots: count, rent, "Reclaim rent".
  - Sessions: device list with revoke.
  - Danger zone (two columns): Panic, Remove trading wallet.
- **Alerts:** channels (Web Push, Telegram, Discord) with connection chips, and per-event toggles.
- **Metrics:** the published definitions and active thresholds.
- **About:** version, build hash, licences (NOTICE).
- Borrowed from:
  - [Devin](https://mobbin.com/screens/93170d84-7435-4c89-82b5-647330913aba): searchable nav, grouped rows with the control on the right.
  - [Zoho](https://mobbin.com/screens/8291b6de-66e5-495e-91a8-c8a2b6525956): a shortcut editor with keycaps as buttons, a master toggle and "Reset shortcuts".
  - [Toggl](https://mobbin.com/screens/c6f9271e-5854-4174-bee5-691005237d18): an "Allow keyboard shortcuts" toggle and click-to-reveal secrets.
  - [Mintlify](https://mobbin.com/screens/a704b533-fd36-4209-9f6e-30f49be34cde): a danger zone with written consequences.
  - [OpenSea](https://mobbin.com/flows/5ab8ab32-84d8-4c0b-81a8-9604e657b23e): a CONNECTED chip with Disconnect for linked accounts.

### 5.6 Onboarding

```
+----------------------------------------------------------------------------------+
| [mark] zerofee      (24, 24)                                                     |
|                                                                                  |
|  (rail x 24, y 96, w 280)       (content x 344, y 64, max-w 440)                 |
|  (1) Connect wallet              Step title 16/600                               |
|  (2) Sign in                     One-line description 13 text-2                  |
|  (3) Trading wallet              [step body]                                     |
|  (4) Back up                     [one primary action]                            |
|  (5) Limits                                                                      |
|  (6) Fund                                                                        |
|  (7) Done                                                                        |
+----------------------------------------------------------------------------------+
```

Behaviour and step content: 4.19. Content stays top-left aligned, never vertically centred.

### 5.7 Armed orders

```
Top bar 40
Header strip 48: Armed orders | 7 armed · 3 need re-arm · 12.5 SOL reserved | Nonce slots 7/10 [====  ] 0.0074 SOL [Manage] | [Hold to cancel all and lock]
Tabs 32: All 12 | Armed 7 | Needs re-arm 3 | Filled 2 | Consumed 1 | Cancelled
Group 28: [ava] WIF · Holding 1.24M · avg 12.4K                                   [Cancel all for WIF]
Rows 28: status | type | trigger | distance | size | variants | nonce | lane | armed | actions
...
Status bar 24
```

The row detail drawer (560 px) is specified in 4.20.

### 5.8 Mobile variants

Reference: 375 × 812, iOS PWA in standalone mode. All touch targets are at least 44 × 44 px; visual size may be smaller with a padded hit area.

- **Header (44 px, under `env(safe-area-inset-top)`):** the 20 px mark, a quick-buy chip ("0.25"), the balance "2.41 SOL", and a search button (44 × 44 hit area).
- **Bottom tabs (56 px + `env(safe-area-inset-bottom)`):** Pulse · Discover · Trackers · Portfolio · Orders. Icons 20 px, labels 10/500. The active tab is `text-1` with a 2 px `accent` bar on top; inactive tabs are `text-3`. The current `MobileNav` uses the orange accent and must change.

**Pulse (mobile)**

```
[safe area]
Header 44
Segmented 36: [ New 214 | Final 38 | Migrated 61 ]   (12 px gutters)
Filter row 32 (chips + [Filters]) when any filter is active
Rows 64:
 [ava 36] WIF  25s  V $5.04K                 MC $11.2K
          [T 18%][D 2.0%][S 0%][I 0%][B 6%]  [ z 0.25 ]
Bottom tabs 56 + safe area
```

- Row padding is 10 px top and bottom, 12 px sides.
  - Line 1 (20 px): ticker 14/600, age 12 `text-2`, volume 12 `text-3`; MC at 13/600 on the right.
  - Line 2 (24 px): risk chips with letters (216 px fits the 223 px available); the quick-buy pill (24 px visual, 44 px hit area) on the right.
- Visible rows: (812 − 44 safe area − 44 − 36 − 90 tabs) / 64 = 9.
- Tapping a row opens the token page; tapping the pill buys.
- Borrowed from [Binance Meme Rush](https://mobbin.com/screens/972c602f-95aa-44ba-9cd3-1f869d9a58c3): New / Finalizing / Migrated tabs and two-line rows with MC and volume on the right.

**Token page (mobile)**

```
Header 44: [<] [ava 24] WIF                                [star] [share]
Price block 64: MC $12.3K (display-2)  +12.4% 5m;  Price 0.0(5)1234 · Liq $8.42K (12 text-2)
Chart 240 (no toolbar)
Timeframes 36: [1s 1m 5m 15m 1h]  [MC|Price]
Risk strip 40: T 18% · D 2.0% · S 0% · I 0% · B 6.0%
Tabs 36: Trades | Holders | Info | Orders
List rows 44
Sticky trade bar 64 + safe area: [0.25 v] [ Buy WIF 0.25 ] [ Sell ]
```

- The sticky bar holds an amount chip (72 px, opens the preset chips), "Buy" (`buy`, flexible width, 44 px) and "Sell" (`sell-tint`, 88 px).
- "Sell" opens a bottom sheet: % chips 25 / 50 / 75 / 100, Sell initials, and the CTA.
- **Confirm on touch:** Settings > Display > "Confirm trades on touch devices" is on by default. With it on, tapping Buy opens a compact review sheet (cost summary plus one CTA). This is friction proportional to mis-tap risk; it can be turned off.
- The Instant Trade window becomes a bottom sheet with a 2 × 4 grid of 44 px buttons.
- Mobile toasts appear top-centre under the header.
- **Portfolio (mobile):** balance in `display-1`, a 160 px PnL chart, 7d / 30d / Max, and position rows of 56 px (token, value, signed PnL on two lines).
- Borrowed from:
  - [Phantom token page](https://mobbin.com/screens/76e93b20-0652-4758-8e2d-4925312a1fba): price headline, change chip, timeframe row, sticky Buy.
  - [Perplexity mobile](https://mobbin.com/screens/392af3df-0977-47e5-8545-825064ac6052): a compact 3 × 3 stats grid.
  - [Cash App](https://mobbin.com/screens/3c393e1e-5d4a-4387-874f-281996eead50): an amount-preset grid in a bottom sheet.
  - [Public](https://mobbin.com/screens/00b5bb2e-ab18-40db-abe1-26a5248bed62): an action grid.
  - [Phantom review](https://mobbin.com/screens/65eff589-ab7c-4289-a456-68a161f019c2): a compact confirmation sheet.

---

## 6. Interaction and motion rules

### 6.1 Hover
- Hover changes colour only: rows go to `surface-2`; controls follow their variant (4.6).
- `cursor: pointer` only on actionable elements; data cells keep the default cursor.
- Nothing critical is hover-only. Every hover affordance (quick-buy hint, copy, tooltip) has a tap and keyboard equivalent.

### 6.2 Press
- Pressing steps colour to the variant's press token. No scale, translate or shadow change.
- Trade buttons hold their pressed state for 300 ms after release, so the trader sees the click registered.

### 6.3 Focus
- `:focus-visible`: a 2 px solid `focus` outline with a 2 px offset. Inside rows, cells and segmented items, the offset is −1 px (inset), so rings don't overlap neighbours.
- Never `outline: none` without this replacement.
- Focus order follows visual order. Modals, drawers and the palette trap focus and return it to their trigger on close.
- The first focusable element is a "Skip to main content" link, visible on focus.

### 6.4 Keyboard paths

Every action is in this table, in the shortcut sheet, and in its control's tooltip. Bindings are remappable in Settings > Hotkeys. ⌘ means Ctrl on Windows and Linux.

| Scope | Action | Default binding |
|---|---|---|
| Global | Command palette | `/` or ⌘K |
| Global | Close the top layer, clear selection | Esc |
| Global | Settings | ⌘, |
| Global | Shortcut sheet | ? |
| Global | Toggle Instant Trade | Shift+I |
| Global | Preset P1 / P2 / P3 | Alt+1 / Alt+2 / Alt+3 |
| Global | Go to Discover / Pulse / Trackers / Portfolio / Orders / Settings | G then D / P / T / W / O / S |
| Global | Toggle USD/SOL | T then C |
| Global | Toggle density | T then D |
| Global | Lock keystore | ⌘⇧L |
| Global | Panic (opens the hold-to-confirm dialog) | ⌘⇧Backspace |
| Pulse | Focus column 1 / 2 / 3 | 1 / 2 / 3 |
| Pulse | Previous / next column | H / L (or Left / Right) |
| Pulse | Move card cursor | J / K (or Down / Up); Home / End |
| Pulse | Open token / in a new tab | Enter / ⌘Enter |
| Pulse | Quick-buy the cursor or hovered card with the column amount | Space+B |
| Pulse | Buy with preset amounts 1–4 | Space+1 … Space+4 |
| Pulse | Copy CA | C |
| Pulse | Hide token (blacklist, with an "Undo" toast) | X |
| Pulse | Blacklist dev (confirm) | Shift+X |
| Pulse | Filters for the focused column | F |
| Pulse | Pause or resume column / all columns | P / Shift+P |
| Pulse | Search within the column | / while the column has focus |
| Token page | Buy preset amounts 1–4 | Space+1 … Space+4 |
| Token page | Sell preset % 1–4 | Space+Q / W / E / R |
| Token page | Sell initials | Space+T |
| Token page | Quick-buy amount | Space+B |
| Token page | Trade side Buy / Sell | B / S |
| Token page | Market / Limit / Advanced | M / L / A |
| Token page | Previous / next timeframe | [ / ] |
| Token page | Toggle MC / Price | Shift+M |
| Token page | New alert at the crosshair | Alt+A |
| Token page | Bottom tabs 1–6 | Shift+1 … Shift+6 |
| Token page | Unlock (when locked) | U |
| Tables | Move rows / open / details | Up/Down / Enter / Shift+Enter |
| Orders | Cancel the selected order (confirm) / re-arm | Delete / R |
| Palette | Navigate / open / quick-buy / copy / scope | Up/Down / Enter / ⌘Enter / ⌘C / Tab |
| Filter modal | Apply / save preset / section | ⌘Enter / ⌘S / Ctrl+1…6 |
| Chart order line | Move / move ×10 / arm / delete / cancel | Up/Down / Shift+Up/Down / Enter / Delete / Esc |
| Instant Trade (focused) | Move between buttons / press | Arrow keys / Enter |

**Trade-hotkey rules**
- Trade hotkeys require Space to be held. While trade hotkeys are on, Space's default page scroll is prevented outside inputs.
- They're disabled when focus is in an editable field, when a modal, drawer or the palette is open, when trade hotkeys are off, or when the keystore is locked. A locked press shows one toast, "Unlock to trade", with an Unlock action.
- **Target:** the hovered card if the pointer is over one, otherwise the keyboard cursor card on Pulse; the open token on the token page. The target ticker is visible in the Instant Trade header.
- **Repeat guard:** identical trades (same token, side and amount) within 600 ms from the mouse are dropped. Holding a key never auto-repeats a trade; each trade needs a fresh keydown after keyup.

### 6.5 Drag
- **Instant Trade window:** dragged by the header with pointer capture. Snaps within 12 px, persisted, Esc cancels a drag in progress.
- **Chart order lines:** 4.10.
- **Token-page splitter:** 8 px hit area, minimums 240 px (chart) and 160 px (tables), double-click resets to 56%, persisted.
- **Columns and table columns:** reordered from their menus (drag handles inside the popover), never by dragging the column itself. That keeps live areas stable.
- Every drag has a keyboard equivalent and ignores pointer moves under 3 px (so clicks don't become drags).

### 6.6 Value-change flashes and highlights

| Element | Effect | Duration | Throttle |
|---|---|---|---|
| Token header MC and price | Text colour jumps to `buy` or `sell`, then transitions back to `text-1` | 600 ms, `ease-standard` | 2 per second |
| New trade-tape row | Row background starts at `flash-buy`/`flash-sell` and fades to transparent | 600 ms | Per row |
| Trade-panel PnL | Text colour flash | 600 ms | 2 per second |
| New Pulse card | Background starts at `highlight` and fades out | 1,200 ms | Per card |
| Pulse card values (MC, V, chips) | None. Values update in place. | n/a | n/a |

- Implementation: toggle a class that sets the start colour, then let a CSS transition return it. Row backgrounds animate the opacity of a `::before` overlay (compositor-friendly), never `background-color` on hundreds of rows.
- Reduced motion: no flashes or highlights. The token header shows the last tick direction as ↑ or ↓ in `text-3` next to the value; new cards and rows get a 2 px `text-3` left edge for 1,200 ms instead.

### 6.7 New rows, pausing and live calm

- **Pause on hover or focus:** while the pointer is over a Pulse column, or focus is inside it, the column freezes order and membership. Values keep updating in place. Queued insertions show the "↑ N new" bar. On pointer leave, the queue applies after 300 ms in a single batch.
- **Scrolled lists:** in any list scrolled away from the top (Pulse, tapes, feeds), new rows don't move the viewport. `scrollTop` is adjusted by the inserted height, and a "↑ N new" pill appears.
- **Insert mode (Pulse toolbar):** "Live" inserts at the feed rate (lists coalesce at 4–10 Hz, SPEC). "Calm" inserts at most once per second, in batches. Default: Live.
- **Mis-click guard:** a card's quick-buy is disabled for its first 250 ms on screen.
- **No layout shift on update:** fixed row heights, fixed column widths in `ch`, tabular digits, and values that never wrap (3.12). Check: record 60 s of a busy Pulse with the Performance panel; Layout Shift entries must be 0 outside user-initiated actions.
- **Reordering:** sorted lists (Final Stretch by progress, Monitor by tracked holders) re-sort at most every 2 s, and never while paused.
- **Sound** (optional, per column, default off): a 60 ms tick for new pairs and a distinct 90 ms tone for your fills, at most one sound per 500 ms.

---

## 7. Accessibility

Target WCAG 2.2 AA, with these specifics:

1. **Contrast:**
   - Information text (`text-1`, `text-2`, `text-3`, `buy`, `sell`, `warn`, `info`, `risk-low`) is at least 4.5:1 on `surface-1`, `surface-2` and `surface-3` in both themes (measured in 2.1).
   - `text-4` is for disabled text and placeholders only.
   - The focus ring is at least 3:1 against every surface (measured 5.0–8.2:1).
   - Chips: text on its tint is at least 5.0:1.
2. **Focus:** visible on every interactive element (6.3). No focus traps outside modal layers. The order is logical.
3. **Target size:** desktop targets are at least 24 × 24 CSS px (WCAG 2.5.8), or spaced so 24 px circles don't overlap. Dense 16–20 px controls (copy icons, chips with tooltips, social icons) extend their hit area with a transparent `::before`. Mobile targets are at least 44 × 44 px.
4. **Colour alone:** side is also written (B/S, Buy/Sell), direction is signed (+/−), risk is numeric, status has a label next to the dot. The blue/orange palette is one setting away.
5. **Reduced motion:** `prefers-reduced-motion` removes flashes, highlights, slides and spinners (2.8, 6.6).
6. **Live regions:** only transaction toasts use them (`status`/polite for pending and landed, `alert` for failed). Live data (Pulse, tapes, prices) is never in a live region; screen-reader users query values on demand.
7. **Semantics:**
   - Tables use `<table>` with `<th scope="col">`, or the ARIA grid pattern for virtualised lists (`role="grid"`, `aria-rowcount`, `aria-rowindex`).
   - Segmented controls are radiogroups. Tabs follow the tablist pattern. Menus follow the menu pattern. Dialogs set `aria-modal` and are labelled by their title.
   - Every icon-only button has an `aria-label` that matches its tooltip.
8. **Numbers for screen readers:** each formatted number's `aria-label` carries the plain decimal ("0.000004123"). Chips read as "Top 10 holders 18 percent, low risk".
9. **Text scaling:** layouts survive 200% browser zoom without horizontal page scroll (tables scroll inside their panel). Sizes use px to keep density, but nothing clips at 200%.
10. **`prefers-contrast: more`:** `hairline` goes to `#3A3D42` (dark) / `#B8BBBE` (light), `text-3` takes the `text-2` value, and tints go to 20% (dark) / 12% (light) (9.1).

---

## 8. Performance budgets

| Area | Budget | How to verify |
|---|---|---|
| Pulse frame rate | 60 fps (no frame over 16.7 ms) with 3 virtualised columns receiving updates at 10 Hz each, 40 visible cards, and scrolling | Chrome Performance panel, 30 s recording; scripting at most 6 ms per frame |
| Update coalescing | WebSocket deltas buffered and applied once per `requestAnimationFrame`. Lists render at the user's rate (4–10 Hz, default 6 Hz). The focused token's tape flushes every 50–100 ms (SPEC). | Code review plus a performance mark per flush |
| DOM size | At most 45 nodes per Pulse card, at most 6,000 nodes on the Pulse page, at most 120 mounted card rows across columns | `document.querySelectorAll('*').length` in a busy session |
| Re-render scope | A token update re-renders only the cards whose displayed strings changed (memoised rows keyed by mint, selector per field) | React Profiler: an MC tick renders one card |
| Clock | One shared 1 Hz clock for ages. Zero per-row timers. | `grep` for `setInterval` in components |
| Long tasks | No task over 50 ms while streaming. Filter recomputation runs in under 4 ms per column per flush, or moves to a worker. | Performance panel, Long Tasks |
| Interaction | Click or key to optimistic toast within one frame (16 ms). INP p75 under 100 ms. | Web Vitals in dev builds |
| Memory | JS heap under 150 MB after 30 minutes of streaming, with no growth trend | Memory panel snapshots at 0, 15 and 30 min |
| Initial JS | Up to 170 KB gzip for the shell + Pulse route (React, router, zustand, virtual, app code) | `vite build` report |
| Token route | Up to 60 KB gzip excluding the chart | Build report |
| Chart | Lightweight Charts in its own lazy chunk (about 45 KB gzip), loaded only on the token page and portfolio, prefetched on hover of a Pulse card for more than 150 ms | Build report and Network panel |
| Fonts | 92.9 KB woff2 on first load (Plex Sans latin plus Plex Mono 400 and 500). latin-ext only via `unicode-range`. Plex Sans latin is preloaded. | Network panel |
| CSS | Up to 25 KB gzip | Build report |
| Icons | Named lucide imports only; no icon font, no `import *` | `grep` for `from "lucide-react"` patterns |
| Images | Token images proxied, at most 2× the display size, lazy-loaded, decoded async; monograms render with no network | Network panel |

Lightweight Charts runs with `autoSize`. Candle updates use `series.update()`, never `setData()` per tick. Marker sets update at most 4 times per second.

---

## 9. Implementation mapping for apps/web

This section is written against the parallel worktree as read on 2026-10-03 (branch at `1b36e85`: Vite 8, React 19, Tailwind v4.3 via `@tailwindcss/vite`, tokens in `src/index.css` as `--zf-*` variables mapped through `@theme inline`, lucide-react, Lightweight Charts 5.2.1). Pulse, token, portfolio, trackers, orders, onboarding and settings pages are placeholders there, so they should be built directly to this spec.

### 9.1 CSS variables (`src/index.css`)

Replace the current palette block with this one. Variable names are final.

```css
@import "tailwindcss";

/* ---------- Dark (default) ---------- */
:root,
:root[data-theme="dark"] {
  color-scheme: dark;
  --zf-bg: #090a0c;
  --zf-surface-1: #0f1113;
  --zf-surface-2: #15171a;
  --zf-surface-3: #1e2124;
  --zf-surface-3-hover: #25282c;
  --zf-floating: var(--zf-surface-2);   /* popovers, menus, modals, toasts, windows */
  --zf-tooltip: var(--zf-surface-3);
  --zf-hairline: #232529;
  --zf-hairline-strong: #32363b;
  --zf-text-1: #e9ebee;
  --zf-text-2: #b2b6bc;
  --zf-text-3: #858a90;
  --zf-text-4: #5a5e64;
  --zf-accent: #e9ebee;
  --zf-accent-hover: #f9fafb;
  --zf-accent-press: #ced1d5;
  --zf-ink: #090a0c;
  --zf-focus: #75aef5;
  --zf-buy: #3dca8d;
  --zf-buy-hover: #4ed799;
  --zf-buy-press: #23ba7d;
  --zf-sell: #fa6b6d;
  --zf-sell-hover: #ff7a7b;
  --zf-sell-press: #e85b5e;
  --zf-warn: #f3b743;
  --zf-info: #73b0ee;
  --zf-risk-low: #71b28f;
  --zf-chart-grid: #16181b;
  --zf-scrim: rgb(0 0 0 / 0.56);
  --zf-shadow-e1: 0 2px 8px rgb(0 0 0 / 0.32);
  --zf-shadow-e2: 0 8px 24px rgb(0 0 0 / 0.4);
  --zf-tint: 14%;
  --zf-edge: 32%;
  --zf-flash: 18%;
  --zf-highlight-a: 6%;
  --zf-mono-0: #603d3c; --zf-mono-1: #5b422a; --zf-mono-2: #494a2a; --zf-mono-3: #31503c;
  --zf-mono-4: #225052; --zf-mono-5: #304b61; --zf-mono-6: #474361; --zf-mono-7: #593d52;
}

/* ---------- Light ---------- */
:root[data-theme="light"] {
  color-scheme: light;
  --zf-bg: #f5f6f7;
  --zf-surface-1: #ffffff;
  --zf-surface-2: #f1f2f4;
  --zf-surface-3: #e6e8ea;
  --zf-surface-3-hover: #dde0e3;
  --zf-floating: var(--zf-surface-1);
  --zf-tooltip: var(--zf-surface-1);
  --zf-hairline: #dee0e2;
  --zf-hairline-strong: #c6c9cd;
  --zf-text-1: #13161b;
  --zf-text-2: #494d54;
  --zf-text-3: #5f646a;
  --zf-text-4: #94999e;
  --zf-accent: #13161b;
  --zf-accent-hover: #2a2e34;
  --zf-accent-press: #040609;
  --zf-ink: #ffffff;
  --zf-focus: #145ec1;
  --zf-buy: #00774c;
  --zf-buy-hover: #00673f;
  --zf-buy-press: #005734;
  --zf-sell: #ba2b2e;
  --zf-sell-hover: #a71922;
  --zf-sell-press: #920917;
  --zf-warn: #8f5805;
  --zf-info: #125fb3;
  --zf-risk-low: #307252;
  --zf-chart-grid: #eef0f2;
  --zf-scrim: rgb(19 22 27 / 0.32);
  --zf-shadow-e1: 0 2px 8px rgb(16 22 30 / 0.1);
  --zf-shadow-e2: 0 8px 24px rgb(16 22 30 / 0.14);
  --zf-tint: 8%;
  --zf-edge: 28%;
  --zf-flash: 14%;
  --zf-highlight-a: 5%;
  --zf-mono-0: #f5d5d4; --zf-mono-1: #efdac6; --zf-mono-2: #dfe1c6; --zf-mono-3: #cde5d4;
  --zf-mono-4: #c4e6e7; --zf-mono-5: #cce1f4; --zf-mono-6: #dddbf4; --zf-mono-7: #eed6e7;
}

/* ---------- Colour-vision palette (Settings > Display) ---------- */
:root[data-cvd="blue-orange"] {
  --zf-buy: #60aaf3; --zf-buy-hover: #6db6ff; --zf-buy-press: #519ae2;
  --zf-sell: #f59740; --zf-sell-hover: #ffa659; --zf-sell-press: #e4882c;
  --zf-risk-low: var(--zf-text-2);
}
:root[data-theme="light"][data-cvd="blue-orange"] {
  --zf-buy: #125fb3; --zf-buy-hover: #07519d; --zf-buy-press: #004388;
  --zf-sell: #a14c00; --zf-sell-hover: #8f3e00; --zf-sell-press: #7c3300;
}

/* ---------- Derived (resolve per theme automatically) ---------- */
:root {
  --zf-risk-mid: var(--zf-warn);
  --zf-risk-high: var(--zf-sell);
  --zf-buy-tint: color-mix(in srgb, var(--zf-buy) var(--zf-tint), transparent);
  --zf-sell-tint: color-mix(in srgb, var(--zf-sell) var(--zf-tint), transparent);
  --zf-warn-tint: color-mix(in srgb, var(--zf-warn) var(--zf-tint), transparent);
  --zf-info-tint: color-mix(in srgb, var(--zf-info) var(--zf-tint), transparent);
  --zf-risk-low-tint: color-mix(in srgb, var(--zf-risk-low) var(--zf-tint), transparent);
  --zf-buy-edge: color-mix(in srgb, var(--zf-buy) var(--zf-edge), transparent);
  --zf-sell-edge: color-mix(in srgb, var(--zf-sell) var(--zf-edge), transparent);
  --zf-warn-edge: color-mix(in srgb, var(--zf-warn) var(--zf-edge), transparent);
  --zf-flash-buy: color-mix(in srgb, var(--zf-buy) var(--zf-flash), transparent);
  --zf-flash-sell: color-mix(in srgb, var(--zf-sell) var(--zf-flash), transparent);
  --zf-bar-buy: color-mix(in srgb, var(--zf-buy) 10%, transparent);
  --zf-bar-sell: color-mix(in srgb, var(--zf-sell) 10%, transparent);
  --zf-highlight: color-mix(in srgb, var(--zf-text-1) var(--zf-highlight-a), transparent);
}

/* ---------- High contrast (selectors match the theme blocks' specificity and come later, so they win) ---------- */
@media (prefers-contrast: more) {
  :root:not([data-theme]),
  :root[data-theme="dark"] { --zf-hairline: #3a3d42; --zf-text-3: var(--zf-text-2); --zf-tint: 20%; }
  :root[data-theme="light"] { --zf-hairline: #b8bbbe; --zf-text-3: var(--zf-text-2); --zf-tint: 12%; }
}

/* ---------- Density ---------- */
:root,
:root[data-density="compact"] {
  --zf-row: 24px; --zf-row-dense: 20px; --zf-header-row: 28px;
  --zf-card: 68px; --zf-card-avatar: 40px; --zf-control: 24px;
  --zf-topbar: 40px; --zf-panel-header: 32px; --zf-col-header: 36px; --zf-statusbar: 24px;
  --zf-pad: 8px; --zf-font-data: 12px; --zf-lh-data: 16px; --zf-font-label: 11px; --zf-lh-label: 14px;
  --zf-num-stretch: 92%;
}
:root[data-density="comfortable"] {
  --zf-row: 28px; --zf-row-dense: 24px; --zf-header-row: 32px;
  --zf-card: 80px; --zf-card-avatar: 48px; --zf-control: 28px;
  --zf-topbar: 44px; --zf-panel-header: 36px; --zf-col-header: 40px; --zf-statusbar: 24px;
  --zf-pad: 12px; --zf-font-data: 13px; --zf-lh-data: 18px; --zf-font-label: 12px; --zf-lh-label: 16px;
  --zf-num-stretch: 100%;
}

/* ---------- Motion and layers ---------- */
:root {
  --zf-dur-1: 80ms; --zf-dur-2: 140ms; --zf-dur-3: 200ms; --zf-dur-flash: 600ms; --zf-dur-highlight: 1200ms;
  --zf-ease-standard: cubic-bezier(0.2, 0, 0, 1); --zf-ease-exit: cubic-bezier(0.4, 0, 1, 1);
  --zf-z-sticky: 10; --zf-z-chart-ui: 20; --zf-z-dock: 300; --zf-z-popover: 400; --zf-z-drawer: 500;
  --zf-z-modal: 600; --zf-z-palette: 700; --zf-z-toast: 800; --zf-z-tooltip: 900;
}
@media (prefers-reduced-motion: reduce) {
  :root { --zf-dur-1: 0ms; --zf-dur-2: 0ms; --zf-dur-3: 0ms; --zf-dur-flash: 0ms; --zf-dur-highlight: 0ms; }
}
```

Base layer rules to add:

```css
@layer base {
  html, body, #root { height: 100%; }
  body {
    margin: 0; background: var(--zf-bg); color: var(--zf-text-1);
    font-family: var(--font-sans); font-size: 13px; line-height: 18px; font-weight: 400;
    -webkit-font-smoothing: antialiased; overscroll-behavior: none;
  }
  ::selection { background: color-mix(in srgb, var(--zf-focus) 35%, transparent); }
  :focus-visible { outline: 2px solid var(--zf-focus); outline-offset: 2px; }
  * { scrollbar-width: thin; scrollbar-color: var(--zf-hairline-strong) transparent; }
}
@layer components {
  .zf-num { font-variant-numeric: tabular-nums; font-stretch: 100%; }
  .zf-num-dense { font-stretch: var(--zf-num-stretch); }
  .zf-unit { color: var(--zf-text-3); font-size: var(--zf-font-label); }
  .zf-dim { color: var(--zf-text-3); }                 /* trailing zeros in tapes */
  .zf-zc { font-size: 0.72em; line-height: 0; vertical-align: -0.28em; margin: 0 0.06em; }
}
```

### 9.2 Tailwind v4 `@theme` mapping

Resetting a namespace (`--color-*: initial`) removes Tailwind's default palette, so off-token colours can't be used. Do it in two steps: first add the tokens next to the current ones, then reset the namespaces and fix the usages in one PR. Tailwind's static keywords (`transparent`, `current`, `inherit`) don't depend on the theme and keep working. Text colours are aliased to `fg-*`, which avoids awkward `text-text-1` classes.

```css
@theme inline {
  --color-*: initial;
  --color-bg: var(--zf-bg);
  --color-surface-1: var(--zf-surface-1);
  --color-surface-2: var(--zf-surface-2);
  --color-surface-3: var(--zf-surface-3);
  --color-surface-3-hover: var(--zf-surface-3-hover);
  --color-floating: var(--zf-floating);
  --color-tooltip: var(--zf-tooltip);
  --color-hairline: var(--zf-hairline);
  --color-hairline-strong: var(--zf-hairline-strong);
  --color-fg-1: var(--zf-text-1);
  --color-fg-2: var(--zf-text-2);
  --color-fg-3: var(--zf-text-3);
  --color-fg-4: var(--zf-text-4);
  --color-accent: var(--zf-accent);
  --color-accent-hover: var(--zf-accent-hover);
  --color-accent-press: var(--zf-accent-press);
  --color-ink: var(--zf-ink);
  --color-focus: var(--zf-focus);
  --color-buy: var(--zf-buy);
  --color-buy-hover: var(--zf-buy-hover);
  --color-buy-press: var(--zf-buy-press);
  --color-buy-tint: var(--zf-buy-tint);
  --color-buy-edge: var(--zf-buy-edge);
  --color-bar-buy: var(--zf-bar-buy);
  --color-sell: var(--zf-sell);
  --color-sell-hover: var(--zf-sell-hover);
  --color-sell-press: var(--zf-sell-press);
  --color-sell-tint: var(--zf-sell-tint);
  --color-sell-edge: var(--zf-sell-edge);
  --color-bar-sell: var(--zf-bar-sell);
  --color-warn: var(--zf-warn);
  --color-warn-tint: var(--zf-warn-tint);
  --color-warn-edge: var(--zf-warn-edge);
  --color-info: var(--zf-info);
  --color-info-tint: var(--zf-info-tint);
  --color-risk-low: var(--zf-risk-low);
  --color-risk-low-tint: var(--zf-risk-low-tint);
  --color-risk-mid: var(--zf-risk-mid);
  --color-risk-high: var(--zf-risk-high);
  --color-highlight: var(--zf-highlight);

  --font-*: initial;
  --font-sans: "IBM Plex Sans Variable", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace;

  --text-*: initial;
  --text-micro: 10px;  --text-micro--line-height: 12px;  --text-micro--letter-spacing: 0.02em;
  --text-label: var(--zf-font-label); --text-label--line-height: var(--zf-lh-label); --text-label--letter-spacing: 0.01em;
  --text-data: var(--zf-font-data);   --text-data--line-height: var(--zf-lh-data);
  --text-body: 13px;   --text-body--line-height: 18px;
  --text-heading: 14px; --text-heading--line-height: 20px;
  --text-title: 16px;  --text-title--line-height: 22px;
  --text-display-2: 20px; --text-display-2--line-height: 24px; --text-display-2--letter-spacing: -0.005em;
  --text-display-1: 28px; --text-display-1--line-height: 32px; --text-display-1--letter-spacing: -0.01em;

  --font-weight-*: initial;
  --font-weight-normal: 400; --font-weight-medium: 500; --font-weight-semibold: 600;

  --radius-*: initial;
  --radius-xs: 2px; --radius-sm: 4px; --radius-md: 6px; --radius-lg: 8px; --radius-full: 9999px;

  --shadow-*: initial;
  --shadow-e1: var(--zf-shadow-e1);
  --shadow-e2: var(--zf-shadow-e2);

  --ease-*: initial;
  --ease-standard: var(--zf-ease-standard);
  --ease-exit: var(--zf-ease-exit);

  --animate-*: initial;
  --animate-spin: spin 1s linear infinite;
  @keyframes spin { to { transform: rotate(360deg); } }

  --breakpoint-2xl: 90rem;  /* 1440 px */
  --breakpoint-3xl: 120rem; /* 1920 px */
}
```

Usage examples: `bg-surface-1`, `text-fg-3`, `border-hairline`, `bg-buy-tint text-buy border-buy-edge`, `rounded-sm`, `shadow-e2`, `text-data`, `h-(--zf-row)`, `z-(--zf-z-popover)`, `duration-(--zf-dur-1) ease-standard`. Spacing keeps Tailwind's 0.25rem (4 px) step.

### 9.3 Fonts

```bash
bun add @fontsource-variable/ibm-plex-sans@5.3.0 @fontsource/ibm-plex-mono@5.3.0
```

```ts
// src/main.tsx (before index.css)
import "@fontsource-variable/ibm-plex-sans/standard.css"; // wght 100-700 + wdth 75-100, all subsets via unicode-range
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./index.css";
```

- **Preload:** add a build-only Vite plugin (next to the existing `contentSecurityPolicy()`) whose `transformIndexHtml` finds the emitted `ibm-plex-sans-latin-standard-normal-*.woff2` asset in the bundle and injects `<link rel="preload" as="font" type="font/woff2" href="…" crossorigin>`. The CSP already allows `font-src 'self'`.
- **Licence:** append to `apps/web/NOTICE`: "IBM Plex Sans and IBM Plex Mono, Copyright 2017–2019 IBM Corp., licensed under the SIL Open Font License 1.1 (https://openfontlicense.org), shipped unmodified via @fontsource-variable/ibm-plex-sans 5.3.0 and @fontsource/ibm-plex-mono 5.3.0." Also copy the OFL text from the package `LICENSE` into `apps/web/licenses/OFL-IBM-Plex.txt` and show both in Settings > About.

### 9.4 Token migration (current to new)

| Current variable / class | New |
|---|---|
| `--zf-bg` / `bg-bg` | unchanged name, new value |
| `--zf-panel` / `bg-panel` | `--zf-surface-1` / `bg-surface-1` |
| `--zf-panel-2` / `bg-panel-2` | `--zf-surface-2` / `bg-surface-2` |
| `--zf-elev` / `bg-elev` | `bg-surface-3` (chips, active segments) or `bg-floating` (popovers, tooltips) |
| `--zf-hover` / `hover:bg-hover` | rows `hover:bg-surface-2`; controls `hover:bg-surface-3` / `hover:bg-surface-3-hover` |
| `--zf-line` / `border-line` | `border-hairline` |
| `--zf-line-strong` / `border-line-strong` | `border-hairline-strong` |
| `--zf-fg` / `text-fg` | `text-fg-1` |
| `--zf-muted` / `text-muted` | `text-fg-2` |
| `--zf-dim` / `text-dim` | `text-fg-3` |
| `--zf-accent` (orange `#ff8a3d`) | `--zf-accent` (neutral ink). Orange is removed from the product UI. |
| `--zf-accent-fg` / `text-accent-fg` | `--zf-ink` / `text-ink` |
| `--zf-violet` / `*-violet` | removed (TRK and KOL tags use `info`) |
| `--zf-chart-bg` | `--zf-surface-1` |
| `--zf-chart-grid` | `--zf-chart-grid` (new value) |
| `--zf-shadow` / `shadow-pop` | `shadow-e1` (popovers, tooltips) or `shadow-e2` (modals, toasts, windows) |
| `--zf-scrollbar` | `--zf-hairline-strong` |
| `text-[9px]`, `text-[10px]`, `text-[11px]`, `text-xs`, `text-sm` | `text-micro`, `text-label`, `text-data`, `text-body` |
| `rounded`, `rounded-md`, `rounded-lg`, `rounded-xl` | `rounded-sm` (4), `rounded-md` (6), `rounded-lg` (8, modals only) |
| `z-[110]` … `z-[200]` | `z-(--zf-z-drawer)` … `z-(--zf-z-tooltip)` |

### 9.5 Concrete changes the in-progress UI needs

Paths are relative to `apps/web/`. "P0" means before the Pulse and token pages land; "P1" means before launch.

**Foundations**
1. P0 `src/index.css`: replace the palette with 9.1 and the `@theme inline` block with 9.2.
   - Rewrite `.zf-input` to 4.23: control height, 4 px radius, `surface-2`, `hairline-strong`, focus ring.
   - Delete `.zf-live-dot` and its `infinite` keyframes (ban 15).
   - Rewrite `zf-flash-*` / `zf-enter` as overlay-opacity transitions using `--zf-dur-flash` / `--zf-dur-highlight` (6.6).
2. P0 `package.json` + `src/main.tsx`: Plex fonts (9.3). `index.html`: `theme-color` becomes `#090a0c`; the app sets `data-theme`, `data-density` and `data-cvd` on `<html>` from settings.
3. P0 `src/lib/format.ts`:
   - `fmtSmall` must stop emitting U+2080–2089. Return parts `{ sign, int, zc, digits, unit }` and render through a new `src/components/ui/Num.tsx` (3.3).
   - `fmtCompact` keeps 3 significant digits including trailing zeros for live metrics (no `trimZeros`), and rounds before choosing the suffix ($999,950 shows "$1.00M").
   - Use U+2212 for negatives. Percent rules per 3.5.
   - `shortAddr` gets the `…pump` rule (3.8). Add `fmtSolTape` (3 fixed decimals plus the dim-zeros split) and a fee formatter (up to 9 decimals).
4. P0 `src/lib/metrics.ts`:
   - `RISK_THRESHOLDS`: top10 [20, 35], dev [5, 10], snipers [5, 15], insiders [3, 10], bundlers [5, 15]. Band on the rounded displayed value. Add an "unknown" tone.
   - `TONE_CHIP.good` loses its fill (`text-risk-low` only).
   - `TAG_STYLE` per 4.5: no `accent` or `violet`; YOU is neutral with a `fg-1` border.
   - Drop the `color` field from `LAUNCHPADS`; badges are monochrome.
5. P0 `src/components/ui/TokenAvatar.tsx`: delete `FALLBACK_GLYPHS` (emoji) and the HSL `linearGradient`. Render the image or a monogram (4.22). Ring fill `fg-2`. Badge: 16 px `surface-3` with a 10 px letter.
6. P0 `src/features/pulse/RiskChips.tsx`: replace the Crown / ChefHat / Crosshair / Ghost / Boxes icons with letter chips T D S I B (4.5): 16 px tall, min-width 40 px, 10 px letter, 11 px value; low unfilled, mid `warn-tint`, high `sell-tint` plus edge; "DS" neutral; "–" for unknown.
7. P0 `src/components/ui/Button.tsx`:
   - Sizes xs 20 / sm 24 / md 28 / lg 32 / xl 36 px, all `rounded-sm`.
   - Variants per 4.6. Remove `hover:brightness-110`; `buy` and `sell` use `text-ink`. Add `buy-tint`, `sell-tint` and `danger`. Map the current `outline`/`subtle` to `secondary`/`ghost`.
   - `IconButton`: 20 / 24 / 28 px with 12 / 14 / 14 px icons; `active` becomes `bg-surface-3 text-fg-1` (not `accent/15`).
8. P0 `src/components/ui/controls.tsx`:
   - `Segmented`: transparent container with a `hairline-strong` border, 18 / 14 px segments, active `surface-3`; tones only neutral, buy and sell (remove `accent`).
   - `NumberInput`: 4.23.
   - `Switch`: on = `bg-accent` with an `ink` knob.
   - `Kbd`: 10 px Plex Mono 500 (from 9 px). Modifier keys render as lucide icons on macOS and words elsewhere.
9. P0 `src/components/ui/Modal.tsx`:
   - `rounded-xl` becomes `rounded-lg`; delete `backdrop-blur-[2px]`; scrim `bg-(--zf-scrim)`.
   - Width presets 400 / 560 / 720 / 880 px; z-index tokens; enter and exit motion per 4.17.
   - `Drawer` keeps 0 radius and uses `shadow-e2`.
10. P0 `src/components/ui/Popover.tsx` and `Tooltip.tsx`:
    - Popover: `rounded-md`, `shadow-e1`, `bg-floating`, z per 2.7 (+10 inside overlays).
    - Tooltip: 400 ms delay with the 500 ms skip-delay, `bg-tooltip`, metric layout per 4.14.
11. P0 `src/components/ui/bits.tsx`:
    - `Tag` goes from 9 px to 10 px.
    - `SolMark` (the "◎" text) becomes an SVG `SolGlyph`. `XGlyph` ("𝕏") becomes the letter "X" in Plex 600.
    - `SocialLinks` and `ExplorerLink` stop pushing "copied" toasts (inline check instead).
    - `Section` becomes a tiled panel (0 radius, hairline separators, 32 / 36 px header).
    - `EmptyState` per 4.18 (no 40 px vertical padding block).
    - `ProgressBar` uses `rounded-xs`.

**Shell**
12. P0 `src/app/Logo.tsx`: a monochrome mark (`accent` square, `ink` slashed zero). No orange.
13. P0 `src/app/TopNav.tsx`:
    - Height `h-(--zf-topbar)`.
    - `LANDING_INFO` tones: Reduced and Secure use `fg-2`; only Fast uses `warn`.
    - "Fund" becomes `secondary`.
    - Responsive hiding per 4.1.
14. P0 `src/app/StatusBar.tsx`:
    - 24 px; static connection dot.
    - Add the USD/SOL and density toggles.
    - Latency bars use `fg-3`/`fg-2` instead of accent.
    - A stale SOL/USD price turns `warn`.
15. P0 `src/app/Toasts.tsx`:
    - 340 px wide, structure per 4.13 (verb phrase, stage line with milliseconds, signature row, latency expander, stage bar).
    - `aria-live` moves off the container onto transaction toasts only (`status` / `alert`).
    - Delete the copy, preset and paste toasts from `src/app/Shell.tsx` and `bits.tsx`.
16. P0 `src/app/MobileNav.tsx`: the active tab is `fg-1` with a 2 px top bar, not `text-accent`.
17. P1 `src/app/HotkeysHelp.tsx`: a searchable 3-column sheet with context dimming and a modifier legend (4.15 and 5.5).
18. P0 `src/lib/hotkeys.ts`: add Space+B, the Pulse navigation keys (1/2/3, H/L, J/K, Enter, C, X, Shift+X, F, P, Shift+P), T then C, T then D, G then S, B/S/M/L/A, [ and ], Shift+M, Alt+A, Shift+1…6, U, ⌘⇧L, ⌘⇧Backspace (6.4). Enforce the repeat guard and the no-auto-repeat rule.
19. P0 `src/lib/chartTheme.ts`:
    - Read the new variables: `--zf-surface-1` background, `--zf-chart-grid` grid, `--zf-text-3` text, `--zf-hairline` borders, crosshair label background `--zf-surface-3`.
    - Font 11 px Plex Sans. Keep `attributionLogo: true`.

**Features**
20. P0 `src/features/search/SearchModal.tsx`:
    - Implement 4.15: z-index, scopes, group labels, row sizes, footer key hints, ⌘Enter quick-buy, preview pane at 1280 px and up.
    - The quick-buy pill becomes neutral at rest.
    - Remove the default "👀" emoji when tracking a wallet.
21. P0 `src/state/settings.ts`:
    - `DisplaySettings` gains `density`, `cvd: "default" | "blue-orange"`, `quote: "USD" | "SOL"`, `insertMode: "live" | "calm"`, `riskThresholds`, `confirmOnTouch`.
    - `theme` gains `"system"`.
22. P0 Pulse, token, portfolio, trackers, orders, onboarding and settings pages are built to sections 4 and 5 (the current files are placeholders).

---

## 10. Slop check

Run this on every screen and PR that changes UI. Any "no" blocks the merge unless the PR updates this document.

1. Does every coloured pixel map to `buy`, `sell`, `warn`, `info`, `risk-*`, `focus`, status or a monogram fill, each with a meaning?
2. Is the screen free of gradients, glassmorphism (blur, translucency), glows and coloured shadows?
3. Are all radii 0, 2, 4, 6 or 8 px, with pills only on the elements listed in 2.4?
4. Do shadows appear only on floating layers, and only as `e1` or `e2`?
5. Is the screen free of emoji (except user-chosen wallet emoji inside avatars) and decorative illustrations?
6. Are all icons lucide, 12, 14 or 16 px, with a 1.5 px stroke and `currentColor`?
7. Is all text IBM Plex Sans or IBM Plex Mono, at least 10 px, upright, in sentence case (except micro tags and group labels)?
8. Does every character render in our fonts, with no fallback glyphs (subscripts via `.zf-zc`, `SolGlyph`, keycap icons, written-out ≥ ≤)?
9. Are numbers tabular, right-aligned in columns, with units in `text-3` and trailing zeros dimmed in tape columns?
10. Do all values follow section 3 (significant digits, subscript zeros at 4+ leading zeros, U+2212 minus, explicit signs, "–" for unknown, no "+Infinity%")?
11. Do live updates leave layout untouched (fixed widths and heights, no wrap), with zero Layout Shift entries in a 60 s recording outside user actions?
12. Does hovering or focusing a live list freeze its order, with queued items behind an "↑ N new" bar?
13. Is the only looping animation a spinner on an in-flight action?
14. Do hover and press change colour only (no scale, translate or brightness filter)?
15. Does every focusable element show the 2 px focus ring, in a logical tab order?
16. Is every action reachable by keyboard, listed in the shortcut sheet, with its keycaps in the tooltip?
17. Are densities respected: panel padding at most 12 px, rows 24/28 (tapes 20/24), cards 68/80, no gutters between tiled panels?
18. Is the in-app content top-left aligned, with no centred hero, marketing copy or exclamation marks?
19. Does every metric label carry a dotted-underline tooltip with its definition and active bands?
20. Does every trade entry show the cost breakdown, including "Platform fee 0"?
21. Do transaction toasts show the verb phrase, stages with milliseconds and the latency breakdown, with failures persisting and offering Retry?
22. Is friction proportional to risk: none for routine trades within caps, a countdown for flagged tokens, hold-to-confirm for Panic, export and new withdrawal destinations?
23. Do contrast checks pass (`text-3` and semantic text at 4.5:1 or more on their surface, focus ring at 3:1 or more, `ink` on solid fills)?
24. Does the screen keep its meaning in the light theme and in the blue/orange palette (side written as B/S or Buy/Sell, signs on changes)?
25. With reduced motion on, are flashes, highlights, slides and spinners replaced by static indicators?
26. On mobile: are targets at least 44 px, is the trade bar sticky, and is there no horizontal page scroll at 375 px?
27. Do loading states keep exact row heights under real headers, with no shimmer and no spinner placeholders for data?
28. Is the screen free of hard-coded demo values or placeholder copy ("$1,000,000", "+100%", "Lorem")?
29. Do buttons say what they do ("Buy WIF · 0.50 SOL", "Cancel orders"), never "Submit", "OK" or "Are you sure?"?
30. Is the brand clean: no other product's logo, wordmark or signature colour, and the zerofee mark monochrome?
