# 🧭 Plan Maestro — MLB Predict

> Documento vivo. Contexto de todo lo construido + hoja de ruta para seguir mejorando,
> compactar los dos repos y correr más simulaciones. Escrito para trabajar desde tu Mac
> (con git y acceso al repo privado).

---

## PARTE 0 — La arquitectura (lo que tienes que tener claro)

Hay **dos repos** y es la clave para no perder trabajo:

| Repo | Qué es | Rol |
|---|---|---|
| **`adclara/mlb-predict`** (privado) | Fuente real: React + FastAPI + LightGBM, y `scripts/deploy_demo.sh` | **Origen** — de aquí sale todo |
| **`adclara/mlb-predict-site`** (público) | App compilada + `robot/*.js` + `data/` + workflow | **Destino** — GitHub Pages sirve esto |

**El robot** (`robot/*.js`) corre cada hora en GitHub Actions (repo público), descarga datos
gratis (MLB StatsAPI + ESPN + Open-Meteo, sin API keys), calcula, graba historial JSON, y se
auto-alimenta. La app lee esos JSON.

> ⚠️ **ADVERTENCIA #1 (lo más importante):** Todo lo que construí esta sesión vive en el
> repo **público**. `deploy_demo.sh` en el privado **sobrescribe** `robot/*.js` y el bundle
> en el próximo deploy. **Antes de desplegar nada desde el privado, hay que portar estos
> cambios al privado**, o se pierden. Ver Parte 3.

---

## PARTE 1 — Todo lo que construimos hoy (contexto completo)

Partimos de un sistema que ya tenía motor Elo + Monte Carlo + método Adrián. Le agregamos, en
orden, y **todo probado walk-forward con intervalos de confianza**:

### Mercado y riesgo
- **Multi-casa**: `parseSummaryOdds` + `parseCoreOdds` leen varias casas de ESPN (pickcenter +
  endpoint core), consenso de-vig (mediana) y **discrepancia entre casas** (señal de riesgo).
- **Movimiento de línea** (apertura→cierre) preservado con `mergeOddsBlocks`.
- **Motor de valor**: `edge = modelo − mercado` + EV al precio real.
- **Índice de riesgo 0–100** por juego (discrepancia, brecha vs mercado, movimiento, fatiga, lesiones).

### El cerebro (algoritmo)
- **p_final** = ensemble walk-forward (`aprendeOpinion`) + Platt + **ancla al mercado**
  (`marketBlend`). Backtest OOS: acc 55.5% vs 53.9% clásico, logloss 0.687 vs 0.724.
- **Gate de honestidad**: un pick que p_final contradice (<50%) se descarta (esos ganaban 47%).
- **Elo vivo** (`elo_live.mjs`): se actualiza a diario con los finales (idempotente).
- **FIP fresco**: blend prior + temporada por abridor.
- **Clima pronosticado** (`weather.mjs` + Open-Meteo): temperatura y **viento×orientación de
  parque** (out/in/cross) — revive el factor clima que recibía `null`.
- **Contexto** (`context.mjs`): forma casa/ruta, pitagórico L20, descanso real, densidad,
  viaje por husos — reconstruido de nuestros propios logs, walk-forward.
- **Platoon** (mano del abridor × splits L/R del rival) + contexto de serie + getaway.

### Selección — los productos
- **⭐⭐ Fijos ORO**: favorito del mercado + 5+ factores de acuerdo. Torneo walk-forward:
  **67.7% [60.1–74.5], ROI +7.9%**, estable en ambas mitades. Regla ganadora entre 9 variantes.
- **⭐ Fijos PLATA**: segundo favorito informativo, récord aparte.
- **💎 Gemas**: p_final ≥65%. Calibración exacta: dice 68.5% → acierta 68.7%.
- **Validador de scratches**: si cambia el abridor tras congelar el pick, bandera roja.
- **Libro de unidades**: 1u plana por fijo al precio real, acumulado en el índice.

### Datos en vivo y presentación
- **Logros en vivo** (`live_odds.mjs`): durante los juegos, snapshots multi-casa + win prob
  cada ~5 min, push cada ~10 min. Movement history al cierre.
- **Panel único** (`live.html`): 🏆 Top 3 del día con chips de consenso (⚡Adrián/🏦mercado/
  🧠cerebro), indicadores rápidos, y por juego las 3 opiniones + **brief** (abridores con
  etiqueta élite/golpeable, bullpen, mejores bateadores, F5/NRFI, razones de Adrián).
- **`gemas.html`**, **`fijos.html`**, chip flotante en la app.

