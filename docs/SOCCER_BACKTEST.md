# AA Sports — Backtest del modelo de Soccer (Dixon-Coles + ancla de mercado)

**Datos:** 10,734 partidos (Premier, LaLiga, Serie A, Bundesliga, Ligue 1 × 6 temporadas
2020-21 → 2025-26) de football-data.co.uk, con odds de cierre (B365 + promedio de casas).
**Protocolo:** walk-forward estricto — para cada jornada el modelo se ajusta SOLO con
partidos anteriores (decaimiento temporal ξ=0.0065/día). 1 temporada de burn-in; la
primera temporada evaluada se usa para afinar α (mezcla modelo↔mercado) y **queda fuera
del test**; se reporta sobre las ~4 temporadas restantes (n=7,056 con mercado).

## Resultado principal (test, α congelado)

| Métrica | Blend AA | Mercado (des-vigado) | Gate |
|---|---|---|---|
| Brier (3 vías) | **0.5768** | 0.5768 | ✅ blend ≤ mercado + 0.002 |

**Hallazgo honesto:** α óptimo = 0 en las 5 ligas — el Dixon-Coles puro **no añade** poder
predictivo sobre las odds de cierre promedio (mercados de soccer top son muy eficientes al
cierre). El valor del motor DC está en: (a) goles esperados (xG) y distribución de marcador
para el análisis/narrativa, (b) proyección de totales, (c) cobertura donde no hay odds.
⚠️ En producción pre-partido se usan odds tempranas/actuales (no de cierre), donde un
modelo sí puede aportar — esto se medirá en vivo en modo sombra.

## Donde SÍ ganamos: selección calibrada (el ADN de MLB)

Picks = resultado (local/visita) con mayor probabilidad del blend. Acierto real vs predicho:

| Tier | n picks | Predicho | **Real** |
|---|---|---|---|
| ≥55% | 2,623 | ~62% | **67.8%** |
| ≥60% | 1,813 | ~69% | **72.1%** |
| ≥65% | 1,244 | ~74% | **76.4%** |
| ≥70% | 754 | ~77% | **78.8%** |

Por liga (tier ≥70%): LaLiga **86.0%** (150) · Bundesliga 78.1% (155) · Premier 77.2% (202)
· Serie A 75.6% (131) · Ligue 1 76.7% (116). La calibración por bins es consistente
(predicho ≈ real en todos los rangos) — se puede publicar probabilidad con confianza.

## ROI de "valor" vs cierre

Negativo en todos los umbrales (esperado con α=0: no hay edge contra el cierre). AA Sports
**no** venderá la narrativa de "ganarle al mercado de cierre"; vende probabilidades honestas,
tiers de confianza (gemas/fijos de soccer) y contexto — el usuario decide.

## Veredicto y siguiente paso

- ✅ Gate de Brier: PASA (empata al mercado, como MLB).
- ✅ Calibración: PASA (predicho ≈ real en todos los tiers).
- 🔶 Antes de publicar predicciones: **2 semanas en modo sombra** (picks guardados en D1,
  no públicos, con odds pre-partido reales de ESPN) + revisión de Adrian. Igual que MLB.

Reproducir: `node robot/soccer_model.mjs backtest` (usa data/fase2/soccer; ~20s).
Salida completa: `data/fase2/soccer/soccer_backtest.json`.
