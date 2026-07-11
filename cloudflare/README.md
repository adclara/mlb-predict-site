# AA Sports — capa Cloudflare (Fase 1, MLB)

API pública de solo-lectura + uploader que privatiza el cómputo. El algoritmo
vive en el robot (server-side); aquí SOLO se sirven resultados ya calculados.

```
robot (data/history/*)  --upload.mjs-->  KV (mlb:today) + D1 (predictions)
                                                │
                                       worker/index.js  (API pública, caché)
                                                │
                                     frontend AA Sports  (solo consume la API)
```

## Recursos ya creados (cuenta opsmira9)
- **D1** `aa-sports` — `database_id: ed0969d8-050a-4987-ab98-b047c30f76c9`
- **KV** `AA_LATEST` — `id: 683aa2f8846643bf8a6a8b606e5bf0b7`
- Tablas D1: `predictions`, `runs` (ver esquema aplicado).

## Deploy del Worker
Desde esta carpeta (`cloudflare/`), con `wrangler` logueado:

```bash
wrangler deploy
```

Devuelve una URL tipo `https://aa-sports-api.<tu-subdominio>.workers.dev`.

## Subir los datos del día
```bash
node upload.mjs            # día más reciente en data/history/games/
node upload.mjs 2026-07-07 # un día específico
node upload.mjs --dry-run  # solo genera dist/, no sube
```

Sube `mlb:today` a KV y las filas a D1. En D1 pedirá confirmar (`y`).

## Probar la API
```bash
curl https://aa-sports-api.<sub>.workers.dev/v1/mlb/today | head -c 800
curl https://aa-sports-api.<sub>.workers.dev/v1/mlb/live  | head -c 800
```

## Rutas
| Ruta | Qué devuelve | Caché |
|---|---|---|
| `/v1/mlb/today` | predicciones + métricas + resumen del día | 60s |
| `/v1/mlb/event/:id` | un evento | 60s |
| `/v1/mlb/history?days=N` | historial (D1) | 120s |
| `/v1/mlb/live` | marcadores en vivo (proxy ESPN) | 30s |

## Esquema del evento (común multideporte)
```jsonc
{
  "sport": "mlb", "league": "MLB", "event_id": "822881",
  "matchup": "LAA @ TEX", "status": "pre|live|final",
  "home": {"code":"TEX"}, "away": {"code":"LAA"},
  "prediction": {"pick":"TEX","prob":0.751,"prob_pct":75.1,"confidence":"alta","engine_version":"v2"},
  "metrics": [ {"label":"Prob. modelo","value":"75.2%"}, ... ],
  "summary_es": "TEX llega con mejor momentum · ...",
  "risk": {"level":"medio","score":51},
  "badges": ["fijo","oro"],
  "live": null
}
```

## Siguiente (Paso C — automatizar)
Añadir un paso al workflow del robot que corra `node cloudflare/upload.mjs` tras
generar los datos, usando `CLOUDFLARE_API_TOKEN` (secret de GitHub) en vez del
OAuth local. Así se actualiza solo cada ~30 min.
