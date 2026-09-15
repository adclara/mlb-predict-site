# Auditoría Fase 0 — Frontend de producción (rediseño Matchday Studio)

> Rama `redesign/fase-0-auditoria`. Documento de solo lectura sobre
> `cloudflare/pages/index.html` (UN archivo, 6,187 líneas / ~493 KB, sin build).
> Nada de esto modifica el frontend. Fecha de la auditoría: estado del repo tras
> los PR #256–#263 (2026-09-15).

## 0. Resumen ejecutivo

- La migración Matchday Studio declarada en `docs/MATCHDAY_STUDIO_MIGRATION.md`
  (fases 2–5) **ya está aplicada** en producción: paleta night-blue, rail
  lateral Studio, hero con silos MLB, pestañas de partido Studio y las vistas
  "resto de app" (Historial, Cerebro, Educación, Herramientas, Config) con
  encabezados `.pagehead` + `.appcard`. Marcadores en el código:
  `AA_STUDIO_TOKENS_V1` (l. 32), `AA_STUDIO_VIEWS_V1` (l. 439),
  `AA_STUDIO_APP_V1` (l. 1359), `AA_STUDIO_QA_V1` (l. 1360).
- Quedan **residuos del diseño anterior** (colores huérfanos, ~108 estilos
  inline, fallbacks de panel viejos) y un **bloque grande semi-muerto**: todo el
  Radar legacy de wallets (JS + CSS, ~1,000 líneas) está pausado
  (`RADAR_PAUSED = true`, l. 4577) y la Central AA lo cortocircuita
  (`CENTRAL_INTELLIGENCE = true`, l. 4578).
- El prototipo `studio.html` (189 líneas, datos sintéticos, sin red) NO es la
  fuente de verdad funcional: la app real tiene otra navegación (chips de
  deportes + pestañas de lista), otros nombres de variable y más vistas.

## 1. Inventario de vistas y estados

### Navegación global

- **Rail lateral** `.aa-rail` (fijo, 184px → 78px <1180px → oculto <900px):
  Central AA · Partidos · Favoritos · Análisis · Posiciones · Historial ·
  Cerebro · Educación · Herramientas · Config (l. 1431–1440).
- **Barra de deportes** `.sp` (horizontal, con swipe hint en móvil):
  Central AA (default), MLB, NBA, WNBA, NFL, NCAAF, NHL, NCAAM, Soccer, Tenis
  (l. 1482–1523).
- **Pestañas de lista** `.ltab`: Todos · Favoritos · Posiciones · Historial ·
  Cerebro (Favoritos/Historial solo visibles en MLB; datebox solo MLB)
  (l. 1533–1544; `setSport` l. 5940).
- **Estado global mutable**: `sport`, `listTab`, `dtab`, `viewDate`,
  `selectedId` + caches (`standingsCache`, `summaryCache`, `sportModelDocs`…).
  Todo re-renderiza por `innerHTML` con listeners delegados en `document`.
- Layout de 3 columnas: lista `.listpane` · detalle `#dcard` · widgets
  `.colside`. En <900px el detalle es overlay `.detail.open` con `#dback`.

### Vista por vista

