# Plan maestro — AA Sports como app de páginas + caras

**Producto:** jornada. Clic = **entrar**. Atrás = **pantalla anterior**. Nunca Google.  
**Repo:** `adclara/mlb-predict-site` · **sitio:** aasport.net  
**Caja:** 1 `index.html`, 0 framework, 0 build, $0, honestidad, ES/EN, 0 modelo en el cliente.  
**Studio** (`studio.html`) = 18 vistas demo. No se copia HTML ni números.

**Estado:** Fase A está en PR #279 (`feat/history-router`). Este documento es la fuente de verdad para B–E y el sistema de caras.

---

## 0. El bug de producto (desktop)

`.detail` es sticky a la derecha:

```css
.detail { position: sticky; top: 74px; max-height: calc(100vh - 90px); overflow-y: auto; }
```

El clic **no entra**: llena un panel chico. Hay **dos scrolls** (lista vs pane). En <900px el overlay no hace `pushState` → Back = Google.

**Regla única:** clic en partido / jugada / equipo / jugador = página completa, **un** scroll de documento. `#dback` y el Back del SO = `history.back()`.

---

## 1. Máquina de URL

`replaceState` al boot (no empujar Google). Cada navegación interna = `pushState`. `_aaFromPop` evita re-push.

| Param | Valores | Fase |
|---|---|---|
| `s` | home, radar, mlb, nba, wnba, nfl, ncaaf, nhl, ncaam, soccer, tennis | A (hecho) |
| `tab` | alias de `s` | A (hecho) |
| `g` | event MLB o id Central | A (hecho) |
| `sc` | event otro deporte | A (hecho) |
| `lt` | all, favs, pos, hist, brain, edu, tools, cfg | A parcial / B |
| `dt` | analisis, equipos, pitchers, bateadores, sim, mercado | C |
| `m` | winner, total, players, combos | C |
| `team` | BOS, LAL… | C |
| `p` | id jugador | C |
| `w` | wallet 0x… (pausado) | A (hecho) |

Pila: Google → home → lista MLB → **partido full** → pitchers → **ficha** → back → partido → back → lista → back → home → back → Google.

---

## 2. Layout

### LISTA (`g`/`sc`/`p`/`team` vacíos)

Rail + chips + lista + widgets desktop. Sin partido preseleccionado fingiendo panel.

### PÁGINA (`body.aa-page`) — Fase B

```css
body.aa-page #list,
body.aa-page .colside { display: none !important; }
body.aa-page .detail {
  position: static; max-height: none; overflow: visible; top: auto; width: 100%;
}
body.aa-page .dback { display: flex; } /* también 1440px */
```

Honesty + legal se copian al pie del dcard (ya existe `.lwarn` en móvil). Scroll de **página** (hero → mercados → roster → honesty) está bien. Scroll de cajón derecho, no.

---

## 3. Inventario de pantallas

| # | URL | UI | Datos (lógica intacta) |
|---|---|---|---|
| 0 | `s=home` | jornada | today/live |
| 1 | `s=mlb` | `.mrow` | today/live/injuries |
| 2 | `s=mlb&g=` | partido **full** | today + live WP |
| 3 | `+&dt=` | tabs snapshot | snapshot |
| 4 | `+&m=` | 4 mercados | gates **cerrados** |
| 5 | `+&p=` | ficha jugador | ids existentes |
| 6 | `s=mlb&team=` | club + roster del día | standings + snapshot |
| 7 | `lt=favs\|pos\|hist\|brain` | esas vistas | history/learning |
| 8 | `lt=edu\|tools\|cfg` | app | local |
| 9 | `s=nba` (etc.) | lista | live/recent/today |
| 10 | `s=nba&sc=` | partido full | summary athletes |
| 11 | `s=soccer` | ligas + lista | soccer:today público |
| 12 | `s=radar` | Central | intelligence |
| 13 | `s=radar&g=` | jugada Central full | market_fact vs AA |

---

## 4. Clics → historial

| Clic | push | Fase |
|---|---|---|
| `.mrow[data-id]` | `g=` o `sc=` | A hecho |
| `.intelrow` / `[data-rw]` | `g=` en radar | A hecho |
| `[data-oid]` | `sc=` | A hecho |
| chip `.sp` | `s=` (limpia objeto) | A hecho |
| `#dback` | `history.back()` si `state.aa` y `g=`/`sc=` | A hecho |
| `.ltab` / rail | `lt=` | B |
| `.dtab` | `dt=` | C |
| `.market-tab` | `m=` | C |
| pitcher / batter / `.lurow` | `p=` | C |
| standings team | `team=` | C |

Si no hay `state.aa`, `#dback` cierra overlay (no Google).

---

## 5. Sistema de caras (diseño completo)

### Principio

**No re-hospedamos fotos** (peso + derechos). CDNs oficiales keyless, igual que logos ESPN. Fallback monograma. Nunca I2I / IA de un atleta nombrado en producción (`docs/AA_SPORTS_STUDIO_SKILL.md`).

`cloudflare/lib/assets.mjs` **ya existe** y el HTML **no lo importa** (no hay bundler). Fase C: copiar el helper a `index.html` y ampliar el `.mjs` (fuente de verdad para tests).

### Catálogo CDN

