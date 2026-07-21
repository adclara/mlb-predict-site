# 🔬 Simulación MLB — walk-forward (2026-03-25 → 2026-07-20)

Entrenamiento y validación **out-of-sample**: cada día se entrena solo con el
pasado y se predice ese día. Datos: **1506 juegos** en 116 días.

## 1 · Precisión probabilística OOS (n=1398)
| modelo | acierto | log-loss | Brier |
|---|---|---|---|
| clásico | 54.2% | 0.721 | 0.262 |
| aprendido | 53.7% | 0.695 | 0.251 |
| combinado | 53.9% | 0.694 | 0.250 |

Δ log-loss (combinado − clásico): **-0.030** IC95% [-0.043, -0.018] — el aprendizaje **ayuda** (mejora la probabilidad).

## 2 · Calibración
ECE **3.9%** — razonable

## 3 · Backtest de selección (apostar el lado favorecido a −110, OOS)
Punto de equilibrio a −110 = **52.4%**.

| umbral confianza | picks | acierto | unidades | ROI |
|---|---|---|---|---|
| ≥53% | 934 | 54.7% | +41.5u | 4.4% |
| ≥55% | 675 | 53.2% | +10.3u | 1.5% |
| ≥58% | 349 | 52.4% | +0.3u | 0.1% |
| ≥60% | 217 | 52.5% | +0.6u | 0.3% |
| ≥62% | 136 | 55.9% | +9.1u | 6.7% |
| ≥65% | 61 | 59.0% | +7.7u | 12.7% |

Ninguna franja supera el equilibrio con significancia estadística sobre toda la muestra: la ventaja medida vive en los tiers curados (FIJO/ORO/GEMA), no en apostar todo lo que pasa un umbral. Se reporta tal cual — así es la marca.

## 4 · Modelo vs mercado
Acierto global: modelo 53.9% vs mercado 56.4% → **mercado mejor**. La ventaja del modelo no está en el promedio, está en la selección.

## 5 · Laboratorio de nuevos mercados (NO publicados)
Corte cronológico 70/30: **2026-06-13**. Se eligen como máximo dos candidatos por
día; no se rellenan cupos. Over se evalúa contra la línea O/U disponible; F5 es
equipo arriba al terminar cinco entradas (empate = push), no victoria del pitcher.

| mercado sombra | train | test histórico | IC95% test | forward real | gate |
|---|---:|---:|---:|---:|---|
| over | 81-68 (54.4%) | 36-30 (54.5%) | 42.6%–66.0% | n=0 | NO: muestra forward insuficiente (n=0) |
| f5 | 71-66 (51.8%) | 35-23 (60.3%) | 47.5%–71.9% | n=0 | NO: sin línea/precio F5 real |
| pitcher_f5 | 61-58 (51.3%) | 37-23 (61.7%) | 49.0%–72.9% | n=0 | NO: sin línea/precio F5 real |

**Decisión:** permanecen en sombra. El test histórico usa la línea disponible al
cierre de captura y sirve solo para exploración. Over empieza ahora su muestra
forward con la apertura preservada; F5 no dispone de precio/línea real para medir
valor. La app no los vende como boletos hasta que sus gates pasen.

---
*Honesto por diseño: todo out-of-sample, nada de sobreajuste; se muestra lo que hay, gane o pierda. Generado por robot/simulate.mjs.*
