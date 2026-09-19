# Plan maestro v2 — AA Sports como app de páginas

**Producto:** jornada deportiva. Clic en un objeto = **entrar en su página**. Atrás = **volver a la pantalla anterior de AA Sports**. Un partido nunca se comporta como un cajón lateral.
**Repo:** `adclara/mlb-predict-site` · **sitio:** `aasport.net`
**Caja técnica:** un `cloudflare/pages/index.html`, sin framework ni build, $0, modelo solo server-side, honestidad, ES/EN.
**Studio:** `studio.html` orienta la intención visual; no se copian su HTML, sus datos ni sus números.

**Estado:** la Fase A vive en PR #279 (`feat/history-router`). Este documento es la fuente de verdad para endurecer A y ejecutar B–E.

---

## 0. Decisión de producto

AA Sports tiene dos superficies distintas; no deben mezclarse:

1. **Jornada = Explore / Monitor.** El usuario escanea qué ocurre hoy y elige un partido.
2. **Partido, equipo o jugador = Inspect.** El usuario estudia un solo objeto con contexto, evidencia y límites.

La pantalla actual intenta mostrar ambas a la vez en desktop. Ese es el problema de composición principal; no se arregla con más color, cards ni animación.

### Preguntas que la interfaz debe responder

**En la jornada, en menos de 5 segundos:**

- ¿Qué partidos hay y en qué estado están?
- ¿Cuál tiene lectura AA pública y cuál no?
- ¿Qué puedo abrir?

**Dentro del partido, en menos de 10 segundos:**

- ¿Quién juega, cuándo y cuál es el estado?
- ¿Qué estima AA exactamente?
- ¿Qué está medido, qué está cerrado y qué no se sabe?
- ¿Por qué aparece esa lectura?
- ¿Cómo vuelvo al punto exacto de la lista?

### Principios no negociables

- **Una ruta, una tarea dominante.** Lista y detalle no compiten en la misma vista.
- **Un solo scroll de documento.** Sin scroll interno de `.detail`.
- **La información decide la jerarquía.** Espaciado, tipografía y separadores antes que cards, blur o sombras.
- **Honestidad contextual.** El límite aparece junto al número al que afecta; el aviso legal completo queda al final.
- **Sin duplicación persuasiva.** Un mismo 74.4% no necesita aparecer en ticker, destacada, señal, hero, gráfico y widget simultáneamente.
- **Sin datos de relleno.** Loading, vacío, stale, invalidado y gate cerrado son estados diseñados, no huecos a esconder.
- **La imagen mejora reconocimiento; nunca sustituye datos.** Cara oficial o monograma, nada inventado.

---

## 1. Auditoría de la experiencia actual

Auditoría combinada UX + accesibilidad sobre producción a 1440×1024 y 390×844, contrastada con `index.html`, `DESIGN.md`, `tokens.md` y los tests de la rama.

### Lo que ya funciona

- Identidad visual propia: Manrope + Barlow Condensed, night-blue, sky/volt y hairlines.
- Probabilidad, rival, hora y estado se reconocen con rapidez dentro del detalle.
- Los gates cerrados, la falta de locks y el “sin ventaja positiva medida” no se maquillan.
- El sistema ya contempla vacío, pending, invalidado, stale y fallback de assets.
- La navegación móvil y los controles principales existen en una sola app sin framework.

### Problemas estructurales

1. **Desktop sigue siendo master-detail.** `.layout` reserva `400px + detail + 308px`; `.detail` es sticky y tiene scroll propio.
2. **La jornada no prioriza partidos.** Header, ticker, deportes, tabs, filtros, intro, Central y destacada desplazan las filas reales bajo el fold.
3. **Hay demasiadas navegaciones simultáneas.** Rail, header, ticker, deportes, tabs de lista, filtros, tabs de detalle y mercados.
4. **La ubicación activa puede ser ambigua.** Home, Partidos, Baseball/MLB y “Todos” compiten por explicar dónde está el usuario.
5. **Se repiten probabilidad y rendimiento global.** La repetición aumenta ruido y puede parecer persuasiva.
6. **El detalle mezcla lectura del partido con widgets globales.** Rendimiento, gemas, locks y juego responsable restan ancho al objeto principal.
7. **En móvil la bottom-nav puede cubrir contenido.** Una página de objeto no debe terminar detrás de un elemento fijo.
8. **Tipografía secundaria y controles compactos rozan el mínimo legible/táctil.** Hay captions de 9–11px y targets visuales menores de 44px.
9. **El idioma activo debe coincidir con toda la interfaz.** “ES” no puede convivir con chrome parcialmente en inglés.
10. **El token de botón primario no cumple contraste en la spec actual.** `designmd lint` mide `#f2f5fc` sobre `#4da8ff` en **2.30:1**; la app ya dispone de `--on-sky: #04121f`, que debe reconciliarse con `DESIGN.md` en D.

