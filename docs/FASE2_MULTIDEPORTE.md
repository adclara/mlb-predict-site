# AA Sports — Fase 2+: NBA, Soccer y Tenis

> Principio innegociable: **marcadores en vivo se lanzan ya; predicciones solo cuando el
> modelo pase la validación** (walk-forward + intervalos de confianza), igual que MLB.
> No publicamos números que no estén medidos.

## Estado actual (lanzado)

- Worker: `/v1/nba/live`, `/v1/soccer/live?league=` (whitelist: fifa.world, uefa.champions,
  eng.1, esp.1, ita.1, ger.1, fra.1, usa.1, mex.1), `/v1/tennis/live` (ATP+WTA, sets por
  jugador). Mismo patrón proxy+caché (30-45s) que MLB.
- Frontend: tabs NBA/Soccer/Tenis activos con lista en vivo, detalle y la nota honesta
  "Modelo AA en entrenamiento". Selector de liga en soccer (Mundial 2026 por defecto).

## Fuentes de datos (todas gratis y estables)

| Deporte | En vivo | Histórico para entrenar/validar | Notas |
|---|---|---|---|
| Soccer | ESPN scoreboard por liga | **football-data.co.uk** (CSV: resultados + odds de cierre, 20+ años, ligas top) · football-data.org (API free-tier como respaldo) | El CSV trae odds históricas → se puede validar valor vs mercado desde el día 1 |
| NBA | ESPN scoreboard | **balldontlie.io** (juegos/temporadas completas, free) · stats.nba.com (respaldo) | Temporada arranca en octubre → ventana perfecta para validar sin presión |
| Tenis | ESPN scoreboard (ATP/WTA) | **github.com/JeffSackmann/tennis_atp y tennis_wta** (CSV de cada partido desde 1968: superficie, ranking, stats) | El estándar de oro académico; ideal para Elo por superficie |

Imágenes: ya resuelto en `cloudflare/lib/assets.mjs` (logos NBA/NFL, escudos y banderas de
soccer, caras de tenistas — CDNs oficiales, con fallback).

## Modelos (adapter por deporte, motor privado, mismo pipeline que MLB)

1. **Soccer** (primero — el Mundial da tráfico y los datos históricos traen odds):
   - Base: Elo por selección/club + ventaja local + descanso.
   - El empate obliga a 3 vías → **Dixon-Coles/Poisson bivariado** para marcador esperado
     y probabilidades 1X2 calibradas (Platt, como MLB).
   - Validación: walk-forward sobre 5+ temporadas de football-data.co.uk midiendo Brier y
     valor vs odds de cierre. Gate: no peor que el mercado + ganancia en selección.
2. **NBA** (validar en agosto-septiembre, lanzar con la temporada):
   - Elo + descanso/back-to-backs + home + ausencias (news). Total con pace.
   - Validación con 5 temporadas de balldontlie; mismos gates.
3. **Tenis** (tras soccer):
   - Elo por jugador **por superficie** + head-to-head + forma reciente.
   - Validación con tennis_atp/wta (10+ años).

## Pipeline (idéntico al de MLB — reusar)

```
robot/{sport}_daily.mjs (Actions cron) → normalize (esquema AA común) →
upload a KV ({sport}:today) + D1 (predictions con sport='nba'|'soccer'|'tennis') →
Worker /v1/{sport}/today → frontend (mismo componente; el tab ya existe)
```

El esquema D1 ya es multideporte (columna `sport`). El normalizador de MLB
(`cloudflare/lib/normalize.mjs`) sirve de plantilla para cada adapter.

## Checklist para "encender" predicciones de un deporte

- [ ] Backtest walk-forward reproducible con datos históricos (reporte con CI).
- [ ] Calibración verificada (curva de confiabilidad) + Brier ≤ mercado.
- [ ] 2+ semanas de picks en sombra (guardados en D1, no públicos) con grading correcto.
- [ ] Revisión de Adrian → se activa `{sport}:today` y el tab muestra predicciones.
