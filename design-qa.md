# Design QA — B2 AA Sports Ops

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
- Left/Right/Home/End keyboard navigation, focus state and ARIA tab semantics were exercised.
- Browser inspection found no horizontal document overflow and no application console errors or warnings.

## Responsive and interaction coverage

- Desktop: 1536 × 1080 and automated 1440 × 900.
- Compact: 390 × 844 and 360 × 800.
- Reflow: 320 CSS px and effective 200% zoom width.
- Game rows use canonical links; Favorite is a separate sibling button.
- At least three complete schedule rows remain visible at 1440 × 900.
- Reduced motion resolves the redesigned route transitions to 0ms.

## Findings resolved

| Priority | Finding | Resolution |
|---|---|---|
| P1 | Icon font failure exposed raw icon names | Material Symbols Rounded was vendored locally. |
| P2 | Early capture sampled row-entry opacity | Deterministic capture waits for settled motion. |
| P2 | Primary rail was visually crowded | Five primary destinations remain; the rest use the Más disclosure. |
| P2 | Title/KPI/navigation order did not match the selected concept | Title and KPIs now precede sports navigation; the ticker is hidden on Jornada. |
| P2 | Matchups and pitchers stacked vertically; prediction lacked team identity | Desktop rows now compare opponents and starters horizontally and include the predicted team's mark. |

## Remaining human gate

The automated and browser design QA is complete. The separate plan requirement for a comprehension exercise with three independent people remains a human research activity and is not represented as simulated evidence here.

## Final result

passed