### Brechas técnicas detectadas en el plan v1

- Ocultar `#list` no basta: `#list` son solo las filas. Debe ocultarse `#listpane`/`.listpane` y cambiarse la grid de `.layout`; si no, queda una columna vacía de 400px.
- `loadToday()` aún preselecciona una gema/fijo/primer juego cuando la URL no tiene `g=`. La ruta de lista debe mantener `selectedId = null`.
- El boot actual prioriza `s=` y puede ignorar `g=` en una entrada directa `?s=mlb&g=…`. Falta una prueba de deep link + recarga.
- Marcar el estado de boot con `{aa:1}` no demuestra que la entrada anterior sea interna. En un deep link desde Google, `history.back()` todavía puede salir del sitio.
- `dt=` y `m=` son estados dentro de la misma página, no páginas nuevas. Si hacen `pushState`, el botón Atrás queda atrapado recorriendo tabs.

---

## 2. Alcance y no-alcance

### En alcance

- Router robusto, deep links y restauración de contexto.
- Jornada sin detalle preseleccionado.
- Página full de partido, jugada Central, jugador y equipo.
- Jerarquía de información y reducción de chrome duplicado.
- Caras oficiales, fallback, rendimiento y accesibilidad.
- Motion que explique continuidad.

### Fuera de alcance

- Reescribir la app en React/Vue o dividir el HTML.
- Cambiar `prob_v2`, gates, robots, fórmulas o scopes de publicación.
- Copiar Studio o clonar otra marca.
- Tema claro.
- Rediseñar Inicio, Central, Historial, Cerebro, Educación, Herramientas o Config: se congelan funcionalmente; solo reciben el contrato común de ruta, activo único, header y Back cuando corresponda.
- Three.js, canvas 3D o nuevas dependencias.
- Roster de temporada completo antes de C2.
- Imágenes generadas de atletas nombrados.

---

## 3. Contrato de rutas

### Parámetros canónicos

| Parámetro | Valores | Significado |
|---|---|---|
| `s` | home, radar, mlb, nba, wnba, nfl, ncaaf, nhl, ncaam, soccer, tennis | sección/deporte |
| `tab` | alias de entrada; al escribir se normaliza a `s` | compatibilidad |
| `g` | event MLB o id de Central | objeto partido/jugada |
| `sc` | event de otro deporte | objeto partido |
| `date` | `YYYY-MM-DD` en fecha ET | jornada compartible/recargable distinta de hoy |
| `lt` | all, favs, pos, hist, brain, edu, tools, cfg | vista de lista/app |
| `dt` | analisis, equipos, pitchers, bateadores, sim, mercado | vista interna del partido |
| `m` | winner, total, players, combos | mercado dentro del partido |
| `team` | id/código válido para ese deporte | página de club |
| `p` | id válido para ese deporte | página de jugador |
| `w` | wallet `0x…` | legado pausado |

### Parser, normalización y escritura

`aaReadRoute()` y `aaBuildSearch()` pasan a ser funciones puras sobre un objeto de ruta validado; no serializan desde `selectedId`, `otherSel` ni otro estado mutable. El boot procesa el objeto completo **antes** de `setSport()`, por lo que `?s=mlb&g=id` y `?g=id` conservan el objeto.

Una única operación `navigateToObject(route)`:

1. guarda la entrada actual como padre;
2. cambia el estado interno sin escribir historial;
3. hace exactamente un `pushState`.

Entrar en una sección/lista elimina ids incompatibles (`g`, `sc`, `p`, `team`, `dt`, `m`). Cambiar de deporte nunca conserva un id del anterior.

### Resolución de página

Prioridad de render:

