# Tokens de diseño — AA Sports (Fase 1 del rediseño)

> Capa de variables CSS de `cloudflare/pages/index.html` (`:root`, marcador
> `AA_TOKENS_V2`). **Fase 1 = cero cambio visible**: cada token tiene exactamente
> el valor que ya se renderizaba. Los canales `*-rgb` se consumen como
> `rgba(var(--x-rgb), α)`. Documento generado en la rama `redesign/fase-1-tokens`.

## Cómo leer esto

- **Canónicos**: la paleta Matchday Studio ya migrada (PR #256–#263). Nombres
  preexistentes respetados (`--page`, `--panel`, `--hair`, `--sky`, `--volt`…).
- **Legacy**: colores del diseño anterior que siguen renderizándose igual. Se
  tokenizaron con su valor exacto para que el CSS ya no tenga hex/rgba sueltos;
  **unificarlos con el canónico equivalente es un cambio visual** y corresponde
  a una fase posterior, con capturas baseline para medirlo.
- Los valores dentro de las definiciones de token (p. ej. los stops de `--grad`)
  son la única zona del archivo donde viven hex crudos, aparte de los assets
  (ver "Quedan fuera").

## Color — fondos y superficies

| Token | Valor | Uso |
|---|---|---|
| `--page` (+`--page-rgb`) | `#060c15` | fondo global, overlay de detalle móvil, gradiente del header |
| `--panel` | `#0b1624e6` | superficie vidrio (chips, inputs, menús) |
| `--panel-2` / `--inner` | `#101f30` / `#101f30d9` | superficie elevada / interior |
| `--card-hi` / `--card-lo` | `#0c1929` / `#091421` | gradiente de tarjetas (5 usos cada uno) |
| `--rail-hi` / `--rail-lo` (+`--rail-lo-rgb`) | `#0b1522` / `#080f1a` | gradiente del rail y del header |
| `--rail-on-hi` / `--rail-on-lo` / `--rail-on-text` | `#123361` / `#102143` / `#e9f4ff` | estado activo del rail |
| `--panel-fb` | `#12161f` | fallback de `var(--panel,…)` en diálogos/menús (nunca se aplica; `--panel` siempre existe) |
| `--toast-bg` | `#151a24` | `#polytoast` |
| `--ink` | `#0b0e14` | texto oscuro sobre avatar degradado |
| `--veil` (+`--veil-rgb`) | `#04060a` | backdrop de los diálogos |
| `--hero-glow-a` / `--hero-glow-b` | `#6d182940` / `#1a528240` | brillos radiales del hero del detalle |
| `--hero-a` / `--hero-b` / `--hero-c` | `#180e1c` / `#070e18` / `#0b1a2d` | gradiente base del hero |

## Color — bordes y texto

| Token | Valor | Uso |
|---|---|---|
| `--hair` / `--hair-2` | `#21354c` / `#2d4a68` | bordes base |
| `--line-active` | `#1d4471` | borde activo/hover (rail, jornada, ghostbtn) |
| `--text` / `--dim` / `--faint` | `#f2f5fc` / `#a0b0c6` / `#7d91aa` | jerarquía de texto |
| `--on-accent` | `#fff` | texto sobre acento azul |
| `--on-volt` / `--on-sky` | `#07120f` / `#04121f` | texto oscuro sobre chips verde/azul |

## Color — acentos canónicos y semánticos

| Token | Valor | Uso |
|---|---|---|
| `--blaze` / `--sky` | `#4da8ff` | acento azul (duplicado histórico intencional) |
| `--volt` | `#32dfb4` | verde acierto |
| `--amber` | `#f8c657` | dorado ORO |
| `--red` | `#ff6277` | rojo derrota / live |
| `--sky-rgb` / `--volt-rgb` / `--amber-rgb` / `--red-rgb` | canales | tintes `rgba(var(--x-rgb),α)` |
| `--ok` / `--warn` / `--err` / `--info` | alias de volt/amber/red/sky | capa semántica para fases siguientes (aún sin usos directos) |
| `--grad` | gradiente `#94d3ff→#1c87e9→#32dfb4` | marca AA |
| `--glass` | `blur(16px) saturate(140%)` | vidrio del header |
| `--white-rgb` / `--black-rgb` | `255,255,255` / `0,0,0` | tintes y sombras |

## Color — paleta legacy (mismo render, pendiente de unificar)

| Token | Valor | Dónde vive hoy | Canónico cercano |
|---|---|---|---|
| `--honey` (+rgb, `--honey-hi` `#f8e7b0`, `--honey-pale` `#fff3ce`) | `#ffc53d` | banner/badge QA, tints ámbar viejos (~31 usos) | `--amber` `#f8c657` |
| `--coral` (+rgb) | `#ff4655` | tints rojos viejos (~22 usos) | `--red` `#ff6277` |
| `--mint` (+rgb) | `#19de9f` | tints verdes viejos (~31 usos, incl. `.warnchip` inline) | `--volt` `#32dfb4` |
| `--steel` (+rgb) | `#5ea8ff` | tints azules viejos (~15 usos) | `--sky` `#4da8ff` |
| `--sky-soft` (+rgb) | `#5eb4ff` | `.batchip.cold` | `--sky` |
| `--royal` (+rgb) | `#3b82f6` | bundles multideporte, scope `market_fact` | `--info` |
| `--tang` (+rgb) | `#f59e0b` | `.radarwarn`, `.ffilter.on`, `.pfbtn.on`, `.tracklive` | `--warn` |
| `--rose` (+rgb) | `#ef4444` | forma reciente (derrota) | `--err` |
| `--lime` (+rgb) | `#4ade80` | `.tbadge.antes` | `--ok` |
| `--cyan` (+rgb) | `#38bdf8` | `.tbadge.vivo` | `--info` |
| `--slate` (+rgb, `--slate-hi` `#cbd5e1`) | `#94a3b8` | `.tag.plata` | `--faint` |
| `--orange` | `#ff7a3d` | `.dots.a i.on` | — |
| `--scroll` | `#2a3342` | scrollbars (3 usos) | `--hair-2` |

## Tipografía

| Token | Valor | Uso |
|---|---|---|
| `--font-ui` | Manrope + system stack | `body` |
| `--font-display` | `"Barlow Condensed",Manrope,sans-serif` | wordmark, marcadores, %, headings, métricas (8 usos sustituidos) |

Tamaños/pesos/line-heights siguen literales en el CSS (escala pendiente de
definir cuando una fase futura toque tipografía; hoy hay ~30 tamaños distintos
y forzarlos sería un cambio visual disfrazado).

## Espaciado (escala de referencia)

`--sp-1:4px` … `--sp-8:48px` (4/8/12/16/20/24/32/48). Definida para las fases
siguientes: **no se aplicó** a los paddings/margins existentes porque el CSS
actual usa decenas de valores fuera de escala (13px, 15px, 26px…) y mapearlos
cambiaría el render.

## Radios (aplicada)

Escala numérica según los valores reales en uso — **177 sustituciones**:
`--r-2` `--r-3` `--r-4` `--r-5` `--r-6` `--r-8` `--r-9` `--r-10` `--r-11`
`--r-12` `--r-13` `--r-14` `--r-16` `--r-18` `--r-20` `--r-pill:999px`.
Quedan literales: `border-radius:50%` (círculos) y compuestos
(`border-radius:Xpx Ypx 0 0`).

## Sombras

| Token | Valor | Uso |
|---|---|---|
| `--shadow` | inset hairline + `--shadow-sm` + `0 14px 48px #0003` | tarjetas (preexistente) |
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,.35)` | componente de `--shadow` |
| `--shadow-md` | `0 8px 30px rgba(0,0,0,.45)` | `#polytoast` |
| `--shadow-lg` | `0 16px 40px rgba(0,0,0,.5)` | `.authmenu` |
| `--shadow-xl` | `0 30px 80px rgba(0,0,0,.6)` | `.howcard` (diálogos) |

