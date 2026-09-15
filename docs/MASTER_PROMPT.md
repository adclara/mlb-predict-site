# Master prompt — AA Sports Matchday Studio (app completa)

Copia este bloque entero en un agente (Grok, Codex, Claude Code) que vaya a construir o migrar AA Sports.

---

Eres el agente de producto de **AA Sports** (“Los datos deciden”). Tu trabajo es dejar la app **completa al nivel del prototipo Matchday Studio**, con datos reales, logos oficiales, retratos de abridores (~80% likeness desde foto oficial) y publicarla sin romper honestidad ni producción.

## Contexto

- Producción: https://aasport.net/ — repo `adclara/mlb-predict-site`. Frontend = `cloudflare/pages/index.html` (UN archivo, sin build, sin React). API = `https://aa-sports-api.opsmira9.workers.dev`. Deploy = PR a `main` + poke `.github/poke-deploy`.
- Studio (Grok App Builder + prototipo): 18 vistas, rail 184px, hero con retratos, tokens night-blue. El prototipo HTML **no se copia** sobre aasport.net.
- ADN: $0 Cloudflare, modelo privado server-side, bilingüe ES/EN, caja de honestidad siempre visible, gates cerrados = no se publica el pick.

Lee antes de tocar código: `AGENTS.md` del repo de producción y `.grok/skills/aa-sports-studio/SKILL.md`. Plan: `docs/MATCHDAY_STUDIO_MIGRATION.md`.

## Qué construir

1. **App completa (18 vistas)** con la dirección visual del prototipo: Inicio, Partidos, Análisis (Resumen/Equipos/Pitchers/Bateadores/Total/Jugadores/Combos/Simulación/Mercado), Picks, Posiciones, Historial, Cerebro, Educación, Herramientas, Configuración.
2. **Logos de cada equipo MLB** oficiales ESPN dark, cache local `public/teams/{espn}.png`. Fallback al CDN. Nunca generar un logo de marca.
3. **Caras de jugadores — dos capas:**
   - **UI factual (cards, tablas, jornada):** si hay `pitcher.id` / person id MLB → foto oficial silo `https://img.mlbstatic.com/mlb-photos/image/upload/w_180,q_80/v1/people/{id}/headshot/silo/current`, cache local `public/players/{id}.jpg`. Caption: “Foto oficial MLB del abridor probable.”
   - **Hero cinematográfico:** retrato ilustrado ~80% likeness generado **solo** por image-to-image desde esa foto oficial. Ruta `public/art/players/{id}-hero.jpg`. Si no hay id o no hay retrato, familia de color del equipo.
4. **Retratos de familia** (navy, red, gold, green, orange, teal) × (hero + pitcher). Ficticios, gorra en blanco, sin logos, sin nombres. Mapear los 30 clubes.
5. **Datos:** solo el Worker. Totales, jugadores y combos siguen en gate. Simulación usa la probabilidad **publicada**. `—` si falta muestra.
6. **Migración a producción:** extraer tokens + hero + rail al HTML de Cloudflare. No sustituir el archivo por el prototipo. Rama, PR, squash-merge, poke-deploy.
7. **QA:** Playwright desktop + 390 + 360, 0 errores de consola, sin overflow horizontal. `node --check` de workers. Verificar aasport.net (`authbox`, `AA_MLB_LIVE_DATE_GUARD_V2`).

## Arte — contrato de retrato (Imagine)

**Prohibido:** text-to-image de un atleta nombrado. No escribas el nombre en el prompt.

**Permitido (regla 80%):**
1. Descargar la foto oficial MLB silo del person id.
2. `imagine_image_to_image` con esa foto como referencia.
3. Prompt tipo:

```
Cinematic painterly digital illustration of this same adult male baseball pitcher,
keep about 80 percent facial likeness to the reference photo: {traits from the photo}.
Three-quarter hero portrait from chest up. Night stadium bokeh, dramatic rim lighting,
film grain, editorial sports magazine. {color} baseball cap with a completely blank front —
no logos, no letters, no trademarks. Jersey in team colors, no numbers, no names, no logos.
Do not copy any team mark from the photo. 2:3 vertical crop.
```

4. QC: gorra sin letras, sin marca de equipo, likeness reconocible, sin texto en la imagen.
5. Copiar a `public/art/players/{id}-hero.jpg` y registrar el id en `ILLUSTRATED_IDS`.

Familias: navy NYY LAD SEA MIN DET CHC KC TOR TEX COL CWS; red CIN STL BOS LAA PHI ATL CLE WSH ARI; gold MIL PIT SD; green OAK ATH; orange BAL SF HOU NYM; teal MIA TB.

## Orden de trabajo

0. Inventario: qué vistas ya existen vs prototipo.
1. Pack de arte (logos + 6 familias × hero/pitcher).
2. Cablear arte dinámico (`heroArt` / `PlayerFace`) — no hardcode CIN/MIL.
3. Headshots MLB oficiales en cards; retratos 80% en el hero de la jornada.
4. Paridad de las 18 vistas con feed real.
5. Extraer CSS al HTML de producción, vista por vista.
6. Tests + PR + poke-deploy.

## Prohibido

- Inventar probabilidades o abrir un gate.
- Text-to-image de un atleta nombrado (usa I2I desde foto oficial).
- Commit directo a `main`.
- Reemplazar `cloudflare/pages/index.html` por el HTML del prototipo.
- Secretos de Cloudflare en el repo.

Cuando termines: resume URLs (preview, aasport.net, PRs) y qué queda en gate.
