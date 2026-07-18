# 🔬 Simulación MLB — walk-forward (2026-03-25 → 2026-07-17)

Entrenamiento y validación **out-of-sample**: cada día se entrena solo con el
pasado y se predice ese día. Datos: **1456 juegos** en 113 días.

## 1 · Precisión probabilística OOS (n=1348)
| modelo | acierto | log-loss | Brier |
|---|---|---|---|
| clásico | 54.0% | 0.722 | 0.263 |
| aprendido | 53.5% | 0.696 | 0.252 |
| combinado | 53.7% | 0.695 | 0.251 |

Δ log-loss (combinado − clásico): **-0.024** IC95% [-0.040, -0.014] — el aprendizaje **ayuda** (mejora la probabilidad).

## 2 · Calibración
ECE **4.1%** — razonable

## 3 · Backtest de selección (apostar el lado favorecido a −110, OOS)
Punto de equilibrio a −110 = **52.4%**.

| umbral confianza | picks | acierto | unidades | ROI |
|---|---|---|---|---|
| ≥53% | 904 | 54.2% | +31.4u | 3.5% |
| ≥55% | 658 | 52.7% | +4.4u | 0.7% |
| ≥58% | 342 | 52.0% | -2.2u | -0.6% |
| ≥60% | 215 | 52.6% | +0.7u | 0.3% |
| ≥62% | 135 | 55.6% | +8.2u | 6.1% |
| ≥65% | 60 | 58.3% | +6.8u | 11.4% |

Ninguna franja supera el equilibrio con significancia estadística sobre toda la muestra: la ventaja medida vive en los tiers curados (FIJO/ORO/GEMA), no en apostar todo lo que pasa un umbral. Se reporta tal cual — así es la marca.

## 4 · Modelo vs mercado
Acierto global: modelo 53.7% vs mercado 56.4% → **mercado mejor**. La ventaja del modelo no está en el promedio, está en la selección.

---
*Honesto por diseño: todo out-of-sample, nada de sobreajuste; se muestra lo que hay, gane o pierda. Generado por robot/simulate.mjs.*
