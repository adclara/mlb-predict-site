# AA Sports — Backtest del modelo de Tenis (Elo por jugador + superficie)

**Datos:** ATP 48,720 + WTA 53,724 partidos completos (2016 → 2026-07), ESPN scoreboard
por fecha (jugadores, sets, torneo; incluye qualies y challengers que ESPN lista).
**Protocolo:** walk-forward estricto — cada partido se predice ANTES de actualizar. Para
evitar fuga por orientación (el ganador siempre viene primero en los datos), cada partido
se re-orienta alfabéticamente. Elo general + Elo por superficie (inferida del nombre del
torneo; default hard) con K decreciente por experiencia; la mezcla superficie↔general (wS)
se elige SOLO en el burn-in 2016→2019 y queda congelada: ATP wS=0.25, WTA wS=0.5.

## Resultado principal (evaluación 2020 → 2026-07)

| Tour | n eval | Brier | Azar | Acierto | Con experiencia (≥10 partidos ambos) |
|---|---|---|---|---|---|
| ATP | 33,331 | **0.2207** | 0.25 | 63.9% | n=27,470 · Brier 0.2193 · 64.1% |
| WTA | 38,880 | **0.2214** | 0.25 | 63.7% | n=31,555 · Brier 0.2196 · 64.3% |

Estable los 7 años evaluados (ATP 0.217-0.223; WTA 0.215-0.225).

## ⚠️ Sin comparación vs mercado (honestidad primero)

Los datos de ESPN **no traen odds** de tenis, así que este backtest valida calibración y
acierto por tier — NO demuestra ventaja sobre las casas. El estándar aquí es más débil
que el de MLB/soccer; antes de publicar predicciones de tenis se exigirá **modo sombra
con odds vivas** y, si aparece una fuente histórica de odds, re-validación completa.

## Selección calibrada (partidos con ambos jugadores rodados)

| Tier | ATP n / real | WTA n / real |
|---|---|---|
| 55-60% (pred 57.5%) | 4,447 / 53.9% | 5,418 / 55.7% |
| 60-65% (pred 62.5%) | 4,293 / 59.7% | 5,058 / 60.8% |
| 65-70% (pred 67.4%) | 3,811 / 64.3% | 4,423 / 65.5% |
| ≥70% (pred ~79%) | 10,247 / **75.8%** | 10,916 / **75.9%** |

Lectura honesta: hay **sobreconfianza de ~2-4 pts** en todos los tiers (real < predicho),
más marcada que en NBA/soccer. Si esto se publica, la probabilidad mostrada debe pasar por
una corrección de calibración (shrink hacia 0.5) — pendiente de implementar y re-medir
antes de cualquier lanzamiento.

## Veredicto y siguiente paso

- ✅ Señal real y estable: Brier ~0.220 vs 0.25 de azar, ~64% de acierto, ≥70% acierta ~76%.
- 🔶 Calibración: PASA con reservas — sobreconfianza sistemática de 2-4 pts que exige
  shrink antes de publicar.
- ⛔ Gate de mercado: **pendiente** — no hay odds históricas; se decide en modo sombra
  con odds vivas + revisión de Adrian. Tenis es la última fase del roadmap (Fase 4).

Reproducir: `node robot/tennis_model.mjs backtest` (usa data/fase2/tennis; ~1 min).
Salida completa: `data/fase2/tennis/tennis_backtest.json`.