| Vista | Entrada | Qué renderiza | APIs que consume | Estados |
|---|---|---|---|---|
| **Central AA** (default, `sport='radar'`) | rail "Central AA" / chip radar | `centralListHtml()`: slate de jugadas públicas AA gated + favoritos factuales de mercado, bundles multideporte informativos, estado de fuentes | `/v1/intelligence/today` (poll 5 min) | loading (`.skel`), vacío honesto (`intel_empty`, "no rellenamos una cuota"), **stale** (snapshot conservado con aviso de minutos, precios externos y bundles ocultos), con datos (`.intelrow`) |
| **Partidos MLB — lista** | rail "Partidos" / chip MLB | Boleto del día (fijos/gemas con récord real y deslinde), Top señales AA, indicadores de Altas (gate cerrado, solo observación), filas `.mrow` con pick calibrado | `/v1/mlb/today` (boot + 5 min), `/v1/mlb/live` (45 s), `/v1/injuries` (30 min) | skeleton ×6 (`.skel`), vacío, error (`load_err_retry`), `docStale` (doc de un día pasado: aviso "mostrando últimos resultados"), futuro (`/v1/mlb/schedule/:date`, sin predicción), `pending` (publicación atrasada), `invalidated` (cambió el abridor) |
| **Detalle MLB** (`#dcard`) | click en `.mrow` | `.dhero` con silos oficiales MLB (`img.mlbstatic.com`, fallback iniciales), prob calibrada, riesgo, pestañas `.dtab`: **Resumen / Equipos / Pitchers / Bateadores** (con `snapshot`) · **Total / Jugadores / Combos** (`.dtab.locked`, `lockedMarketTab`, gate cerrado) · **Simulación** (10,000 corridas de la prob publicada) · **Mercado** | sin ruta propia: todo viene embebido en `/v1/mlb/today` + overlay de `/v1/mlb/live` (prob en vivo) | vacío (`detail_empty`), invalidado (aviso prominente, sin %), pendiente, enter-animation `.dcard.enter` |
| **Live** | no es vista separada | filtro pill "En vivo" (`.pill[data-f=live]`), ticker `#ticker` con chips en vivo, prob en vivo en el detalle | `/v1/mlb/live` (45 s) con date guard `AA_MLB_LIVE_DATE_GUARD_V2` (cruce por fecha ET + hora; doble jornada fail-closed) | sin juegos en vivo → pill vacía; marcadores de ayer no contaminan hoy |
| **Posiciones** | `.ltab[data-lt=pos]` | Tablas `.sttbl` por división/liga (MLB 6 secciones, soccer 8, tenis ranking mundial) | `/v1/{sport}/standings`; tenis: `/v1/tennis/rankings`; soccer con `?league=` | `st_loading`, `st_none`, con datos (encabezado medido, "no es un pick AA") |
| **Historial MLB** | `.ltab[data-lt=hist]` | Dashboard (récord, unidades solo con cuota real, racha, curva) + lista de picks graduados por cohorte (público/legacy/push/void auditables) | `/v1/mlb/history?days=30` | `hist_loading`, `hist_none`, con datos; export CSV local |
| **Cerebro** | `.ltab[data-lt=brain]` | Qué aprende el modelo, señales medidas, fila de gates (copy "no publicado"), calibración | MLB: `/v1/mlb/learning` + `/v1/mlb/simulation`; otros deportes: `/v1/{sport}/learning` + `/v1/{sport}/pipeline-health` | `brain_soon` (sin doc), `brain_accum` (muestra insuficiente), `producer_unknown/unavailable` |
| **Favoritos** | rail / `.ltab` | Juegos marcados ⭐ (localStorage `aa_favs`); si hay sesión, sync | `/v1/me/favs` (GET/POST, credentials) | vacío (`mlb_fav_hint`), notificación del navegador al pasar a EN VIVO/FINAL |
| **Educación / Herramientas / Config** | rail | Acordeones FAQ; calculadora local EV = p × decimal − 1; idioma + movimiento reducido, export de datos locales | ninguna (100% local) | n/a (estático) |
| **Otros deportes** (NBA/WNBA/NFL/NCAAF/NHL/NCAAM) | chip `.sp` | Lista de marcadores (`.mrow[data-oid]`), banner de evidencia histórica del modelo en sombra, comparador factual de mercado des-vigado; detalle con 4 mercados (`market-tab`) y gates cerrados con progreso n/min_forward | `/v1/{sport}/live` + fallback `/v1/{sport}/recent`; `/v1/{sport}/today` (doc de modelo saneado); detalle: `/v1/{sport}/summary`; QA autenticado: `/v1/qa/{sport}/...` | loading, vacío (`o_no_events`), "últimos resultados" (`o_recentnote`), gate cerrado fail-closed, 403 ESPN no revierte UI |
| **Soccer** | chip `.sp` | Carrusel de ligas `#lgchips` (8 ligas), predicción pública AA calibrada por partido (única liga no-MLB con chip AA) | `/v1/soccer/live|recent|standings|summary` + `/v1/soccer/today` + `/v1/soccer/learning` | espera `soccer:today` antes del primer pintado (QA_V1); vacío por liga |
| **Tenis** | chip `.sp` | Marcadores + ranking mundial | `/v1/tennis/live|recent|rankings|summary|learning` | mismos estados genéricos |
| **Radar legacy (wallets)** | — | **PAUSADO**: `RADAR_PAUSED=true`; la rama legacy de `renderRadarList`/`renderRadarDetail` (búsqueda de wallets, alertas, comparador, categorías) nunca se ejecuta en runtime | `/v1/poly/{radar,track,alerts,wallet}` quedan sin consultar (guards en `loadRadar`/`loadAlerts`) | solo existe el estado "pausado" detrás de la Central |
| **Auth / cuenta** | `#authbox` en header | Login Google, menú de cuenta, borrado de datos | `/v1/auth/google`, `/v1/me`, `/v1/auth/logout`, `/v1/me/delete`, `/v1/me/favs` | logged-out (botón), logged-in (avatar + menú), QA banner (`#qaBanner`, allowlist) |
| **Diálogos de honestidad** | widget "Juego responsable" + footer | `#howdlg` (metodología: modelo privado, validación, sombra, calibración, tú decides) y `#legaldlg` (aviso legal) | ninguna | siempre accesibles; footer `foot` + widget `w_resp` siempre visibles (ADN) |

