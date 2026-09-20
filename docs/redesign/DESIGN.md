---
version: beta
name: AA Sports Ops
description: Dense operational schedule plus an honest Inspect surface. Dark studio, one accent, no candy.
colors:
  primary: "#4da8ff"
  secondary: "#a0b0c6"
  tertiary: "#32dfb4"
  neutral: "#060c15"
  ink: "#f2f5fc"
  muted: "#7d91aa"
  hair: "#1a2d42"
  amber: "#f8c657"
  danger: "#ff6277"
  away: "#e8895a"
  market: "#6b8caf"
typography:
  h1:
    fontFamily: Barlow Condensed
    fontSize: 1.25rem
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "0.04em"
  body-md:
    fontFamily: Manrope
    fontSize: 0.90625rem
    fontWeight: 500
    lineHeight: 1.5
rounded:
  sm: 6px
  md: 12px
  lg: 16px
spacing:
  sm: 8px
  md: 16px
  lg: 24px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: 12px
  button-primary-hover:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.ink}"
  panel:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: 16px
  caption:
    backgroundColor: "{colors.neutral}"
    textColor: "{colors.muted}"
---

## Overview

AA Sports uses two related, deliberately different surfaces:

- **Jornada / Monitor (`body.aa-list`):** a dense operational schedule. Time, matchup, probable participants, factual status/data and the AA read align in one scanning row.
- **Objeto / Inspect (`body.aa-page`):** one match at a time. Factual hero first, one canonical AA reading, then participants and evidence.

Darkness is the native medium (`#060c15`). Information density comes from type, hairlines, aligned columns and one accent — not from glows, glass candy, or a rainbow of status hues.

Brand line: **Los datos deciden.** Closed gates look closed. No invented numbers.

## Colors

- **Primary (`#4da8ff`, `--sky`):** the only interactive accent. Active tabs, links, focus.
- **Tertiary (`#32dfb4`, `--volt`):** measured success / home / calibrated probability. Never decorative.
- **Amber (`#f8c657`):** ORO / caution. Semantic, sparse.
- **Danger (`#ff6277`):** live / loss. Semantic, sparse.
- **Away (`#e8895a`):** visitor bar only. Desaturated so it does not compete with amber.
- **Market (`#6b8caf`, `--royal`):** factual market_fact scope, quieter than AA sky.
- **Neutral (`#060c15`):** page. Surfaces step up via `--card-hi/lo` and `--panel`, not colored cards.
- **Hair (`#1a2d42`):** structure. Prefer luminance steps over thick borders.

Do not introduce indigo, purple, or extra neons. Do not restore `saturate(140%)` glass.

## Typography

Manrope for UI. Barlow Condensed for wordmark, scores, percentages, section labels. Display type is condensed on purpose (sports ticker), not Inter-by-default.

Critical operational copy never renders below 12 CSS px. Compact uppercase labels may reach 10px only when the adjacent value is independently named and remains at least 12px. Interactive controls expose a 44×44 CSS px target at every supported viewport, including 320px reflow and the 720 CSS px proxy for 200% zoom.

Contrast is a token contract, not a per-component exception: `--text`, `--dim`, `--faint`, and `--on-sky` meet 4.5:1 against their intended backgrounds; `--sky` meets 3:1 against `--page` for focus rings and component boundaries.

## Layout

The desktop shell is a 216px rail plus a compact top bar. The visible primary rail is intentionally limited to Inicio, Partidos, Central AA, Favoritos and Más; secondary destinations live under Más.

On Jornada, the reading order is page title/date → four day KPIs → sports navigation → view/date/status controls → full-width schedule. A game appears once. A row link opens its canonical object URL while Favorite remains a sibling action.

On Inspect, the reading order is contextual back/breadcrumbs → factual matchup → three primary tabs (`Resumen`, `Participantes`, `Evidencia`) → exactly one canonical AA reading → source metadata and limitation → markets inside Resumen. Mobile 390/360 and reflow at 320 CSS px are first-class.

## Elevation & Depth

Operational surfaces are opaque. Hairlines and luminance changes provide depth. Legacy glass may remain outside the redesigned routes during migration, but Jornada and Inspect do not use blur, hero glow or an aurora behind the app chrome.

## Shapes

Radii live on `--r-*` (2–20px + pill). Circles stay `50%`. Do not inflate radii to fake hierarchy.

## Components

- **Schedule row:** time / game / probable participants / factual status-data / AA prediction / info. Desktop is horizontal; compact screens stack content without changing semantic order.
- **Market selector:** one subordinate surface inside Summary. Winner may expose audited market/price/EV data without repeating the exact AA percentage; closed markets expose their gate reason and measured sample progress.
- **Probability bars:** shared baseline, 50% reference, away orange / home volt.
- **Central AA:** `data-sport="radar"` in the nav. AA picks vs market_fact groups, never mixed as one claim.
- **Canonical AA reading:** the only exact model probability in an Inspect page. Scope, source, updated time, status and limitation remain adjacent.
- **Brand mark:** `cloudflare/pages/assets/aa-mark-blue.png`, with the 192/512/PWA variants derived from the same approved blue direction.
- **Interface icons:** local Material Symbols Rounded font at `cloudflare/pages/assets/material-symbols-rounded.woff2`; do not use emoji or raw glyph names as visible navigation icons.
- **Language:** ES and EN use the same geometry and persist through reload. Copy expansion must not create horizontal overflow at 320, 360, 390, 720, or desktop widths.

## Motion

Page continuity uses opacity plus `translateY(4–8px)` for roughly 160–220ms. Do not use lateral drawer motion or `rotateY`. Both `prefers-reduced-motion: reduce` and the app reduced-motion state resolve effective duration to `0ms`.

The production route contract is `fadeUp` at 200ms with an 8px vertical offset. History state changes immediately; animation never gates navigation. The in-app preference is represented by `body.aa-reduce-motion`, persists in local storage and cancels any animation already running when enabled.

## Do's and Don'ts

- Do keep ES and EN in dictionary `T` for every new string.
- Do show closed gates as closed, with measured sample n.
- Don't put model logic in the frontend.
- Don't add a third neon accent.
- Don't clone Linear/Vercel chrome; keep Studio names (`--sky`, `--volt`, `--page`).
- Don't repeat an exact AA probability in the factual hero, metadata or market controls.
- Don't place the game list behind nested cards or duplicate a game in featured and ordinary sections.
