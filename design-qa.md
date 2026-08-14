**Comparison Target**

- Source visual truth: `/Users/adrianclara/.codex/generated_images/019f84e0-2d27-7511-9722-cb9ea33ecb4b/exec-fd47b091-5cc0-438f-9810-7ce90029dce0.png`
- Browser-rendered implementation: `/tmp/aa-market-component.png`
- Side-by-side normalized comparison: `/tmp/aa-market-component-compare.png`
- Viewport: Chrome via Playwright, `390 × 844` CSS px, device scale factor `1`, dark theme, Spanish, `Ganador` active.
- Source pixels: `853 × 1844`; focused market crop: `853 × 1400`. Implementation component pixels: `327 × 655`. Both focused regions were normalized to `600px` width and padded without stretching in the side-by-side comparison.
- State note: the source is a final SEA–NYY art-direction mock and the implementation uses a pregame MIN–CLE regression fixture. Dynamic teams/status differ intentionally; the compared state is the same four-market selector with public Winner and three closed gates.

**Full-view Comparison Evidence**

- The implementation preserves the selected direction: markets lead the analysis, the four tabs share one surface, the active state uses the AA blue token, winner percentages and real team logos remain visible, two vertical bars share a baseline, and the 50% reference crosses the measured plot area.
- AA Sports keeps its existing game header and analysis navigation around the component. This is intentional integration with the production design system, not a replacement of the app shell.

**Focused Region Comparison Evidence**

- The focused side-by-side comparison clearly resolves typography, market-tab hierarchy, percentage colors, logo quality, bar proportions, 50% reference, verdict callout, confidence tags, borders, radii, and honesty footer; no additional crop was needed.

**Findings**

- No actionable P0, P1, or P2 differences remain.
- [P3] The production component is denser than the art-direction mock.
  Location: `.market-panel`, `.prob-viz`.
  Evidence: the reference dedicates more vertical space to the bars; production retains the existing AA Sports mobile detail density.
  Impact: none on hierarchy or legibility; it keeps the remaining MLB detail reachable with less scrolling.
  Fix: optional only—raise the mobile plot above `320px` if future usability testing prefers a more editorial presentation.
- [P3] The reference callout contains edge and risk fields that are absent in the fixture.
  Location: `.market-callout`.
  Evidence: the source shows `+1.2%` and risk; the fixture has no auditable odds/edge or risk value.
  Impact: none. Omitting unavailable evidence is required by AA Sports honesty rules.
  Fix: none; these fields render only when measured data exists.

**Required Fidelity Surfaces**

- Fonts and typography: existing Inter stack, weight hierarchy, line height, wrapping, and small gate labels are consistent and readable at 390/360/desktop.
- Spacing and layout rhythm: tabs, plot, callout, and honesty footer have stable grouping; no collision, clipping, or horizontal overflow at the required breakpoints.
- Colors and tokens: AA blue active state, orange away side, green home side, dark surfaces, hairlines, and disabled text map cleanly to the source direction with adequate contrast.
- Image quality and assets: production uses real ESPN team-logo assets with existing text fallback only on network failure; no new fake illustration, inline SVG logo, or CSS-drawn team asset was introduced.
- Copy and content: ES/EN market labels, closed-gate explanations, measured sample progress, AA/ESPN attribution, and the honesty footer are coherent and complete.
- Accessibility and behavior: semantic tab buttons, selected state, focus-visible outline, `role="img"` probability label, practical tap targets, and active interaction for all four markets were verified.

**Comparison History**

- Iteration 1 evidence: `/tmp/aa-market-qa.png` and `/tmp/aa-market-qa-v2.png`.
  Earlier findings: the MLB confidence/tier metadata had disappeared after replacing the legacy bar, and the 50% reference was calculated against the whole component rather than the bar plot (P2).
  Fixes: restored confidence/tier metadata below the Winner callout; recalculated the neutral line against the actual plot region; increased mobile/desktop plot height; aligned the away percentage with the orange bar token.
- Iteration 2 evidence: `/tmp/aa-market-component.png` and `/tmp/aa-market-component-compare.png`.
  Post-fix result: confidence/tier metadata is present, the 57% bar crosses the 50% reference while the 43% bar remains below it, real logos render, and no P0/P1/P2 issue remains.

**Implementation Checklist**

- [x] Market-first selector and active states.
- [x] Vertical comparison with shared baseline and 50% reference.
- [x] Public and closed gate states with measured sample progress.
- [x] Real team assets and bilingual copy.
- [x] Desktop, 390, and 360 Playwright regression with zero app console errors and zero overflow.
- [x] Winner/Total/Players/Combos interactions verified for MLB, WNBA, and NFL.

**Follow-up Polish**

- Revisit plot height only if production behavior data shows users prefer the larger editorial ratio from the mock.

final result: passed
