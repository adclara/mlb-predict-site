---
version: alpha
name: AA Sports Matchday
description: Monitor surface for honest sports predictions. Dark studio, one accent, no candy.
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

AA Sports is a **Monitor** surface: the match and its markets lead. Darkness is the native medium (`#060c15`). Information density comes from type, hairlines, and one accent — not from glows, glass candy, or a rainbow of status hues.

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

## Layout

Matchday-first: list of today's games, then a single market surface (Winner / Total / Players / Combos). Mobile 390/360 is first-class. Honesty box and legal notice stay visible on home.

## Elevation & Depth

Glass is `blur(16px) saturate(108%)`. Hero glows stay under ~13% alpha. No aurora behind the app chrome.

## Shapes

Radii live on `--r-*` (2–20px + pill). Circles stay `50%`. Do not inflate radii to fake hierarchy.

## Components

- **Market tabs:** one surface, AA blue for the public market, muted + sample progress for closed gates.
- **Probability bars:** shared baseline, 50% reference, away orange / home volt.
- **Central AA:** `data-sport="radar"` in the nav. AA picks vs market_fact groups, never mixed as one claim.

## Do's and Don'ts

- Do keep ES and EN in dictionary `T` for every new string.
- Do show closed gates as closed, with measured sample n.
- Don't put model logic in the frontend.
- Don't add a third neon accent.
- Don't clone Linear/Vercel chrome; keep Studio names (`--sky`, `--volt`, `--page`).