1. `p` → ficha contextual de jugador; requiere `s` + `g`/`sc` hasta que exista endpoint propio.
2. `team` → página contextual de equipo; conserva `g`/`sc` si nació desde un partido.
3. `g` o `sc` → página de partido/jugada.
4. Sin objeto → lista o vista `lt`.

`g` y `sc` son mutuamente excluyentes. `p` y `team` también. Un id inválido nunca se “corrige”, se usa en otra liga ni cae silenciosamente al primer juego. Si una ficha no alcanza un contrato mínimo —nombre, contexto y al menos un bloque factual— el nombre no se convierte en enlace.

Combinaciones inválidas se canonicalizan eliminando parámetros residuales o muestran 404 contextual. Un `g` histórico se resuelve con `date=` o `/v1/mlb/event/:id`; no depende del documento de hoy.

### Matriz canónica y activo único

| Pantalla | URL | Activo global | Activo local |
|---|---|---|---|
| Inicio | `?s=home` | Inicio | ninguno |
| Central | `?s=radar` | Central | lista |
| Jugada Central | `?s=radar&g=id` | Central | objeto |
| Jornada MLB | `?s=mlb[&date=…][&lt=…]` | Partidos | MLB + vista |
| Partido MLB | `?s=mlb&g=id[&date=…][&dt=…][&m=…]` | Partidos | objeto |
| Jornada otro deporte | `?s=nba|…` | Partidos | deporte |
| Partido otro deporte | `?s=nba|…&sc=id[&m=…]` | Partidos | objeto |
| App local | `?s=mlb&lt=edu|tools|cfg` | destino del rail | vista |

Deportes son filtros/contexto de Partidos, no una segunda navegación global equivalente. Solo un destino del rail puede llevar `aria-current="page"`.

### Push vs replace

| Acción | History API | Motivo |
|---|---|---|
| Entrar en deporte/sección o cambiar `lt` | `pushState` | cambia de página principal |
| Cambiar `date` | `pushState` | cambia la jornada compartible |
| Entrar en partido/jugada | `pushState` | cambia de objeto |
| Entrar en jugador/equipo | `pushState` | cambia de objeto |
| Cambiar `dt` o `m` | `replaceState` | cambia una vista dentro de la misma página |
| Cambiar filtro, query o favorito | sin entrada nueva | estado efímero o acción local |
| Normalizar `tab` → `s` | `replaceState` | URL canónica sin paso extra en Back |
| Boot de una lista | `replaceState` | no añade un paso artificial |

### Deep link sin salida accidental

Decisión deliberada de producto: **el primer Back desde un objeto siempre ofrece su padre dentro de AA Sports**, incluso si el objeto llegó por enlace externo. El segundo Back puede volver al origen. Esto prima la promesa “nunca Google desde el partido” sobre el comportamiento web convencional y debe probarse con usuarios.

Un objeto abierto directamente necesita un padre interno aunque el usuario venga de un buscador:

1. Leer y validar la URL original.
2. Si es una ruta de objeto y `history.state` no demuestra navegación interna:
   - `replaceState` con su lista padre canónica;
   - `pushState` con el objeto original.
3. Si la página se recarga y el estado ya es interno, no duplicar el padre.
4. `#dback` usa `history.back()` cuando existe ese padre; si falta por cualquier razón, hace fallback a la lista con `replaceState`.

Resultado: abrir un enlace compartido, pulsar Back del SO o `#dback` lleva primero a la lista de AA Sports, no al sitio externo.

### Estado que no necesita ensuciar la URL

Antes de entrar en un objeto, actualizar la entrada de lista con:

```js
{
  aa: 1,
  kind: 'list',
  key,
  route,
  scrollY,
  focusKey,
  filter,
  query,
  listTab,
  viewDate
}
```

La entrada de objeto usa `{ aa:1, kind:'object', key, parentKey, route }`. `popstate` consume `event.state` mediante `aaApplyRoute(route, state)`; `{aa:1}` a secas no es prueba suficiente de padre. Se activa `history.scrollRestoration = 'manual'`.

Al entrar en objeto: `scrollTo(0, 0)` sin animación, render, y foco al encabezado contextual con `tabindex="-1"`. Al volver: restaurar estado/datos, renderizar, esperar dos `requestAnimationFrame`, enfocar la fila con `preventScroll` y restaurar `scrollY`. Si la fila ya no existe, enfocar el encabezado de resultados y anunciar el cambio.

