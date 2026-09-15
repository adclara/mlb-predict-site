# AA Sports · Matchday Studio — skill

Read this entire file before touching AA Sports. Production DNA in
`adclara/mlb-predict-site/AGENTS.md` **wins** over this skill when they conflict.

## Two surfaces (never mix them)

| Surface | What it is | What you may do |
|---|---|---|
| **Production** `https://aasport.net/` | One HTML file `cloudflare/pages/index.html`, no build, no framework. Worker `aa-sports-api`. $0 Cloudflare. | Restyle **in place**. Branch → PR → squash-merge → poke `.github/poke-deploy`. Never replace with React. |
| **Studio** (Grok app + prototype) | TanStack Start, live API, 18 views. | Iterate UI here. Art pack is shared. Do not copy prototype HTML onto aasport.net. |

Prototype README: *NO es una actualización de aasport.net.* DESIGN_HANDOFF step 1: keep as independent design; extract tokens/components; then connect real data.

## Non-negotiable product rules

1. **Honesty.** Every number is measured. Honesty box + legal notice always visible. Closed gates stay closed. Missing data is `—`, never `0%`.
2. **Private model.** Browser consumes published JSON only. No model code in the client.
3. **Bilingual ES/EN** on production (`T` + `t(key)`). Studio may ship ES-first but every new string needs an EN twin before production merge.
4. **$0 infra.** Cloudflare free tier + GitHub Actions. No paid APIs without explicit approval.
5. **No fake predictions on aasport.net.** Illustrated art is labeled. Prototype numbers never appear as AA probabilities.
6. **Work on a branch. Never commit `main`.** Squash-merge. Then poke-deploy.

## Visual system (approved)

Night-blue editorial dashboard. Tokens:

```
--bg #060c15  --side #080f1a  --panel #0b1624  --panel2 #101f30
--line #21354c  --fg #f2f5fc  --muted #a0b0c6  --dim #7d91aa
--blue #4da8ff  --green #32dfb4  --gold #f8c657  --red #ff6277
```

Fonts: Barlow Condensed (display) + Manrope (body). Rail 184px → 78px compact → bottom nav <700px. Hero portraits left/right with gradient masks. Team colors on uniforms, not as UI chrome floods.

## Art contract

- **Team marks:** official ESPN dark logos (`a.espncdn.com/i/teamlogos/mlb/500-dark/{espn}.png`), cached in `public/teams/{espn}.png`. Never generate trademarked logos.
- **Player faces in UI:** if a MLB person id exists, use official silo headshot (`img.mlbstatic.com` + local `public/players/{id}.jpg`). Caption: “Foto oficial MLB del abridor probable.”
- **Hero portraits (~80% likeness):** **never** text-to-image a named athlete. Download the official photo, then image-to-image. Keep ~80% facial likeness, painterly night-stadium, **blank cap / no logos / no letters**. Save `public/art/players/{id}-hero.jpg` and add the id to `ILLUSTRATED_IDS`.
- **Illustrated family fallbacks:** 6 color families × (hero + pitcher). Caption as illustrative when no official id exists.
- **Stadium / glove / OG:** cinematic night park, no text in the image.

Family map: `navy` NYY LAD SEA MIN DET CHC KC TOR TEX COL CWS; `red` CIN STL BOS LAA PHI ATL CLE WSH ARI; `gold` MIL PIT SD; `green` OAK ATH; `orange` BAL SF HOU NYM; `teal` MIA TB.

## 18 views (parity checklist)

Match: Resumen, Equipos, Pitchers, Bateadores, Total, Jugadores, Combos, Simulación, Mercado.
App: Inicio, Partidos, Mis picks, Posiciones, Historial, Cerebro AA, Educación, Herramientas, Configuración.

Gates stay closed for totals / players / combos until production says otherwise. Simulation uses the **published** probability, not a demo p.

## Safe migration order

0. Skill + master prompt + art pack (this).
1. Studio (Grok) uses live API + family art + official logos/headshots + 80% I2I heroes.
2. Extract CSS tokens and hero/rail into production HTML **without** changing pick math.
3. Restyle production views one at a time. Keep `authbox`, date guard, bilingual, honesty.
4. Playwright desktop + 390 + 360, 0 console errors, no overflow.
5. PR → merge → poke-deploy → verify aasport.net markers.

## Deploy

Poke `.github/poke-deploy` on a branch, PR, squash-merge to `main`. Workflow `deploy.yml` publishes Worker + Pages. Do not wrangle Cloudflare from a laptop.

## Done means

`npm run build` + `npm run typecheck` green; smoke desktop+mobile; production still honest; aasport.net not replaced by prototype HTML.
