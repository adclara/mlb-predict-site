# Plan maestro de migración — Matchday Studio → AA Sports

## Objetivo

Misma experiencia visual que el prototipo Matchday Studio, con el feed real, logos oficiales, caras cuando existan, y aasport.net intacto en honestidad y arquitectura.

## Superficies

```
Prototipo HTML (diseño, datos ficticios)
        ↓ extrae tokens + layout
Studio Grok (React, API real)  ← iterar aquí
        ↓ extrae CSS/hero/rail
Producción aasport.net (index.html único, Worker, D1/KV)
        ↓ PR + poke-deploy
https://aasport.net/
```

## Fases

### Fase 0 — Contrato (esta entrega)
- Skill `.grok/skills/aa-sports-studio/SKILL.md`
- Master prompt `docs/MASTER_PROMPT.md`
- Este plan
- Pack de arte por familia + logos ESPN en `public/teams/`

### Fase 1 — Studio con arte dinámico (Grok, preview)
- Hero y pitchers según equipo, no CIN/MIL fijos
- Headshot MLB si hay person id
- Retratos ilustrados ~80% por I2I desde foto oficial (nunca T2I de un atleta nombrado)
- 18 vistas conectadas al Worker
- Gates cerrados visibles
- Smoke desktop + móvil

### Fase 2 — Tokens en producción
Rama `agent/studio-tokens` en `mlb-predict-site`.
Copiar paleta, tipografía, rail, topbar, hero al HTML **sin** cambiar `dPick` / publicación.
Mantener `id="authbox"`, date guard, `T`/`t()`, ticker, Central AA.

**Hecho 2026-09-15:** `AA_STUDIO_TOKENS_V1` en `cloudflare/pages/index.html`.
Night-blue (`#060c15`), Manrope + Barlow Condensed, rail 184→78→oculto <900px,
hero con silo MLB si hay person id, logos ESPN 500-dark. Sin cambios de pick/gates.

### Fase 3 — Vistas de partido en producción
Resumen → Equipos → Pitchers → resto. Cada PR es squash-mergeable y reversible.
No abrir Totales/Jugadores/Combos.

**Hecho 2026-09-15:** `AA_STUDIO_VIEWS_V1` en el HTML único. Pestañas de partido
Resumen / Equipos / Pitchers / Bateadores / Total / Jugadores / Combos /
Simulación / Mercado. Abridores con silo MLB oficial (no midfield). Total,
Jugadores y Combos muestran `gatePanel` cerrado. Sin cambios de pick/gates.

### Fase 4 — Resto de app
Inicio, Partidos, Historial, Cerebro, Educación, Herramientas, Config. ES+EN.

**Hecho 2026-09-15:** `AA_STUDIO_APP_V1` en el HTML único. Rail Educación / Herramientas / Config
sin chips `.ltab` extra. Jornada destacada con silo MLB oficial. Historial y Cerebro con
encabezado Studio. Total / Jugadores / Combos siguen cerrados (fila de gates en Cerebro,
solo copy). Calculadora local EV = p × decimal − 1. Config local (idioma + movimiento).
Sin cambios de pick/gates.

### Fase 5 — QA y publicación
Playwright 1440/390/360. `qa_check.mjs`. Poke-deploy. Verificar aasport.net y pages.dev.

## Arte

| Recurso | Fuente | Uso |
|---|---|---|
| Logos MLB | ESPN 500-dark, cache local `public/teams/{espn}.png` | `TeamMark` |
| Headshot oficial | mlbstatic person id + `public/players/{id}.jpg` | Cards, jornada, corte del abridor |
| Hero 80% | I2I desde foto oficial → `public/art/players/{id}-hero.jpg` | Hero de análisis / inicio |
| Hero/pitcher familia | 6 familias, gorra en blanco | Fallback sin id |
| Stadium / glove | arte generado | Fondos |

**Regla 80%:** nunca text-to-image de un atleta nombrado. Foto oficial → `imagine_image_to_image` → QC (sin letras en gorra/jersey) → registrar id en `ILLUSTRATED_IDS`.

Familias: navy NYY LAD SEA MIN DET CHC KC TOR TEX COL CWS; red CIN STL BOS LAA PHI ATL CLE WSH ARI; gold MIL PIT SD; green OAK ATH; orange BAL SF HOU NYM; teal MIA TB.

## Estado 2026-09-15 (Studio)

- Fase 0: skill + master prompt + pack de arte. Hecho.
- Fase 1: `heroArt` / `PlayerFace` cableados. 30 logos ESPN. 29 fotos oficiales de la jornada. Retratos 80% de los abridores con id. Hecho en Studio.
- Fase 2: tokens + rail + hero silo en el HTML único (`AA_STUDIO_TOKENS_V1`). Hecho ([#256](https://github.com/adclara/mlb-predict-site/pull/256)).
- Fase 3: vistas de partido (`AA_STUDIO_VIEWS_V1`): pestañas Studio, silos oficiales, gates Total/Jugadores/Combos cerrados.
- Fase 4: resto de app (`AA_STUDIO_APP_V1`): Inicio, Partidos, Historial, Cerebro, Educación, Herramientas, Config. ES+EN.
- Fase 5: QA Playwright, poke-deploy.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Sustituir producción por prototipo | Prohibido. Diff mínimo, markers de producción. |
| Caras inventadas de gente real | Foto oficial MLB en UI; hero ilustrado 80% por I2I, etiquetado. |
| Gate abierto por error | Tests `mlb_lock_gate` + copy “no publicado”. |
| Deploy rojo por ESPN WNBA 403 | No es fallo de Pages; no revertir el frontend por eso. |
| HTML de 450 KB | Cirugía, no reescritura. |

## Criterio de hecho

- Preview Studio: retratos correctos por equipo, logos, 18 rutas, feed MLB del día.
- aasport.net: misma paleta/hero sin perder Central AA, ticker, bilingüe, honesty.
- Un PR de poke-deploy verde en Worker + Pages (el gate WNBA recientes puede avisar).
