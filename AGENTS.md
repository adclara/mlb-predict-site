# AGENTS.md — AA Sports (aasport.net)

> Contexto para agentes de IA (Codex, Claude Code, etc.) que trabajan en este
> repo. Léelo entero antes de tu primera tarea.

## Qué es
Sitio de predicciones deportivas data-driven, **$0 de infraestructura**, sobre
Cloudflare. Marca: **"AA Sports · Los datos deciden"**. Deportes: **MLB**
(completo, con predicciones), **fútbol** (predicciones públicas desde jul-2026),
**NBA/tenis** (marcadores + posiciones; modelos en sombra, sin publicar) y
**WNBA** (marcadores, resultados, posiciones, box score y comparador de mercados;
modelos en sombra, sin predicciones públicas) y **NFL** (cobertura factual +
comparador con gates cerrados). El **Radar legacy de wallets está pausado**:
sus rutas, alertas y Telegram siguen detenidos. La Central AA sí consulta
Polymarket y Kalshi en solo lectura, sin alertas, para contexto multifuente.

## ADN NO NEGOCIABLE (aplica a TODO cambio)
- **$0**: solo free tiers (Cloudflare Workers/KV/D1/Pages + GitHub Actions + APIs
  gratis/keyless). Nada que cueste sin aprobación explícita.
- **Honestidad**: todo número es medido; nada inventado. **Caja de honestidad y
  aviso legal SIEMPRE visibles.** Si un modelo no pasa su gate, NO se publica —
  se reporta tal cual. El tamaño de muestra en vivo se muestra aunque sea chico.
- **Bilingüe ES/EN**: diccionario `T = {es:{...}, en:{...}}` + `t(key)` en
  `index.html`. Todo texto nuevo va en ambos idiomas.
- **Algoritmo privado**: el modelo corre server-side (GitHub Actions); el
  navegador solo consume resultados ya calculados. Nunca pongas lógica de modelo
  en el frontend.
- **«Posible informado» = patrón estadístico compatible con información, NUNCA
  una acusación.** Redacta siempre así.
- **Antes de desplegar**: `node --check` + suite Playwright (desktop + móvil 390
  y 360, **0 errores de consola**, sin overflow horizontal) + regresión de MLB.

## Arquitectura
```
Repo (algoritmos privados)
  → GitHub Actions (cron) corre robot/*.mjs → escribe a KV/D1 vía API de Cloudflare
  → el repo privado US publica solo evidencia sanitizada por un puente GitHub OIDC
     sin secret estático; el Worker fuerza todas sus filas a shadow
  → Cloudflare Worker (aa-sports-api) = API pública de solo-lectura desde KV/D1
  → Cloudflare Pages (aa-sports) = frontend (cloudflare/pages/index.html)
```

## IDs de Cloudflare (públicos, ya en el código — NO son secretos)
- Account ID: `f02574feb7272a1da2818e35e0ff4342`
- KV namespace (binding `AA_LATEST`): `683aa2f8846643bf8a6a8b606e5bf0b7`
- D1 database (binding `DB`): `ed0969d8-050a-4987-ab98-b047c30f76c9`
- Pages project: `aa-sports` · target `aa-sports-5ap.pages.dev` · dominio `aasport.net`
- Worker: `aa-sports-api` · **API base** `https://aa-sports-api.opsmira9.workers.dev`
- Subdominio `radar.aasport.net` → la app (arranca en la pestaña Radar)
- Subdominio `qa.aasport.net` → QA privado autenticado; muestra filas `shadow`
  medidas sin abrirlas al público ni cambiar sus gates.

## Secretos (viven en GitHub Actions, NUNCA en el repo ni en el agente)
El deploy corre DENTRO de Actions con estos secretos; el agente solo necesita
**acceso de escritura al repo de GitHub**, jamás los valores de los tokens.
- `CLOUDFLARE_API_TOKEN` (alias `CLOUDFLAREAPITOKEN`): scopes **Workers:Edit ·
  Pages:Edit · KV:Edit · D1:Edit · Zone:Read · DNS:Edit**.
