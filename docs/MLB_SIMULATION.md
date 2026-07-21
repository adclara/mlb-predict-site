# 🔬 Simulación MLB — walk-forward (2026-03-25 → 2026-07-04)

Entrenamiento y validación **out-of-sample**: cada día se entrena solo con el
pasado y se predice ese día. Datos: **1332 juegos** en 116 días.

## 1 · Precisión probabilística OOS (n=1224)
| modelo | acierto | log-loss | Brier |
|---|---|---|---|
| clásico | 53.9% | 0.723 | 0.263 |
| aprendido | 53.1% | 0.697 | 0.252 |
| combinado | 53.2% | 0.696 | 0.251 |

Δ log-loss (combinado − clásico): **-0.028** IC95% [-0.044, -0.012] — el aprendizaje **ayuda** (mejora la probabilidad).

## 2 · Calibración
ECE **3.8%** — razonable

## 3 · Backtest de selección (OOS)
El acierto se mide sobre toda la cohorte. Unidades y ROI solo aparecen cuando la
fila conserva el precio moneyline pregame real de ambos lados; no se supone −110.

| umbral confianza | picks | acierto | con precio real | unidades | ROI real |
|---|---|---|---|---|---|
| ≥53% | 827 | 53.6% | 0/827 | — | — |
| ≥55% | 611 | 52.5% | 0/611 | — | — |
| ≥58% | 327 | 52.9% | 0/327 | — | — |
| ≥60% | 206 | 53.4% | 0/206 | — | — |
| ≥62% | 130 | 55.4% | 0/130 | — | — |
| ≥65% | 58 | 58.6% | 0/58 | — | — |

La franja de mayor acierto medida fue ≥65%: 58.6% sobre 58 juegos. Esto describe acierto, no rentabilidad; sin precios auditables suficientes no se afirma ventaja apostable.

## 4 · Modelo vs mercado
Sin una cohorte auditable modelo-vs-mercado.

## 5 · Laboratorio de nuevos mercados (NO publicados)
Corte cronológico 70/30: **2026-06-04**. Se eligen como máximo dos candidatos por
día; no se rellenan cupos. Over se evalúa contra la línea O/U disponible; F5 es
equipo arriba al terminar cinco entradas (empate = push), no victoria del pitcher.

| mercado sombra | train | test histórico | IC95% test | forward real | gate |
|---|---:|---:|---:|---:|---|
| over | 71-60 (54.2%) | 34-27 (55.7%) | 43.3%–67.5% | n=0 | NO: sin línea y juice pregame auditables |
| f5 | 61-61 (50.0%) | 32-19 (62.7%) | 49.0%–74.7% | n=0 | NO: sin línea y juice pregame auditables |
| pitcher_f5 | 48-55 (46.6%) | 39-17 (69.6%) | 56.7%–80.1% | n=0 | NO: sin línea y juice pregame auditables |

**Decisión:** permanecen en sombra. El test histórico usa la línea disponible al
cierre de captura y sirve solo para exploración. Over empieza ahora su muestra
forward con la apertura preservada; F5 no dispone de precio/línea real para medir
valor. La app no los vende como boletos hasta que sus gates pasen.

---
*Honesto por diseño: todo out-of-sample, nada de sobreajuste; se muestra lo que hay, gane o pierda. Generado por robot/simulate.mjs.*