### Estados transversales

- Loading: `.skel` (lista), textos `*_loading` por vista.
- Vacío honesto: `.lempty`, `.lempty2`, `.dempty`, `.wempty`, `.bempty`,
  `.sigempty`, `.bolempty` — nunca se rellena por rellenar.
- Error de red: `load_err_retry` / `load_err_date`; los catch silenciosos
  conservan el último snapshot (inteligencia) o el estado vacío honesto.
- Auto-refresh: 45 s (live/otros), 5 min (MLB today / intelligence), 30 min
  (injuries); refresh extra en `visibilitychange`/`online`.

## 2. Mapa de tokens

### `:root` (l. 31–42) — ya migrado (`AA_STUDIO_TOKENS_V1`, PR #256)

| Token | Valor | Uso |
|---|---|---|
| `--rail` | 184px (→78px <1180px, →0 <900px) | ancho del rail Studio |
| `--page` | `#060c15` | fondo noche |
| `--panel` | `#0b1624e6` | superficie vidrio |
| `--panel-2` / `--inner` | `#101f30` / `#101f30d9` | superficie elevada |
| `--hair` / `--hair-2` | `#21354c` / `#2d4a68` | bordes |
| `--text` / `--dim` / `--faint` | `#f2f5fc` / `#a0b0c6` / `#7d91aa` | texto |
| `--blaze` / `--sky` | `#4da8ff` (duplicado intencional) | acento azul |
| `--volt` | `#32dfb4` | verde acierto |
| `--amber` | `#f8c657` | dorado ORO |
| `--red` | `#ff6277` | rojo derrota/live |
| `--grad` | `linear-gradient(100deg,#94d3ff,#1c87e9 55%,#32dfb4)` | marca/degradado AA |
| `--glass` | `blur(16px) saturate(140%)` | vidrio header |
| `--shadow` | inset + `0 14px 48px #0003` | sombra única |

**No existen** tokens de escala de espaciado ni de radios: radios hardcoded de
4 a 20 px y paddings/márgenes literales en todo el CSS. Solo hay UNA sombra.

### Tipografías

- **Manrope** 400–800: texto/UI (`body`, l. 47).
- **Barlow Condensed** 600–800 + italic: display (`.wordmark`, `.dteam .nm`,
  `.dscore`, `.prob-pct`, `.sp`, `h2/h3`, `.secttl`, métricas grandes).
- Ambas desde Google Fonts (l. 9–11) — dependencia de red externa; los tests
  la mockean.
- Números: `.num` con `tabular-nums`.

### Ya migrado desde Matchday Studio (PRs #256–#263)