### Matriz mínima de navegación

`Google → lista MLB → partido → jugador → Back partido → Back lista restaurada → Back Google`

`enlace directo a partido → lista sintética → partido → Back lista → Back origen`

`lista → partido → Pitchers (`replace`) → Mercado (`replace`) → Back lista`

---

## 4. Shell de página

### 4.1 Ruta de lista: `body.aa-list`

La jornada es una sola columna operativa. No mantiene un sidebar fijo de 308px: rendimiento, gemas, locks y legal aparecen después de los partidos o en Historial. Así la tarea principal recibe todo el ancho.

```css
body.aa-list .layout {
  grid-template-columns: minmax(0, 1fr);
  max-width: 1040px;
}
body.aa-list #detail { display: none; }
body.aa-list #listpane { min-width: 0; }
body.aa-list .colside { display: none; }
```

**Orden desktop:**

1. Header global compacto.
2. Navegación de deportes con un único activo inequívoco.
3. Título de jornada + fecha + filtros.
4. Lista real de partidos.
5. Resumen secundario compacto y widgets no vacíos.
6. Honestidad/legal.

**Reglas:**

- Sin partido autoseleccionado cuando no hay `g`/`sc`.
- En 1440×900 se ven título, fecha, filtros y **al menos tres filas completas** sin scroll cuando existen tres eventos.
- “Featured matchup” no duplica la primera fila en Partidos. Puede vivir en Inicio, no en la lista operativa.
- No hay una segunda lista “Top signals”. Si se destaca algo, la fila explica un criterio verificable como “mayor probabilidad modelada” o “ventaja medida”; nunca presenta probabilidad alta como valor esperado.
- “Fijo” se retira del copy público por comunicar certeza. El dato/slug puede conservarse por compatibilidad, pero la UI usa estados medidos.
- Filtros con conteos consistentes: `Todos 15 · En vivo 0 · Finales 0 · Por jugar 15`.
- Cada fila es un contenedor con un `<a>` real al partido y un `<button>` hermano para favorito; no hay controles interactivos anidados. Ambos tienen target ≥44px, foco propio y nombre accesible.

### 4.2 Ruta de objeto: `body.aa-page`

```css
body.aa-page .layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  max-width: 1220px;
}
body.aa-page #listpane,
body.aa-page .colside { display: none !important; }
body.aa-page .detail {
  display: block;
  position: static;
  inset: auto;
  width: 100%;
  max-height: none;
  overflow: visible;
  padding: 0;
}
body.aa-page .dback { display: inline-flex; min-height: 44px; }
```

**No usar `body.style.overflow = 'hidden'` en páginas de objeto.** Eso pertenecía al overlay.

En móvil:

- `.detail` sigue siendo estático; no `position: fixed`.
- La bottom-nav fija se oculta en `aa-page` para no tapar contenido, pero el header conserva un acceso global compacto y el final de página ofrece navegación a Inicio/Partidos/Historial/Config.
- `#dback` forma parte de una barra contextual compacta; puede ser sticky, pero el contenido sigue usando el scroll del documento.
- `.detail` reserva `padding-bottom: calc(24px + env(safe-area-inset-bottom))`.

En desktop se mantiene el rail global; ticker y barra de deportes se reducen u ocultan en la página de objeto si repiten contexto. El partido debe empezar arriba, no después de tres franjas de navegación.

“Un solo scroll” significa **ningún scroll vertical dentro del contenido principal**. Rail global y diálogos pueden conservar su propio scroll por ser superficies independientes; `.evbox` y cualquier bloque factual del partido pierden `max-height`/`overflow-y:auto`.

---

## 5. Arquitectura de la página de partido

No es un “hero + cards”. La composición Inspect es:

- encabezado factual del objeto;
- un único bloque decisional con estimación, fuente, hora y límite;
- comparaciones en filas/tabla alineadas;
- capítulos de evidencia con ancho de lectura controlado;
- máximo tres entradas primarias (`Resumen`, `Participantes`, `Evidencia`); los mercados son anclas/selector dentro de Resumen y las vistas especializadas usan navegación secundaria.

`DESIGN.md` se actualiza en B2 para distinguir **Jornada/Monitor** de **Objeto/Inspect** antes de implementar estilos de detalle.

### Orden de lectura