### Ciencia
- **Backfill histórico 2023–2025** (`backfill_history.mjs`): 7,303 juegos + estudio.
- **Torneo de 6 metodologías** (Bradley-Terry, Poisson, kNN, AdaBoost, Beta-binomial, Elo)
  + super-ensemble vs producción vs mercado.
- **CLV** (closing line value) acumulándose — la prueba de oro de edge real.
- **`docs/ESTUDIOS.md`**: bitácora de todos los estudios con CIs, mitades y fuentes.

### Los 4 hallazgos que definen la estrategia
1. **El mercado es el techo** en probabilidad por juego. Ninguna de 9 metodologías lo supera;
   nuestro cerebro lo empata. → No peleamos contra las casas, las surfeamos.
2. **La ventaja está en la SELECCIÓN**, no en la predicción (fijos +7.9% ROI; mercado puro −10%).
3. **La honestidad/calibración** mejora el producto más que cualquier algoritmo nuevo.
4. **El contexto (descanso/viaje/forma) ya está en el precio**; y el descanso, que lucía +17.5
   pts en muestra chica, resultó **ruido a escala** (7,303 juegos). El backfill evitó adoptar
   una señal falsa. ← esto es lo que separa este sistema de uno que se autoengaña.

**Estado:** 18 PRs mergeados, ~103 pruebas automáticas, robot corriendo solo cada hora,
récords arrancando (los primeros fijos/gemas se gradúan esta noche).

---

## PARTE 2 — Qué le falta (huecos honestos, por impacto)

1. **Los dos repos están separados.** El panel bonito (`live.html`) vive fuera de la app React
   real. Ahora que tienes el privado → consolidar (Parte 3). **Prioridad #1.**
2. **Multi-casa aún suele traer 1 casa** (límite de ESPN). Falta una 2ª fuente gratis para que
   la discrepancia (señal de riesgo estrella) tenga materia prima siempre.
3. **Lineups/lesiones no entran al pick**, solo se marcan. Las alineaciones salen 1–3h antes;
   el mercado se mueve con eso.
4. **El mercado de totales es débil** (52% OOS). Es el más blando de las casas = oportunidad.
5. **Muestra:** ~110 días de datos NUESTROS con odds. El CLV necesita ~2–3 semanas para veredicto.
6. **No hay módulo de banca/staking** para el usuario (cuánto apostar).
7. **No hay alertas/push** cuando sale un fijo o cambia un abridor.
8. **No hay CI** que corra las suites en cada PR (hoy las corro yo a mano).
9. **PWA/móvil** de las páginas nuevas sin pulir (offline, instalable).

---

## PARTE 3 — Plan de COMPACTACIÓN (desde tu Mac, con el privado)

> Objetivo: un solo repo fuente, la app React nativa con todo, sin páginas fallback sueltas.

**Paso 0 — Clona ambos en tu Mac:**
```bash
git clone git@github.com:adclara/mlb-predict.git         # privado (fuente)
git clone git@github.com:adclara/mlb-predict-site.git     # público (deploy)
```

**Paso 1 — 🔴 CRÍTICO: portar el robot al privado.** Copia estos archivos del **público** a
donde `deploy_demo.sh` los toma en el **privado** (revisa el script para la ruta exacta):
- Nuevos: `robot/context.mjs`, `weather.mjs`, `elo_live.mjs`, `backfill_history.mjs`, `live_odds.mjs`
- Modificados: `robot/daily.mjs`, `odds.js`, `espn_odds.mjs`, `adrian.js`, `learn.js`, `venues.js`
- Workflow: `.github/workflows/adrian-daily.yml` (cron horario + poke + watcher)
- Si no se portan, el próximo `deploy_demo.sh` los borra.

**Paso 2 — Mover el panel a la app React.** En el privado, crea la página "Hoy" nativa con:
- El Top 3 (chips ⚡🏦🧠), indicadores, y por juego las 3 opiniones + brief.
- Métodos nuevos en el service: `getDayFile(date)` (plays/locks/gems), `getLive(date)`,
  leer `brief` de los games y `locks_record`/`gems_record` del índice.
- Reusa `live.html` como referencia de diseño (ya validado, paleta con contraste/CVD).

**Paso 3 — Unificar y limpiar.** Cuando la app nativa tenga todo: decide si `live.html`/
`gemas.html` quedan como PWA ligera o se retiran. El chip de `index.html` apunta a la ruta nativa.

**Paso 4 — Un solo pipeline.** `deploy_demo.sh` despliega bundle + robot + data al público.
Verifica que el workflow del público siga siendo el horario+poke.

---

## PARTE 4 — Plan Maestro del ALGORITMO (más pruebas y simulaciones)