| Liga | Función | Id | Hoy en prod |
|---|---|---|---|
| MLB | `img.mlbstatic.com/.../people/{id}/headshot/silo/current` y `midfield.mlbstatic.com/v1/people/{id}/spots/{120\|240}` | MLBAM person id | `siloFace` / `officialFace` en hero, jornada, lineup |
| NBA | `cdn.nba.com/headshots/nba/latest/260x190/{id}.png` | NBA id | **no cableado** |
| NFL | `a.espncdn.com/i/headshots/nfl/players/full/{id}.png` | ESPN athlete id | live `.lvhs` si viene `headshot.href` |
| Tenis | `.../headshots/tennis/players/full/{id}.png` | ESPN id | no cableado en lista |
| WNBA | `.../headshots/wnba/players/full/{id}.png` | ESPN id | **falta en assets.mjs** |
| NHL | `.../headshots/nhl/players/full/{id}.png` | ESPN id | falta |
| NCAAF | `.../headshots/college-football/players/full/{id}.png` | ESPN id | falta |
| NCAAM | `.../headshots/mens-college-basketball/players/full/{id}.png` | ESPN id | falta |
| Soccer | escudo `teamlogos/soccer/500/{teamId}.png`; cara **solo** si `headshot.href` | ESPN | no inventar cara |

Helper único en HTML:

```js
function aaFace(sport, id, name, href, cls) {
  // 1) href oficial del worker si es http(s) del CDN conocido
  // 2) si no, URL del catálogo por sport+id
  // 3) si no id: <span class="hsfall">iniciales</span>
  // onerror → monograma. loading=lazy. caption photo_official
}
```

Nunca construir URL sin id. Nunca usar un id de otra liga.

### De dónde salen los ids (ya en el Worker)

| Fuente | Campos | Dónde se pintan |
|---|---|---|
| MLB today `snapshot.pitchers.*.id` | MLBAM | hero silo, cards abridores |
| MLB lineup / bats | id + name | `.lurow` `.luhs` (parcial) |
| `/v1/mlb/live` situation athlete | `headshot.href` ESPN (no MLBAM) | `.lvhs` |
| `/v1/{sport}/summary` `players.*.groups[].rows[]` | `id`, `name`, `headshot`, `starter`, `stats` (máx 12) | **casi no se usa en UI** — Fase C los enseña |
| `/v1/{sport}/live` leaders | `headshot` truncado 300 chars | poco |

**Alcance honesto:** caras de **quien aparece en el partido cargado** (abridores, lineup, box, lesiones, leaders). No es un álbum de “todos los jugadores de la franquicia 2026” hasta C2.

### Dónde se ven (UI)

1. **Lista:** logo de equipo (ya). Opcional: dos silos mini en `.mrow` si hay ids de abridores — no bloquear C.
2. **Hero partido:** dos portraits laterales (MLB ya). Otros deportes: logo grande + caras de leaders si hay href.
3. **Tab Pitchers / Bateadores:** cada fila = cara + nombre + stats publicados. Clic → `p=`.
4. **Box / summary otros deportes:** grupos passing/rushing/… con cara.
5. **Ficha `p=`:** cara grande, caption oficial, ERA/FIP/box/lesión **si vino en JSON**. Sin número inventado.
6. **`team=`:** logos + roster **del partido de hoy** contra ese club (ids del snapshot/summary).
7. **Lesiones:** cara si hay id.

### C2 (Worker, opcional, no fingir)

Endpoint tipo `/v1/{sport}/roster?team=` solo si summary no trae ids. Cron que no cueste. Hasta que exista: iniciales. **No** scrapers, **no** zip de miles de JPG en el repo.

### Copy ES/EN (Fase C)

`photo_official` / `photo_missing` / `back_to_match` / `back_to_list` en `T`.

### Tests C

Pitcher con id → `img[src*="mlbstatic"]` o `espncdn` o `nba.com`.  
Sin id → `.hsfall`, **cero** `src` inventado.

---

## 5. Motion (D)

180–220ms `translateX(10px)` + opacity; View Transitions si hay. GSAP Flip lista (ya). Hero `rotateY` ≤ 3°. Un scroll de documento. `#aaReduce` + `prefers-reduced-motion` = 0. Prohibido Three.js / canvas 3D / Lottie extra.

## 6. Anti-vibe (E)

Menos aurora `body::before`, menos emoji de adorno, hit 44px, Manrope/Barlow (no Inter/Linear).

## 7. ADN — no se toca

`prob_v2`, gates Total/Jugadores/Combos, Central `market_fact`, date guard live, robots, `studio.html` como producción. Worker solo en C2.

---

## 8. PRs

| PR | Rama | Hecho | Prueba |
|---|---|---|---|
| **A** | `feat/history-router` | **PR #279** Router + Back | 390+1440 `goBack` origin |
| **B** | `feat/match-page` | `body.aa-page` mata panel derecho | 1440: clic entra; Back lista |
| **C** | `feat/player-visuals` | helper + roster + `p=` + `team=` | cara o fallback |
| **C2** | `feat/summary-ids` | Worker roster si falta id | |
| **D** | `feat/motion-views` | transiciones | 360 sin jank |
| **E** | `feat/shell-density` | densidad | |

Cada PR: Playwright 1440/390/360, 0 errores, 0 overflow. **Sin poke** hasta merge aprobado.

## 9. Hecho cuando

En **1440px**, clic en partido = solo el partido (no panel derecho). Scroll = página. Atrás = lista. Igual en 390. Jugadores con cara oficial o iniciales. Gates y % idénticos.