1. **Barra contextual:** Atrás a Partidos · liga · compartir.
2. **Hero factual:** visitante, local, fecha/hora/estado, marcador si existe.
3. **Lectura AA:** probabilidad publicada, fuente (`prob_v2`/live), timestamp y estado.
4. **Límite junto al número:** diferencia vs mercado, cobertura, invalidado/pending o “sin ventaja positiva medida”.
5. **Mercados:** Ganador público; Total/Jugadores/Combos muestran gate y evidencia disponible, nunca una cifra bloqueada.
6. **Por qué:** razones y contexto medidos.
7. **Equipos / pitchers / bateadores / box:** contenido factual disponible.
8. **Lesiones y disponibilidad.**
9. **Honestidad + metodología + legal** al pie del partido.

### Encabezado factual

- Los nombres, marcador/estado y disponibilidad son más importantes que el retrato.
- La probabilidad exacta aparece **una sola vez**: `74,4 %` en ES y `74.4%` en EN. Una barra puede representarla sin repetir otro número y con equivalente textual accesible.
- No mostrar caption de foto si no se pintó una foto.
- Si abridor o atleta está por confirmar, renderizar solo la variante activa: “Por confirmar” en ES o “TBD” en EN; no usar `?`.
- “Gema”, “Fijo” y “Take” no sustituyen “equipo más probable” ni “ventaja medida”.

### Tres estados del partido

- **Prepartido:** hora, sede/disponibilidad, estimación y límite.
- **En vivo:** marcador, inning/periodo y actualización; toda cifra dice explícitamente “prepartido” o “en vivo”.
- **Final:** resultado primero; la estimación queda archivada con timestamp y nunca parece una lectura vigente.

### Navegación interna

- Máximo tres entradas primarias. En móvil se prefieren anclas con `aria-current` si el contenido puede convivir en el documento; no se obliga a descubrir seis tabs mediante scroll horizontal oculto.
- Si una vista sigue siendo tab: `tablist`, `tab`, `tabpanel`, `aria-controls`, `aria-selected`, roving `tabindex`, Flechas, Home/End y política de activación explícita.
- Cambiar vista conserva la posición del navegador local y usa `replaceState`.
- La selección no depende solo del color: texto + subrayado/borde + semántica.
- Mercados es un selector dentro de Resumen, no otro tablist con la misma jerarquía visual.

### Honestidad sin repetición

- **Local:** cada cifra lleva scope, timestamp y límite relevante.
- **Global:** una caja compacta al final enlaza metodología y términos.
- No repetir el récord global del algoritmo dentro del hero del partido; puede permanecer en Historial o en un widget de la lista.

---

## 6. Jugador y equipo

### Ficha `p=`

- Mientras no exista endpoint propio, solo se abre como `s + g/sc + p`; un `p` aislado devuelve al contexto disponible o 404 contextual.
- Back vuelve al partido y vista de origen; si no hay padre válido, vuelve a la lista del deporte.
- Retrato secundario de tamaño estable o monograma; no desplaza disponibilidad ni stats.
- Nombre, equipo, posición/rol y estado factual.
- Stats solo si llegaron en el JSON del partido/summary.
- Lesión y disponibilidad solo con fuente presente.
- Sin biografía inventada, sin proyecciones nuevas y sin mezclar ids entre ligas.

### Club `team=`

- Mientras no exista endpoint propio, conserva `s + g/sc + team` y Back vuelve al partido; si es entrada directa, el padre canónico es la lista del deporte.
- Escudo, nombre y contexto de temporada disponible.
- Próximo/actual partido y roster **del evento cargado**.
- Posiciones/forma solo si ya existen en endpoints públicos.
- Copy explícito: “Jugadores disponibles en este partido”, no “Plantilla 2026” hasta C2.

---

## 7. Sistema de caras oficiales

### Principio

No se re-hospedan retratos. Se usan CDNs oficiales/keyless con allowlist estricta. Sin id o ante error: monograma estable. Nunca IA de una persona nombrada.

`cloudflare/lib/assets.mjs` es la fuente verificable para tests. Como `index.html` no lo importa, el helper equivalente se copia de forma controlada y se mantiene sincronizado.

### Catálogo

