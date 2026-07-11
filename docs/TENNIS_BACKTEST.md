# AA Sports — Backtest del modelo de Tenis (Elo por jugador + superficie)

**Datos:** ATP 48,720 + WTA 53,724 partidos completos (2016 → 2026-07), ESPN scoreboard
por fecha (jugadores, sets, torneo; incluye qualies y challengers que ESPN lista).
**Protocolo:** walk-forward estricto — cada partido se predice ANTES de actualizar. Para
evitar fuga por orientación (el ganador siempre viene primero en los datos), cada partido
se re-orienta alfabéticamente. Elo general + Elo por superficie (inferida del nombre del
torneo; default hard) con K decreciente por experiencia. La mezcla superficie↔general (wS)
y el **shrink de calibración** p' = σ(a·logit(p)) se eligen SOLO en el burn-in 2016→2019
y quedan congelados: ATP wS=0.25, a=0.70 · WTA wS=0.5, a=0.80.

## Resultado principal (evaluación 2020 → 2026-07, prob calibrada)

| Tour | n eval | Brier | Brier crudo | Azar | Acierto | Con experiencia (≥10 partidos ambos) |
|---|---|---|---|---|---|---|
| ATP | 33,331 | **0.2201** | 0.2207 | 0.25 | 63.9% | n=27,470 · Brier 0.2188 · 64.1% |
| WTA | 38,880 | **0.2209** | 0.2214 | 0.25 | 63.7% | n=31,555 · Brier 0.2191 · 64.3% |

Estable los 7 años evaluados (ATP 0.216-0.223; WTA 0.214-0.224).

## ⚠️ Sin comparación vs mercado (honestidad primero)

Los datos de ESPN **no traen odds** de tenis, así que este backtest valida calibración y
acierto por tier — NO demuestra ventaja sobre las casas. El estándar aquí es más débil
que el de MLB/soccer; antes de publicar predicciones de tenis se exigirá **modo sombra
con odds vivas** y, si aparece una fuente histórica de odds, re-validación completa.

## Selección calibrada (prob con shrink; partidos con ambos jugadores rodados)

| Tier | ATP n / pred / **real** | WTA n / pred / **real** |
|---|---|---|
| 55-60% | 6,070 / 57.5% / **58.1%** | 6,585 / 57.5% / **57.8%** |
| 60-65% | 5,084 / 62.4% / **63.5%** | 5,659 / 62.4% / **63.6%** |
| 65-70% | 3,914 / 67.4% / **70.1%** | 4,441 / 67.4% / **67.8%** |
| ≥70% | 5,809 / 76.8% / **80.7%** | 7,737 / 77.5% / **79.0%** |

La versión CRUDA del modelo sobreestimaba 2-4 pts en todos los tiers; con el shrink
(ajustado solo en burn-in) la calibración queda **predicho ≈ real o conservadora**
(real ≥ predicho en los tiers altos — la dirección segura para publicar) y el Brier
también mejora. La sobreconfianza quedó corregida.

## Veredicto y siguiente paso

- ✅ Señal real y estable: Brier ~0.220 vs 0.25 de azar, ~64% de acierto.
- ✅ Calibración: PASA con el shrink congelado (predicho ≈ real; tiers altos conservadores;
  ≥70% acierta 79-81%).
- ⛔ Gate de mercado: **pendiente** — no hay odds históricas; se decide en modo sombra
  con odds vivas + revisión de Adrian. Tenis es la última fase del roadmap (Fase 4).

Reproducir: `node robot/tennis_model.mjs backtest` (usa data/fase2/tennis; ~1 min).
Salida completa: `data/fase2/tennis/tennis_backtest.json`.
