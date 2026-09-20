# Design QA — AA Sports Ops final technical pass

## Scope and evidence

- Selected source: `docs/redesign/b2-visual/source-concept-1.png`
- Browser implementation capture: `docs/redesign/b2-visual/implementation-list-1536x1080.png`
- Side-by-side browser artifact: `docs/redesign/b2-visual/compare.html`
- Source and implementation image dimensions: 1536 × 1080 px
- Browser viewport under test: 1536 × 1080 CSS px, device scale factor 1
- State: MLB schedule, dark theme, deterministic game fixtures; ES reference and equivalent EN browser state inspected
- Browser evidence: the comparison page and the implementation were rendered in the Codex in-app Browser; focused regions were also inspected at original resolution

## Full-view comparison

The implementation preserves the selected concept's hierarchy: narrow rail, compact global header, page title/date, four day KPIs, horizontal sports switcher, compact filters and a single dense schedule surface. Rows align time, matchup, probable participants, factual status/data, AA prediction and the favorite action. The implementation intentionally keeps existing product controls that remain part of the route contract while matching the reference's density and scan path.

## Inspect verification

- Factual matchup is separated from the model reading.
- Exactly three primary tabs are present: Summary/Resumen, Participants/Participantes and Evidence/Evidencia.
- Exactly one element uses `[data-canonical-probability]`.
- Scope, source, updated time, status and limitation are adjacent to the canonical reading.
- Markets live inside Summary/Resumen instead of becoming a fourth primary tab.
- The market selector is functional: Winner exposes the auditable price/EV comparison without repeating the canonical AA percentage; closed markets expose their measured gate explanation and sample state.
- Left/Right/Home/End keyboard navigation, focus state and ARIA tab semantics were exercised.
- Browser inspection found no horizontal document overflow and no application console errors or warnings.

## Responsive and interaction coverage

- Desktop: 1536 × 1080 and automated 1440 × 900.
- Compact: 390 × 844 and 360 × 800.
- Reflow: 320 CSS px and effective 200% zoom width.
- Game rows use canonical links; Favorite is a separate sibling button.
- At least three complete schedule rows remain visible at 1440 × 900.
- Reduced motion resolves the redesigned route transitions to 0ms.

## Participant and team objects

- Official images are admitted only through per-sport HTTPS host allowlists and degrade to a monogram without a request loop.
- A caption is exposed only after the official image actually loads; it disappears on error.
- `p=` and `team=` open contextual object pages with canonical URLs, document titles, focusable headings and a Back action that restores the originating match tab.
- Player and team object pages were inspected in the in-app Browser and exercised in Chromium, Firefox and WebKit at desktop and compact widths.

## Density, contrast and bilingual copy

- Critical schedule, evidence and object metadata is at least 12 CSS px; compact uppercase labels remain secondary to independently named values.
- Primary controls expose at least a 44 × 44 CSS px target, including 320, 360, 390 and 720 CSS px viewports.
- Token contrast is measured in-browser: text/dim/faint/on-sky meet 4.5:1 and sky component boundaries meet 3:1.
- Jornada and Inspect use opaque operational surfaces with no `backdrop-filter` blur.
- Visible navigation and headings use the bundled Material Symbols font; emoji and hand-drawn interface SVGs were removed from those roles.
- ES/EN switching persists across reload and neither language introduces horizontal overflow.

## Motion and continuity

- Core page continuity is opacity plus `translateY(8px)` at 200ms; no route uses `translateX` or `rotateY`.
- Toast centering is the only remaining `translateX`, and is not page motion.
- Route changes write History immediately; motion does not delay navigation.
- Back restores focus to the originating schedule row.
- Both `prefers-reduced-motion: reduce` and the in-app setting set effective animation and transition duration to `0ms`; the app preference persists across reload.
- `motion_views_ui_test.mjs` passes in Chromium, Firefox and WebKit, including the 360px Inspect surface.
- The complete 9-suite product matrix passes in Chromium, Firefox and WebKit; the unit suite passes 271/271.

## Findings resolved

| Priority | Finding | Resolution |
|---|---|---|
| P1 | Icon font failure exposed raw icon names | Material Symbols Rounded was vendored locally. |
| P2 | Early capture sampled row-entry opacity | Deterministic capture waits for settled motion. |
| P2 | Primary rail was visually crowded | Five primary destinations remain; the rest use the Más disclosure. |
| P2 | Title/KPI/navigation order did not match the selected concept | Title and KPIs now precede sports navigation; the ticker is hidden on Jornada. |
| P2 | Matchups and pitchers stacked vertically; prediction lacked team identity | Desktop rows now compare opponents and starters horizontally and include the predicted team's mark. |
| P1 | Sports navigation compressed and overlapped at compact widths | Items are non-shrinking and the rail scrolls horizontally without overlap. |
| P1 | App reduced-motion setting persisted but did not disable CSS motion | The state now reaches `body.aa-reduce-motion`, cancels running animations and resolves durations to 0ms. |
| P2 | Detail animation selectors targeted a class absent from the real container | The canonical detail container now owns `.dcard`, so the verified vertical transition actually runs. |
| P2 | WebKit image-caption assertion raced a successful load | The test now waits for the real visible caption state before asserting. |
| P1 | Moving markets into Summary left their buttons without the audited value/gate panel | Winner now renders its source-backed price/EV table; Total, Players and Combos render fail-closed gate evidence. |
| P1 | The legacy value table repeated the canonical AA percentage | The table now references the canonical source and shows market/price/EV only; the exact AA probability appears once. |

## Remaining human gate

The automated and browser design QA is complete. The separate plan requirement for a comprehension exercise with three independent people remains a human research activity and is not represented as simulated evidence here.

## Final result

passed
