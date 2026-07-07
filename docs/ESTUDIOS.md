# Registro de estudios — Predict Baseball 2026

Bitácora científica del algoritmo. Cada estudio es **walk-forward** (los modelos solo ven
días anteriores), con intervalos de confianza y prueba de estabilidad en ambas mitades de la
temporada. Se reportan TODOS los resultados, incluidos los negativos.

## 2026-07-07 · Torneo de metodologías (n=1,194 juegos con línea)

Seis familias de algoritmos distintas + el cerebro de producción + el mercado, todas
re-entrenadas walk-forward por fecha:

| Metodología | Acc | Logloss | Brier |
|---|---|---|---|
| **Mercado (consenso de-vig)** | 56.2% | **0.6852** | 0.2461 |
| **p_final (producción: ensemble+Platt+ancla)** | 55.9% | **0.6854** | 0.2462 |
| Elo 538 reconstruido de los logs | 52.7% | 0.6911 | 0.2490 |
| Super-ensemble (stack de todos) | 54.1% | 0.6914 | 0.2491 |
| k-NN por similitud | 51.3% | 0.6963 | 0.2516 |
| Beta-binomial (Bayes empírico) | 51.6% | 0.7012 | 0.2538 |
| Bradley-Terry | 52.3% | 0.7204 | 0.2610 |
| Poisson ataque/defensa (Maher) | 52.3% | 0.7286 | 0.2634 |
| AdaBoost de stumps | 50.5% | 0.7568 | 0.2753 |

**Veredictos con CI (bootstrap pareado, B=1000):**
- p_final − mercado: Δlogloss 0.0002, CI [−0.0001, 0.0004] → **empate**. El cerebro de
  producción alcanzó el techo del mercado.
- stack − p_final: +0.0066, CI [0.0033, 0.0098] → el super-ensemble es **peor** (apilar
  modelos más débiles sobre un predictor anclado al mercado solo agrega ruido).

**Conclusión:** la ventaja de la app NO está en pronosticar mejor que las casas (nadie de
las 8 alternativas lo logró), sino en la **selección** (fijos ⭐⭐: favorito del mercado +
5+ factores = 67.7–68.3% y ROI +7.9–9.4% en simulación), la **calibración** (gemas 💎 ≥65%:
dice 68.5% → acierta 68.7%) y el control de riesgo (multi-casa, discrepancia, línea cara).

## 2026-07-07 · Parámetros de contexto reconstruidos (n=1,341)

Señales orientadas pre-registradas (dirección declarada antes de mirar resultados):

| Señal | Gap (favor − contra) | Mitades | Veredicto |
|---|---|---|---|
| Descanso real ≥1 día (aux_rest) | **+17.5 pts** | 14.5 / 17.5 | pre-registrada, madura (n=56 < 60) |
| Calendario fresco (aux_dens) | +4.7 | 7.9 / 1.2 | ruido |
| Forma casa/ruta (aux_haf) | +2.2 | 4.2 / 1.0 | ruido |
| Pitagórico L20 (aux_pyth) | +0.5 | −1.0 / 1.8 | ruido |
| Rival viajó al este (aux_tze, PNAS 2017) | n<60 | — | acumulando |
| Platoon L/R (aux2) | sin datos aún | — | acumulando |

- Aux-stack (logística de contexto sobre p_final): **empate OOS** → no adoptado. El mercado
  ya trae el contexto en el precio.
- Veto de descanso en fijos: quitaría fijos que ganaron 80% → no adoptado.

## 2026-07-07 · Torneo de reglas de fijos (104 días)

| Regla | n/día | Gana | ROI | Mitades |
|---|---|---|---|---|
| **ORO: favorito mercado + 5+ factores (adoptada)** | ~1.5 | **67.7%** [60.1–74.5] | **+7.9%** | 69/66 |
| Sin filtro de factores | ~1.9 | 66.3% | +4.5% | 70/63 |
| Mercado puro (sin método Adrian) | ~1.6–1.9 | 58–61% | **−10 a −12%** | inestable |

El filtro de factores del método Adrian **aporta valor real**: seguir solo a las casas
pierde dinero. PLATA (favorito sin 5+ factores) = segundo favorito informativo (55–63%, ROI
negativo, inestable) con récord aparte.

- Bandas de precio: consenso ≥70% → estructuralmente −EV (breakeven > tasa del oro) →
  aviso "línea cara" (se muestra, no se filtra).
- Riesgo: bootstrap ROI 95% [−4.5%, +16.6%]; racha máx. de fijos perdidos: 4; ~12% de días
  pierden todos. Staking: plano 1u superó a ¼-Kelly en simulación.

## 2026-07-07 · Gemas (umbral por datos)

p_final ≥65% (walk-forward): n=67, gana **68.7%** [56.8–78.5], mitades 65/72, calibración
exacta (dice 68.5% → acierta 68.7%). ROI ≈ −3% (el vig): la gema maximiza acierto, el ROI
vive en los fijos ORO.

## 2026-07-07 · Estudio multi-temporada (2023–2025, n=7,303 juegos)

Backfill histórico vía statsapi + señales de contexto evaluadas sobre el equipo LOCAL,
direcciones pre-registradas antes de mirar los datos (data/history/history_study.json):

| Señal | Gap | CI 95% | n | Veredicto |
|---|---|---|---|---|
| **Pitagórico L20** | **+10.0 pts** | [+7.5, +12.7] | 2815/2799 | **ROBUSTO multi-temporada** |
| **Forma casa/ruta** | **+7.7 pts** | [+4.7, +10.9] | 2496/1445 | **ROBUSTO multi-temporada** |
| Descanso ≥1 día | −3.0 pts | [−12.3, +5.5] | 298/217 | ruido |
| Calendario fresco | −1.7 pts | [−5.5, +1.9] | 1471/1446 | ruido |
| Rival viajó al este | −1.2 pts | [−7.5, +5.4] | 249/6647 | ruido |

**Lecciones:**
1. El descanso (+17.5 pts en la muestra 2026) **era espejismo de muestra chica** — a escala
   es ruido. El backfill evitó adoptar una señal falsa: exactamente para esto existe.
2. Pitagórico y forma casa/ruta son efectos REALES y robustos… pero el aux-stack ya demostró
   que **el mercado los tiene en el precio** (empate OOS vs p_final) y como desempate de
   fijos empeoraron. Conclusión: reales como fenómeno, sin valor incremental sobre el
   consenso de las casas — quedan medidos y documentados, no ponderados.

## Fuentes
- Woodland & Woodland (1994), *Journal of Finance*: sesgo favorito-longshot invertido en MLB.
- Song, Severini & Allada (2017), *PNAS*: jet lag y rendimiento MLB (n=46,535).
- Kelly (1956) / práctica profesional: Kelly fraccional, CLV como validación.

## Métricas en acumulación automática (verdicts CI-gated en learning.json)
- CLV (apertura→cierre hacia nuestro pick) · microestructura multi-casa (discrepancia,
  line move, valor) · señales aux/platoon/serie · récords fijos oro/plata y gemas.
