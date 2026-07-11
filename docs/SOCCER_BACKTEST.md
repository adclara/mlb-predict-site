# AA Sports — Backtest del modelo de Soccer (Dixon-Coles + ancla de mercado)

**Datos:** 19,763 partidos (Premier, LaLiga, Serie A, Bundesliga, Ligue 1 × **11
temporadas 2015-16 → 2025-26**) de football-data.co.uk, con odds de cierre (B365 +
promedio de casas).
**Protocolo:** walk-forward estricto — para cada jornada el modelo se ajusta SOLO con
partidos anteriores (decaimiento temporal ξ=0.0065/día). 1 temporada de burn-in; la
primera temporada evaluada afina α (mezcla modelo↔mercado) y **queda fuera del test**;
se reporta sobre las ~9 temporadas restantes (**n=16,059** con mercado).

## Resultado principal (test, α congelado)

| Métrica | Blend AA | Mercado (des-vigado) | Gate |
|---|---|---|---|
| Brier (3 vías) | **0.5776** | 0.5759 | ✅ blend ≤ mercado + 0.002 |

**Hallazgo honesto (matiz nuevo con 11 temporadas):** en las tres grandes (Premier,
LaLiga, Serie A) α=0 — el Dixon-Coles no mejora las odds de cierre. Pero en **Bundesliga
(α=0.45)** y **Ligue 1 (α=0.25)** el modelo SÍ recibe peso en la mezcla: en ligas con
mercados algo menos afilados el DC aporta señal. El valor del motor sigue siendo:
(a) goles esperados y distribución de marcador, (b) totales, (c) cobertura sin odds,
y ahora (d) señal real en ligas secundarias.
⚠️ En producción pre-partido se usan odds tempranas/actuales (no de cierre), donde un
modelo puede aportar más — esto se está midiendo EN VIVO en modo sombra desde 2026-07-11.

## Donde SÍ ganamos: selección calibrada (el ADN de MLB)

Picks = resultado (local/visita) con mayor probabilidad del blend. Acierto real vs predicho:

| Tier | n picks | **Real** |
|---|---|---|
| ≥55% | 6,133 | **67.7%** |
| ≥60% | 4,386 | **72.5%** |
| ≥65% | 3,098 | **75.7%** |
| ≥70% | 1,978 | **77.4%** |

Por liga (tier ≥70%, real vs predicho): LaLiga 78.2/77.1 · Serie A 78.0/75.5 · Ligue 1
77.8/76.9 · Premier 77.2/77.3 · Bundesliga 75.6/78.3. Calibración por bins consistente
(predicho ≈ real; la muestra de 11 temporadas confirma lo visto con 6) — se puede
publicar probabilidad con confianza.

## ROI de "valor" vs cierre

Negativo en los umbrales probados (esperado con α≈0 en las ligas grandes). AA Sports
**no** venderá la narrativa de "ganarle al mercado de cierre"; vende probabilidades
honestas, tiers de confianza y contexto — el usuario decide.

## Veredicto y siguiente paso

- ✅ Gate de Brier: PASA (0.5776 vs mercado 0.5759 + 0.002 de margen).
- ✅ Calibración: PASA (predicho ≈ real en todos los tiers, ahora con n=16k).
- 🔶 **Modo sombra ACTIVO** desde 2026-07-11 (picks en D1 cada 3h con odds pre-partido
  de ESPN, grading automático). ~2 semanas de track record + revisión de Adrian antes
  de encender predicciones públicas.

Reproducir: `node robot/soccer_model.mjs backtest` (usa data/fase2/soccer; ~45s).
Salida completa: `data/fase2/soccer/soccer_backtest.json`.