| Liga | Fuente | Id |
|---|---|---|
| MLB | `img.mlbstatic.com` / `midfield.mlbstatic.com` | MLBAM person id |
| NBA | `cdn.nba.com/headshots/nba/latest/260x190/{id}.png` | NBA id |
| NFL | ESPN `headshots/nfl/players/full/{id}.png` | ESPN athlete id |
| Tenis | ESPN `headshots/tennis/players/full/{id}.png` | ESPN id |
| WNBA | ESPN `headshots/wnba/players/full/{id}.png` | ESPN id |
| NHL | ESPN `headshots/nhl/players/full/{id}.png` | ESPN id |
| NCAAF | ESPN `headshots/college-football/players/full/{id}.png` | ESPN id |
| NCAAM | ESPN `headshots/mens-college-basketball/players/full/{id}.png` | ESPN id |
| Soccer | escudo; cara solo con `headshot.href` oficial | ESPN |

### Helper

```js
function aaFace({ sport, id, name, href, size = 'row', priority = false }) {
  // 1. aceptar href solo si es https y el host está permitido para sport
  // 2. si no, construir URL solo con sport + id válido
  // 3. si no hay fuente válida, devolver monograma
  // 4. reservar width/height para evitar CLS
  // 5. onerror reemplaza una sola vez por monograma
}
```

Atributos:

- `decoding="async"`.
- `loading="lazy"` en filas; hero visible usa `eager`/`fetchpriority="high"`.
- `referrerpolicy="no-referrer"` cuando el CDN lo tolere.
- Nombre visible junto a la imagen; en filas densas el `img` puede llevar `alt=""` para no duplicar al lector de pantalla.
- Caption localizado visible en hero/ficha, una vez por bloque y solo si la fuente exige atribución; no debajo de cada avatar de 40px.

### Jerarquía de uso

1. Hero/ficha de jugador.
2. Lineup, pitchers y box/summary.
3. Lesiones y líderes.
4. Equipo del partido.
5. Lista de jornada solo si no reduce legibilidad; no bloquea C.

### Alcance honesto

Se muestran atletas presentes en el partido cargado. “Todos los jugadores de todos los equipos” requiere C2 y un endpoint de roster. Hasta entonces no se finge.

---

## 8. Estados de datos

Cada página debe cubrir:

| Estado | Tratamiento |
|---|---|
| loading | skeleton `aria-hidden`, contenedor `aria-busy` y `role=status` compacto; dimensiones estables |
| vacío | explicar qué falta y qué sí puede hacer el usuario |
| error | mensaje enfocable + Reintentar; conservar snapshot válido si aplica |
| offline/stale | edad del dato visible; ocultar precios/bundles que ya no son actuales |
| pending | no mostrar probabilidad como definitiva |
| invalidado | retirar el número afectado y explicar el cambio de abridor/dato |
| gate cerrado | candado + criterio/muestra si está publicado; sin CTA engañoso |
| id/foto ausente | monograma; nunca URL inventada |
| objeto no encontrado | página 404 contextual con Back a la lista, no panel vacío |

La actualización automática no debe resetear vista, foco, scroll ni página actual. Mientras una fila tenga foco, hover o una acción en curso, no se reordena: se actualizan valores in situ y se ofrece “Hay actualizaciones” para aplicar un nuevo orden de forma explícita. Los marcadores relevantes usan un anuncio `polite` compacto, nunca el detalle completo.

---

## 9. Sistema visual y densidad

Se conserva `docs/redesign/DESIGN.md`:

- Manrope para UI; Barlow Condensed para marcador, porcentaje y labels cortos.
- `--sky` es interacción; `--volt`, `--amber` y `--red` son semánticos, no decoración.
- Texto sobre `--sky` usa `--on-sky`/`#04121f`; D corrige `DESIGN.md` y deja el lint sin warnings de contraste.
- Hairlines y cambios de luminancia antes que cards dentro de cards.
- Radio solo donde agrupa un objeto real.
- Sin indigo genérico, sin nueva paleta y sin copiar Linear/Vercel.

### Ajustes de densidad

- Body funcional: 14–16px.
- Metadata: mínimo 12px; evitar captions críticos de 9px.
- Targets: mínimo 44×44px en móvil y acciones de icono.
- Texto largo: máximo aproximado de 65 caracteres por línea.
- Una acción primaria por bloque.
- El estado vacío de Locks no ocupa una card completa.
- Emojis decorativos salen de títulos de navegación; iconos solo si aceleran escaneo.