- Paleta night-blue completa + gradiente de marca + favicon night-blue (#262).
- Rail Studio `.aa-rail` con colapso 184→78→oculto y foot "MLB publicado /
  otros en gate" (#256, #262).
- Hero del detalle `.dhero` con silos oficiales MLB por `person id` y máscaras
  laterales (#256); jornada destacada `.jornada` con silo (#260).
- Pestañas de partido Studio `.dtab` + gates Total/Jugadores/Combos con
  `.dtab.locked` (#258).
- Vistas de app: `.pagehead`, `.appcard`, `.educol`, `.toolgrid`, `.cfgrow`,
  `.bgates` (#260); posiciones con encabezado medido y soccer esperando su
  chip AA (#262).

### Residuos del diseño anterior (no migrados)

| Residuo | Dónde | Nota |
|---|---|---|
| `#FFC53D` (ámbar viejo) | `.qa-banner`, `.qa-badge`, estrella SVG l. 3702 | convive con `--amber:#f8c657` |
| `#FF7A3D` (naranja) | `.dots.a i.on` l. 1154 | fuera de paleta |
| `#2A3342` (slate viejo) | `scrollbar-color` l. 44, 385, 389 | scrollbars |
| `#a78bfa` (púrpura) | `CAT_HUE` radar legacy l. 4874–4887 | código pausado |
| `#12161f` / `#151a24` / `#0B0E14` | fallback de `--panel` en `.howcard`/`.authmenu`, `#polytoast`, `.afall` | paneles del diseño previo |
| `#cbd5e1`, `#9AA4B5` | `.tag.plata`, icono de búsqueda | grises viejos |
| ~108 atributos `style="…"` inline | hero dinámico, authbox, banners | duplicación fuera de tokens |
| Tags de confianza (`.tag.oro/plata/gema/fijo`) con `rgba()` propios | lista/detalle | colores no tokenizados |
| **CSS + JS del Radar legacy** (~1,000 líneas: `.rdhero`, `.lhero`, `.rdhon`, `.rdstories`, `.catchip`, `.cmptray`, `.stats3`, `walletCard`, `heroCard`, `alertRow`, etc.) | l. ~850–1000 CSS, ~4700–5700 JS | **muerto en runtime** (pausado), sigue pesando en el archivo |
| Tema claro | **no existe** en producción | el prototipo sí tiene `data-theme=light` |

## 3. Brecha vs `studio.html` y el plan

Fuentes: `studio.html` (prototipo autocontenido, 189 líneas, datos sintéticos,
banner "no son predicciones AA"), `docs/MATCHDAY_STUDIO_MIGRATION.md` (fases
0–5, todas marcadas "Hecho 2026-09-15"), `docs/MASTER_PROMPT.md` (app de 18
vistas). `docs/PLAN_MAESTRO.md` es **histórico** (lo dice su propio encabezado)
y no aporta al rediseño visual.

Según el plan, las fases 2–5 están hechas. Lo que **sí queda** por migrar o
evolucionar:

1. **Vista "Inicio"**: el plan de 18 vistas incluye Inicio con hero de jornada;
   en producción no existe como vista — el arranque es Central AA y el rail no
   tiene "Inicio". La `.jornada` destacada existe pero solo como tarjeta dentro
   de la lista MLB.
2. **Hero cinematográfico con retratos ilustrados 80%** (`public/art/players/
   {id}-hero.jpg`, regla I2I del master prompt): no existe en Pages; producción
   usa solo el silo oficial MLB en `.dhero`/`.jornada`. El pack de arte vive
   en el Studio, no en este repo.
3. **Logos locales `public/teams/{espn}.png`**: no existen aquí; se usa el CDN
   de ESPN directo con `onerror` → iniciales (`.tfall`).
4. **Tema claro**: el prototipo define `html[data-theme=light]` completo;
   producción es solo oscura.
5. **Navegación móvil inferior** (`.mobile-bottom` del prototipo): producción
   oculta el rail <900px y se apoya en los chips de deportes + overlay de
   detalle. No hay bottom nav.
6. **Búsqueda**: el prototipo tiene modal global (⌘K, `dialog` con resultados);
   producción solo filtra la lista de partidos con `#q`.
7. **Nombres de tokens divergentes**: studio usa `--bg/--side/--line/--muted/
   --blue/--green/--gold/--r:13px`; producción `--page/--panel/--hair/--dim/
   --sky/--volt/--amber` (mismos valores, otro nombre). Portar CSS del
   prototipo exige mapeo manual — no copy-paste.
8. **Escala de espaciado/radios**: el prototipo al menos fija `--r:13px`;
   producción ni eso. Si el rediseño quiere sistema, hay que crearlo.
9. **Deuda de limpieza previa a nuevas fases**: podar o aislar el Radar legacy
   pausado y unificar colores residuales antes de seguir metiendo CSS.

## 4. Riesgos para las fases siguientes

1. **Archivo único de ~493 KB / 6,187 líneas.** Todo es cirugía
   (Grep + rangos); prohibido reescribir (riesgo explícito del plan).
2. **Código muerto del Radar legacy** mezclado con el vivo: un refactor de
   tokens puede tocar selectores que solo usa la rama pausada; decidir poda vs
   congelado antes de Fase 1.
3. **Doble nomenclatura de variables** (prototipo vs producción): riesgo de
   importar CSS con variables inexistentes que caen en negro/inherit.
4. **Estilos inline (~108) y colores huérfanos**: no responden a un cambio de
   tokens; hay que barrerlos o aceptar la divergencia.
5. **Contratos de API dinámicos** (`/v1/${sport}/…` interpolados): ningún
   linter los valida; los tests mockean por ruta exacta. Un rename de ruta del
   Worker rompe la UI sin error de build. Los `/v1/qa/*` exigen sesión Google.
6. **Bilingüe ES/EN**: diccionario `T` (~l. 1730–2200) + `t()` + `data-i18n` /
   `data-i18n-html` / `data-i18n-ph` / `data-i18n-aria`. Todo texto nuevo en
   ambos idiomas; las entradas con HTML (`data-i18n-html`, p. ej. `how_html`,
   `foot`) rompen markup si se editan sin cuidado. Los tests de regresión
   detectan fugas ES↔EN.
7. **Honestidad no negociable**: widget "Juego responsable", `foot` del footer,
   diálogos `#howdlg`/`#legaldlg` y la caja de evidencia/gates deben quedar
   siempre visibles; un rediseño que los esconda viola el ADN.
8. **Gates cerrados por deporte**: Total/Jugadores/Combos MLB
   (`lockedMarketTab`), WNBA/NFL/NCAAF/NHL/NCAAM en sombra (`market_fact` ≠
   pick AA), Top 2 solo QA. Ninguna fase visual puede mostrar una probabilidad
   no publicada ni quitar el candado.
9. **Re-render completo por `innerHTML`** con estado global mutable: perder
   foco/scroll/selección al re-pintar es el bug típico (ya hay workaround en
   `renderRadarList` para el input de búsqueda). Animaciones GSAP/Flip y
   `prefers-reduced-motion` (`html.reduce-motion`) añaden superficie de
   regresión.
10. **Dependencia de imágenes externas** (ESPN CDN, mlbstatic) con `onerror`
    inline: en entornos sin red generan ruido; los tests ya filtran
    `ERR_TUNNEL_CONNECTION_FAILED` / `Failed to load resource`.
11. **Date guard de live** (`AA_MLB_LIVE_DATE_GUARD_V2`): las capturas y los
    tests dependen de la fecha ET real del día de ejecución; las fixtures deben
    generarse con la fecha ET de "hoy" o la vista live queda vacía.
12. **Sin tema claro** hoy: si una fase futura lo exige, hay que portar el
    sistema `data-theme=light` del prototipo completo (no hay base en prod).

## 5. Baseline visual

`tests/redesign_baseline_capture.mjs` (compañero de este doc) captura
`docs/redesign/baseline/` en 1440×900 / 390×844 / 360×800: home (Central AA),
detalle Central, lista MLB, detalle MLB, filtro en vivo, posiciones, WNBA y
soccer; reporta errores de consola y overflow por viewport. Ejecutar con:

```bash
NODE_PATH=pw-tools/node_modules PLAYWRIGHT_BROWSERS_PATH=pw-tools/browsers \
  node tests/redesign_baseline_capture.mjs
```