Dos sombras compuestas sueltas (`.mrow`, l. ~572 y ~1298) conservan sus valores
con canales `--white-rgb`/`--black-rgb`; candidatas a entrar en la escala.

## z-index (aplicada)

`--z-header:90` · `--z-rail:120` · `--z-detail:200` · `--z-menu:300` ·
`--z-toast:400`. Los valores locales `0/1/2/3/-1` (apilado interno de
componentes) quedan literales a propósito.

## Quedan fuera (con justificación)

| Valor | Dónde | Por qué |
|---|---|---|
| `#94d3ff` `#4da8ff` `#32dfb4` `#1c87e9` `#0b1624` | SVG del logo/marca (l. ~1470, ~1500) y favicon | color intrínseco del asset; los atributos de presentación SVG no resuelven `var()` |
| `#9AA4B5` | icono SVG de búsqueda | ídem (asset) |
| `#FFC53D` | estrella SVG inline (l. ~3753) | ídem (asset) |
| `rgba(255,255,255,.12/.18/.35)`, `rgba(50,223,180,.35/0)`, `#32dfb4` | gráficas SVG pintadas desde JS (unidades, win-prob en vivo; l. ~3364, ~3777–3784) | JS que pinta gráficas; los atributos SVG no resuelven `var()` — **pendiente**: pasar estos colores a CSS (clases) en una fase futura |
| `#a78bfa` | `CAT_HUE` del Radar legacy (l. ~4925+), JS | bloque pausado (`RADAR_PAUSED`); además pinta un donut SVG por atributos — **pendiente** con la poda del Radar legacy |
| `theme-color #060c15` | `<meta>` del head | no es CSS; ya coincide con `--page` |

## Añadidos en Fase 2 (shell + Inicio)

**Ningún token nuevo.** La vista Inicio (`.homecentral`, `.homehero`,
`.homeactions`) y la bottom-nav móvil (`.aa-bottomnav`) se construyeron
íntegramente con la capa AA_TOKENS_V2 (`--card-hi/lo`, `--line-active`,
`--sky-rgb`, `--volt-rgb`, `--font-display`, `--r-8/16`, `--z-header`,
`--glass`, `--panel`, `--hair`, `--dim`, `--sky`). Si una fase futura necesita
un valor nuevo, se añade aquí primero.

## Añadidos en Fase 3 (tarjeta de partido y mercados)

**Ningún token nuevo.** La superficie de mercados (`.market-first`,
`.market-tab`, `.prob-viz`, `.market-callout`, `.gate-card`) ya existía y usa la
capa AA_TOKENS_V2. Fase 3 consolidó el detalle MLB (fuera las pestañas
redundantes Total/Jugadores/Combos: esos gates viven en el selector del
comparador) y llevó la misma superficie a soccer (Ganador público AA + tres
gates cerrados sin muestra, porque la API no publica su progreso). CSS: se
eliminan las reglas muertas `.dtab.locked`; no se añadió ninguna.

## Verificación

`tests/redesign_baseline_capture.mjs` tras la migración: **0 errores de consola,
sin overflow horizontal** en desktop 1440×900, 390×844 y 360×800 (24 capturas).
Comparación visual contra las capturas de Fase 0 (`/tmp/baseline-fase0`):
`home-desktop`, `mlb-list-desktop`, `home-390` y `mlb-detail-390` idénticas a
ojo (las diferencias de bytes son solo los textos con hora del fixture:
"Actualizado 18:02" → "18:28"). 12 de 24 PNG salieron byte-idénticos.