### Diagnóstico anti-vibe

La deuda principal es **wrong surface**: el partido sigue dentro de un layout Monitor. También hay exceso de glass/cards y repetición de métricas. La solución es recomponer la página, no recolorear el mismo master-detail.

---

## 10. Motion

Motion explica continuidad; no simula un cajón.

- Entrada de página: 160–220ms, opacity + `translateY(4–8px)`; no `translateX` lateral.
- Back: transición inversa corta y restauración instantánea de la lista.
- Si View Transitions está disponible, conectar fila → hero con logo/nombre, sin bloquear navegación.
- GSAP/Flip solo para reordenar filas existentes; no añadir librerías.
- Eliminar `rotateY` del hero: no aporta orientación ni estado.
- `#aaReduce` y `prefers-reduced-motion: reduce` dejan duración efectiva en 0.
- Ninguna animación retrasa foco, Back o lectura del estado live.

---

## 11. Accesibilidad y contenido bilingüe

### Requisitos

- `.layout` se convierte en `<main>` o queda dentro de uno; `main`, `nav`, `header` y headings tienen orden lógico y cada `nav` un label distinto.
- Al entrar en una página, actualizar `document.title` y enfocar el `h1`/encabezado contextual con `preventScroll`.
- Al volver, foco a la fila de origen.
- No usar `aria-live` sobre todo el detalle; anunciar solo estado compacto/cambios live relevantes.
- Tabs con roles y teclas Flecha izquierda/derecha; Enter/Espacio en filas y controles.
- Foco visible con contraste 3:1.
- Contraste de texto normal 4.5:1; componentes/gráficos 3:1.
- Reflow a 320 CSS px y zoom de texto al 200% sin pérdida de contenido ni scroll horizontal de página.
- Gestos horizontales tienen alternativa por botones/foco.
- Logos decorativos con `alt=""`; nombres de equipo siempre en texto.
- Todo copy nuevo vive en `T.es` y `T.en`; nunca se muestran ambas variantes a la vez.
- `Intl.NumberFormat` localiza decimales/porcentajes y `Intl.DateTimeFormat` localiza fecha/hora con zona ET cuando sea ambigua.
- Cambiar idioma actualiza `html[lang]`, `document.title`, placeholders y nombres accesibles; los tests comprueban expansión de texto además de claves.

### Microcopy preferido

- “AA estima 74.4% para LAD” / “AA estimates 74.4% for LAD”.
- “Equipo más probable”, no “Toma Dodgers”, cuando no hay valor medido.
- “Gate cerrado: aún no se publica”, no una pestaña que parece premium.
- “Abridor por confirmar”, no un símbolo `?` aislado.
- “Foto oficial”, solo cuando hay imagen real.

---

## 12. Entrega por PR

| PR | Rama | Alcance | No mezclar | Prueba de salida |
|---|---|---|---|---|
| **A** | `feat/history-router` · #279 | Router actual + parser puro, deep link, padre sintético, `date/dt/m`, sin autoselección | layout/caras | direct URL, Back y Forward en 1440/390/360 |
| **B1** | `feat/match-page` | `aa-list`/`aa-page`, grid correcta, un scroll, fila/enlace válido, foco base | nuevo contenido visual | clic = solo partido; Back restaura lista |
| **B2** | `feat/match-hierarchy` | composición Inspect, pre/live/final, `DESIGN.md`, copy y honestidad contextual | caras masivas | comprensión + gates + teclado/reflow |
| **C** | `feat/player-visuals` | helper, allowlist, hero/lineup/box/lesiones, `p=` y `team=` contextuales | endpoint roster | cara oficial o monograma |
| **C2** | `feat/summary-ids` | roster/ids faltantes en Worker si es necesario | rediseño visual | contrato API + cache $0 |
| **D** | `feat/shell-density` | tipografía mínima, targets, quitar duplicación/emoji/glass, contraste de tokens | lógica del modelo | WCAG visual + densidad |
| **E** | `feat/motion-views` | View Transitions/GSAP sobrio + reduced motion | cambios estructurales | motion último, 360 sin jank ni foco perdido |

No hacer poke-deploy hasta aprobación/merge. Cada PR debe poder revertirse sin arrastrar el siguiente.

---

## 13. Tests obligatorios

### Router