- `TG_BOT_TOKEN`, `TG_CHAT_ID`: alertas del Radar por Telegram (@POLYSIBOT).
- `QA_ALLOWED_EMAILS`: lista separada por comas de cuentas Google autorizadas
  para `qa.aasport.net`. Si falta, QA queda bloqueado por diseño (401/403).
- `TENNIS_API_KEY`: (pendiente de crear) stats de tenis SportDevs.

## Cómo se DESPLIEGA — «poke files» (crítico)
La integración de GitHub **no puede** `workflow_dispatch` (da 403). El deploy se
dispara tocando un archivo "poke": PR → merge a `main`, y el push a `main` en ese
path dispara el workflow. Mapa verificado (poke → workflow):
- `.github/poke-deploy` → **deploy.yml** (Deploy Worker + Deploy Pages + "Verificar
  y diagnosticar producción" en aasport.net) ← el deploy principal
- `.github/poke-qa` → qa.yml (qa_check.mjs contra producción)
- `.github/poke` → adrian-daily.yml (slate + gradación + publicación; cron horario
  + watchdog redundante 7–8am ET que corre solo si producción sigue pendiente)
- `.github/poke-learn` → mlb-learning-daily.yml (refit + Cerebro AA una vez al día)
- `.github/poke-live` → mlb-live-observer.yml (multi-book/WP en vivo; no bloquea daily)
- `.github/poke-us-sports` → us-sports-qa.yml (frescura NFL/NCAAF/NHL/NCAAM; cron 4×/día)
- `.github/poke-poly` → sin efecto mientras `poly-study.yml` permanece pausado
- `.github/poke-intelligence` → market-intelligence.yml (pulso multifuente 30m
  activo/2h calma + perfil causal diario de wallets; nunca alertas/Telegram)
- `.github/poke-soccer` → soccer-shadow.yml (soccer_shadow.mjs; publica soccer:today)
- `.github/poke-nba` → nba-shadow.yml · `.github/poke-sim` → mlb-sim.yml (semanal)
- `.github/poke-wnba` → wnba-shadow.yml (ganador/totales WNBA en sombra + Cerebro
  y contratos de mercados; cron horario)
- `wnba-validation.yml` → validación causal diaria + backfill/retrain semanal
- `.github/poke-sport-brains` → sport-brains.yml (Cerebros soccer/NBA/WNBA/tenis)
- `.github/poke-injuries` → injuries.yml · `.github/poke-fase2` → fase2-backfill.yml
- `.github/poke-probe` → probe-espn.yml · `.github/poke-domain` → domain-fix.yml
- `.github/poke-subdomain` → subdomain.yml
- (tenis: `tennis-stats.yml` aún NO existe; se crea al tener `TENNIS_API_KEY`)

### Ciclo de trabajo estándar (cada cambio)
1. Trabaja en una **rama** (nunca commits directos a `main`).
2. Cambios → `node --check` de los .mjs/worker + Playwright + regresión MLB.
3. PR → **squash-merge** a `main`.
4. Si tu rama diverge tras el merge:
   `git fetch origin main && git checkout -B <rama> origin/main`.
5. `echo "deploy $(date +%s)" > .github/poke-deploy` → PR → merge (si tocaste
   worker/frontend). Si tocaste un robot, además el poke correspondiente.
6. Verifica el run de **deploy.yml** en verde y revisa `robot/prod_diag.mjs` en el
   log (imprime estado de las rutas del Worker en producción).

## KV keys (las escribe el robot, las sirve el Worker)
`mlb:today`, `mlb:day:<fecha>`, `mlb:learning`, `mlb:simulation`, `soccer:today`,
`poly:radar`, `poly:alerts`, `poly:lastseen`, `intelligence:{today,wallets}`,
`intelligence:day:<fecha>`, `injuries:latest`,
`soccer:learning`, `nba:learning`, `wnba:{today,learning,simulation}`,
`nfl:{today,learning,simulation}`, `tennis:learning`.

## Rutas del Worker (`cloudflare/worker/index.js`)
`/v1/mlb/{today, day/:date, schedule/:date, event/:id, history, live, learning,
simulation, standings}`, `/v1/injuries`,
`/v1/intelligence/{today,history}`, `/v1/qa/intelligence/today`,
`/v1/soccer/{today, live, recent, standings, leagues, summary, learning}`,
`/v1/nba/{today, live, recent, standings, summary, history, learning, simulation,
pipeline-health}`,
`/v1/wnba/{today, live, recent, standings, summary, history, learning, simulation,
pipeline-health}`,
`/v1/{nfl,ncaaf,nhl,ncaam}/{today,live,recent,standings,summary,history,learning,
simulation,pipeline-health}`,
`/v1/qa/{wnba,nfl,ncaaf,nhl,ncaam}/{today,history,learning,simulation,
pipeline-health}` (sesión Google verificada + allowlist; `no-store`),
`/v1/tennis/{live, recent, rankings, summary, learning}`,
`/v1/poly/{radar, alerts, track}` (pausadas: responden `state:paused` sin consultar
Polymarket), `/v1/auth/google`.
El Worker corre un `scheduled()` cada 20 min para capturar hechos públicos MLB y
NFL/NCAAF/NHL/NCAAM (sin lógica de modelo) en D1. Radar, sus snapshots y Telegram
están detenidos por decisión del operador. La captura MLB no contiene lógica del modelo.
La única ruta HTTP de escritura es `/v1/internal/model-publish`: exige un JWT
OIDC RS256 de GitHub con audience propio, repository id del repo privado, `main`
y `hourly-shadow.yml`; vuelve a sanitizar el payload y nunca acepta aprobación
humana ni scope público. No requiere copiar `CLOUDFLARE_API_TOKEN` al repo privado.

## Archivos clave
- **Frontend**: `cloudflare/pages/index.html` — UN archivo HTML/JS, **SIN build,
  sin node_modules, sin framework**. Es grande; edítalo con cirugía. Otros:
  `cloudflare/pages/_headers`, `functions/share/[[path]].js` (Pages Function: OG
  dinámico para tarjetas de compartir), `sw.js`, `manifest`, `vendor/` (gsap,
  lottie vendorizados), `assets/` (og.png 1200×630, iconos PWA).
- **Normalización** a esquema común de evento: `cloudflare/lib/normalize.mjs`.
- **Robot** (corre en Actions, Node stdlib, sin deps):
  - `robot/daily.mjs` — arma/gradúa el MLB del día y congela un ledger pregame
    inmutable. `robot/mlb_ingest_consumer.mjs` consume los slots públicos D1.
    `robot/mlb_publish_watchdog.mjs` comprueba producción varias veces entre
    7–8am ET y reintenta la publicación solo si hoy tiene 0 predicciones AA.
  - `robot/learn.js` + `robot/mlb_learn_daily.mjs` — re-ajuste diario causal +
    walk-forward; `FORMULA_VERSION = 'v2'`;
    calibración Platt → `prob_v2` (el número calibrado que se muestra).
  - `robot/aa_lab.mjs` + `robot/models/aa_lab_mlb_v1.json` — challenger
    multitemporada 2021–2025. Corre cada hora dentro de `adrian-daily`, congela
    predicciones forward en `shadow.aa_lab` y escribe el reporte privado
    `data/history/aa_lab_forward.json`. Nunca cambia ni se expone junto a AA.
  - `robot/adrian.js` — selección de fijos (locks/ORO/PLATA) y gemas.
  - `robot/learning_journal.mjs` — "Cerebro AA" (qué aprende; KV mlb:learning).
  - `robot/simulate.mjs` — validación OOS completa (KV mlb:simulation; semanal).
  - `robot/soccer_shadow.mjs` — sombra + **publica soccer:today** (predicciones
    públicas de fútbol). `robot/soccer_model.mjs` — Dixon-Coles + backtest.
  - `robot/nba_model.mjs`/`nba_shadow.mjs`, `robot/wnba_model.mjs`,
    `robot/wnba_market_model.mjs`, `robot/wnba_player_model.mjs`,
    `robot/wnba_publish_simulation.mjs`, `robot/sport_brain.mjs`,
    `robot/tennis_model.mjs`/`tennis_stats.mjs`.
  - `robot/poly_radar.mjs` + `robot/poly_study.mjs` + `robot/lib/{poly,espn_odds}.mjs`.
  - `robot/prod_diag.mjs` (diagnóstico post-deploy), `robot/qa_check.mjs`,
    `robot/injuries.mjs`, `robot/domain_fix.mjs`, `robot/subdomain_radar.mjs`,
    `robot/subdomain_qa.mjs`.
- **Datos**: `data/history/games/*.json`, `data/history/index.json`,
  `data/history/learning.json`, `data/fase2/{soccer,nba,tennis,wnba}/*`.
  D1 usa `sport_market_predictions` como ledger multideporte fail-closed;
  toda fila nueva nace `shadow`, sin aprobación humana.

## Modelos — estado y gates de honestidad
- **MLB** (producción): el % mostrado es **calibrado** (`prob_v2`/Platt), no el
  clásico inflado. En la auditoría causal OOS el combinado ronda 53.2% de
  acierto y ECE ~3.8%. El mercado histórico gana en promedio; la hipótesis de
  mejora por selección sigue en validación forward. ORO, Over, F5 y abridor/F5
  no se publican mientras sus gates permanezcan cerrados.
- **AA Lab MLB** (sombra): logit compacto multitemporada, seleccionado con
  holdouts rolling 2022–2025 y examen intacto 2026. Registra máximo dos señales
  diarias para validación forward; no se publica aunque el gate estadístico
  llegue a pasar hasta recibir aprobación humana explícita.
- **Fútbol** (público): Dixon-Coles validado en **16,059 partidos** (Brier pasa
  gate, calibrado). Número = prob del mercado **des-vigada y calibrada** (≈ mercado;
  no promete ganarle al cierre). El récord EN VIVO se muestra tal cual.
- **NBA / Tenis** (sombra): registran picks en D1 sin publicar. **No publicar
  predicciones** hasta pasar gate (calibración + muestra en vivo suficiente) y con
  aprobación humana. NBA se enciende ~octubre; tenis stats depende de TENNIS_API_KEY.
- **WNBA**: cobertura factual pública + Elo/MOV privado en sombra. Backtest
  cronológico desde 2023 con 2021–22 como burn-in; la muestra y las métricas se
  recalculan con cada backfill semanal y se validan contra sus temporadas, sin
  fijar como contrato un conteo mutable. Totales y PTS/REB/AST tienen backtests causales separados; sin
  líneas/precios pregame auditables sus gates permanecen cerrados. Es evidencia
  histórica, no garantía: no publica picks hasta completar muestra forward,
  calibración, comparación de mercado y aprobación.
- **NFL / NCAAF / NHL / NCAAM**: marcadores y captura factual activos; modelos
  privados en `adclara/aa-sports-models-private`, con gates cerrados. No publicar
  Top 2 hasta validación forward suficiente + aprobación humana explícita.

## Testing (Playwright)
- Playwright está **global** en `/opt/node22/lib/node_modules` (corre con
  `NODE_PATH=/opt/node22/lib/node_modules node test.mjs`); Chromium en
  `/opt/pw-browsers/chromium` (usa `executablePath`). En otro entorno, instala
  `playwright` y ajusta las rutas.
- Patrón: servidor HTTP estático que **quita el `?query` ANTES** de checar
  `=== '/'`; `page.route('**/v1/...')` para mockear la API; `newContext({viewport})`;
  filtrar ruido de red del sandbox (`ERR_TUNNEL_CONNECTION_FAILED`,
  `Failed to load resource`) para no confundirlo con errores de JS.
- Viewports obligatorios: desktop + 390 + 360. Assert: sin overflow
  (`scrollWidth <= clientWidth`), 0 errores de consola de la app.

## Reglas de git
Rama de trabajo, nunca `main` directo. Commits descriptivos. Squash-merge. No
inventes datos ni resultados. Si un test falla, dilo con el output real.
```