> Método para TODO: pre-registrar la dirección, walk-forward, intervalo de confianza,
> estabilidad en ambas mitades, y **reportar también lo que no funciona**. Cada experimento
> es un script en `scratchpad/` estilo los `sim_*.mjs` que ya existen.

### 🥇 Nivel 1 — Mayor apalancamiento (hazlo primero en tu Mac)
- **A. Odds históricas + backfill completo con features.** El backfill actual (2023–25) NO
  tiene odds. Consigue una fuente de odds de cierre históricas (The Odds API tiene histórico
  de pago; o scrape de retrosheet/otros) y reconstruye filas `games_v1` completas → **10× la
  potencia** para calibrar el cerebro, validar los fijos y medir CLV de verdad. Esto blinda
  todo lo demás.
- **B. Corre el robot en vivo desde tu Mac.** Sin el proxy que me limitaba a mí, `node
  robot/daily.mjs 2026-07-08` corre contra las APIs reales. Úsalo para depurar multi-casa,
  platoon, bateadores y F5 con datos frescos al instante.

### 🥈 Nivel 2 — El mercado débil (totales)
- **C. Modelo de totales dedicado.** Es 52% OOS = el más batible. Ahora que viento×parque está
  vivo: estudia over/under con park factor + viento + temperatura + F5. Añade **umpire**
  (statsapi da el ump asignado; hay tendencias de strike zone documentadas).
- **D. Bullpen en INNINGS, no en juegos.** Hoy `pen_load_l3` cuenta juegos; reconstruye
  entradas lanzadas por el pen en los últimos días (linescore) → fatiga real de bullpen.

### 🥉 Nivel 3 — Información que el mercado tarda en digerir
- **E. Lineups pregame.** Baja la alineación (statsapi la publica ~2–3h antes); ajusta el
  factor bates por quién juega, o al menos marca "estrella descansa". Es info que mueve la línea.
- **F. Matchup abridor × alineación** con splits reales (ya tienes vsL/vsR por equipo; sube a
  nivel de bateador).
- **G. Segunda fuente de odds gratis** para multi-casa real y mejor discrepancia.

### 🔬 Nivel 4 — Validación y producto
- **H. CLV como estrella polar.** Vigílalo 2–3 semanas. Si es consistentemente positivo,
  prueba que le ganamos al cierre → edge real demostrado (literatura profesional).
- **I. Módulo de banca.** Kelly fraccional con tope; simula bankroll; muestra "cuánto apostar".
- **J. Cola de experimentos de modelo** (cada uno un `sim_*.mjs` walk-forward, adoptar solo con CI):
  1. Peso del abridor por su forma reciente (no solo FIP temporada).
  2. Totales por parque específico.
  3. Modelo en vivo (con las curvas que ya capturamos).
  4. Re-torneo de metodologías cuando haya odds históricas (quizás con más datos alguna gane).

### 🛠 Nivel 5 — Infra
- **K. CI en PRs**: GitHub Action que corra las suites (`test_robot.mjs`, `e2e_daily.mjs`) en
  cada PR. Hoy no existe.
- **L. Alertas**: notificación cuando sale un fijo o cambia un abridor.

---

## PARTE 5 — Cómo trabajar desde tu Mac (flujo)

```bash
# correr el robot en vivo (¡tu Mac SÍ tiene red a las APIs!)
cd mlb-predict-site
DATA_DIR="$PWD/data" node robot/daily.mjs            # hoy
DATA_DIR="$PWD/data" node robot/daily.mjs 2026-07-08 # una fecha

# correr las simulaciones / backtests
node scratchpad/sim_locks_tournament.mjs
node scratchpad/sim_method_tournament.mjs
node scratchpad/sim_gem.mjs

# las suites de prueba (deben quedar en verde antes de cualquier merge)
node scratchpad/test_robot.mjs      # unit
node scratchpad/e2e_daily.mjs       # end-to-end con fetch simulado

# disparar una corrida en producción al instante (sin esperar el cron)
date -u > .github/poke && git commit -am "poke" && git push   # a main
```

**Regla de oro del proyecto** (lo que lo hace confiable): honestidad. Nunca prometer ganancia,
todo con intervalo de confianza, reportar los experimentos que fallan. Eso ya está en el ADN
del código (`docs/ESTUDIOS.md`) y es lo que hay que mantener.

---

## Resumen de una línea
Tenemos un sistema honesto que **empata al mercado en probabilidad y le gana en selección**
(fijos +7.9% ROI). Lo que sigue: **consolidar en un repo**, **conseguir odds históricas para
10× la muestra**, **atacar los totales** (el mercado débil), e **integrar lineups**. Todo con el
mismo método científico que ya evitó que adoptáramos una señal falsa.