Separar test de router (estado/URL) de test de presentación B1 (clases/estilos); el test de A no exige `.detail.open` ni llama overlay al detalle.

- Lista sin objeto no selecciona ni renderiza partido.
- `?s=mlb&g=g1` y `?g=g1` sobreviven boot/recarga.
- Click desde Inicio hace **un solo push** y añade `s=mlb&g=`; cambiar deporte limpia ids viejos.
- Click MLB, otro deporte y Central usa respectivamente `.mrow[data-id]`, `.mrow[data-oid]` y `[data-rw]`.
- Deep link abre detalle después de cargar datos; id inválido no cae al primer evento.
- Recargar el detalle no duplica entradas.
- Primer Back de SO y `#dback` vuelven a la lista AA; el segundo puede volver al origen externo.
- Forward reabre el mismo objeto/vista.
- `dt`/`m` usan replace; `lt`/`date` usan push.
- Player/equipo → Back conserva partido y vista de origen.
- Lista recupera scroll, filtro, fecha y foco.

### Layout

En 1440×900, 390×844, 360×800 y reflow a 320 CSS px:

- `aa-list`: `#detail`/`.colside` no ocupan columnas; lista usa el ancho disponible y muestra tres filas si existen.
- `aa-page`: `#listpane` y `.colside` no se ven; `.layout` tiene una columna.
- `.detail` es `position: static`, `overflow: visible` y sin `max-height`.
- Ningún bloque del contenido principal tiene scroll vertical propio; rail y diálogos son excepciones explícitas.
- Sin overflow horizontal.
- Bottom-nav no tapa el último elemento y existe alternativa global.
- Back visible y con target ≥44px.

### Datos y caras

- Id permitido → URL del CDN correcto para ese deporte.
- `href` en host no permitido → se rechaza y usa catálogo/fallback.
- Sin id → `.hsfall`, sin `src` inventado.
- Error de imagen → monograma, sin loop de requests.
- Caption empieza oculto, aparece solo en `load` real y vuelve a ocultarse en `error`.
- Pending/invalidado/gate cerrado no filtran probabilidad prohibida.

### Accesibilidad e idioma

- Recorrido por teclado: fila → detalle → tabs → Back.
- Foco visible y restaurado.
- Tabs anuncian selección.
- ES y EN sin fugas en todo copy nuevo.
- Reduced motion aplica una clase real al documento (`body.aa-reduce-motion`) y deja duración computada en `0ms`.
- Reflow a 320 CSS px y zoom de texto al 200% sin pérdida de acción o contenido.
- Axe sin violaciones críticas/serias nuevas y recorrido manual con NVDA de Jornada → partido → Back.

### Comprensión de producto

Prueba guerrilla con al menos tres personas y cuatro tareas sin ayuda:

1. encontrar un partido en vivo;
2. distinguir “probabilidad modelada” de “ventaja medida”;
3. explicar por qué un mercado tiene gate cerrado;
4. volver a la misma fila de la jornada.

B2 no cierra si una etiqueta o jerarquía induce una respuesta sistemáticamente equivocada.

### Regresión

- `node --check` de scripts tocados.
- Suite Playwright desktop + 390 + 360.
- 0 errores de consola de la app.
- Regresión MLB y gates idénticos.
- Capturas de lista, detalle, deep link, invalidado, gate cerrado, jugador con foto y fallback.

---

## 14. Definición de hecho

La iniciativa está terminada cuando:

- En 1440, un clic en un partido muestra **solo la página del partido** dentro del shell global; no hay lista ni rail de widgets compitiendo.
- En 390/360 ocurre lo mismo sin overlay fijo ni contenido bajo la bottom-nav.
- Hay un único scroll de documento.
- Back vuelve a la lista exacta —mismo deporte, fecha, filtro, posición y foco— y un deep link nunca expulsa al usuario antes de ofrecer esa lista.
- Los tabs son compartibles sin convertir cada clic en un obstáculo para Back.
- La lectura AA, su scope, timestamp y límite se entienden antes de hacer scroll profundo.
- Las caras son oficiales o monogramas, con ids correctos por liga y sin URLs inventadas.
- Todo nuevo texto existe en ES/EN.
- Probabilidades, gates, scopes y robots permanecen idénticos.
- Los tests pasan en 1440/390/360 con 0 errores de consola y 0 overflow horizontal.
