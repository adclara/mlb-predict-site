# AA Sports — Backtest del modelo de NBA (Elo + margen de victoria)

**Datos:** 12,870 juegos finales (regular + playoffs) de 10 temporadas 2016-17 → 2025-26,
ESPN scoreboard por fecha, con marcador por cuartos, récords al momento y sede neutral.
**Protocolo:** walk-forward estricto — cada juego se predice ANTES de actualizar los
ratings. Hiperparámetros (K, ventaja local, arrastre entre temporadas, castigo
back-to-back) elegidos SOLO con las 2 temporadas de burn-in (2016-17, 2017-18) y
congelados; se evalúan las 8 restantes (**n=10,246**).

Grid del burn-in → K=15, HFA=70 pts Elo, carry 0.75, back-to-back −30.

## Resultado principal (test, parámetros congelados)

| Métrica | Elo AA | Baseline "siempre el local" |
|---|---|---|
| Brier | **0.2182** | 0.2473 |
| Log-loss | 0.6258 | — |
| Acierto | **64.8%** | ~57% |

Estable por temporada (peor: 2020-21 COVID 0.229 / 60.8%; mejor: 2025-26 0.209 / 67.3%).

## ⚠️ Sin comparación vs mercado (honestidad primero)

El scoreboard histórico de ESPN **no conserva odds** (spread/total vienen `null` en las
10 temporadas). Este backtest valida **calibración y acierto por tier**, no que le
ganemos al mercado. Antes de publicar predicciones de NBA el modelo pasará por **modo
sombra con odds vivas** (mismo protocolo que soccer), que sí registra el spread del día.

## Selección calibrada (tiers sobre la prob del lado elegido)

| Tier | n | Predicho | **Real** |
|---|---|---|---|
| 55-60% | 1,788 | 57.5% | 56.5% |
| 60-65% | 1,770 | 62.4% | 61.8% |
| 65-70% | 1,476 | 67.4% | **67.4%** |
| ≥70% | 3,432 | 78.0% | **76.3%** |

Calibración por bins consistente en todo el rango (desvío típico 1-3 pts, ligera
sobreconfianza en 0.4-0.6). Publicable como probabilidad honesta con tiers.

## Veredicto y siguiente paso

- ✅ Supera con claridad al baseline y es estable 8 temporadas (incluye COVID).
- ✅ Calibración: PASA (predicho ≈ real por tier).
- 🔶 Gate de mercado: **modo sombra DESPLEGADO** (`robot/nba_shadow.mjs`, cada 6h) —
  guarda prob del modelo + prob del mercado (odds vivas devigadas, `market_prob` en D1)
  por pick. Fuera de temporada no registra nada; los picks reales arrancan solos con la
  2026-27 en octubre. Revisión de Adrian antes de publicar.

Reproducir: `node robot/nba_model.mjs backtest` (usa data/fase2/nba; ~10s).
Salida completa: `data/fase2/nba/nba_backtest.json`.
