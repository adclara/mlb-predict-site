# Estudio Polymarket — piloto de medición (2026-07-16)

**Pregunta:** ¿se pueden identificar wallets consistentemente ganadoras en Polymarket con
datos públicos, y replicar sus resultados copiándolas? **Sin dinero, solo medición**, con
el gate acordado: sin edge neto positivo sostenido → se reporta y no se construye más.

## Método
- Universo: **320 mercados deportivos resueltos** (últimos 30 días, tags mlb/nba/nfl/
  soccer/tennis/sports, volumen ≥ $20k; los 320 de mayor volumen de 2,897 hallados).
- Tape: **997,159 trades** (Data API pública; tope de paginación 10k por mercado — 0
  mercados truncados en esta corrida).
- Scoring por wallet: edge al precio de entrada vs resolución, agregado **por mercado**
  (los trades del mismo mercado no son independientes), t-stat entre mercados.
- Filtros anti-trampa: descarta wallets con >30% de mercados jugando ambos lados parejo
  (wash) y compradoras de favoritos (precio medio de entrada > 0.85).
- **Walk-forward**: selección de "ganadoras" solo con el primer 60% de mercados (por
  fecha); evaluación en el 40% restante. Simulación de copiado: entrada al precio del
  primer trade posterior (mismo token) tras 5/60 min de retraso + 1¢ de slippage adverso.
- Verificado antes con tape sintético (detecta sharp real, filtra wash y favoritos).

## Resultados
| Métrica | Valor |
|---|---|
| Wallets únicas | 92,622 |
| Con ≥8 mercados en selección | 5,900 |
| Medibles en ambas ventanas | 2,657 |
| **Persistencia** Spearman (edge pasado ↔ futuro) | **ρ = 0.10** (≈ nada) |
| Ganadoras en selección que siguen ganando | **40.4%** (peor que una moneda) |
| Candidatas tras filtros (t≥2) | 154 → top 20 seleccionadas |
| Edge del LÍDER en evaluación (señales a 5 min) | **−0.078/acción** |
| Edge del COPIADOR a 5 min (neto 1¢) | **−0.070/acción** |
| Edge del COPIADOR a 60 min (63% de fills) | **−0.026/acción** |

Los "top" del período de selección (edges de +0.15 a +0.49, t hasta 10.9) **colapsaron
en la ventana de evaluación**: la mayoría a edge negativo o sin actividad; solo 2 de 10
sostuvieron edge positivo. Es el patrón clásico de **descubrimiento falso + regresión a
la media**: con 92k wallets, cientos parecen genios por azar en cualquier ventana.

## Veredicto (gate)
**❌ Sin edge replicable.** Ni siquiera las wallets seleccionadas con el método más
estricto sostuvieron su edge, y el copiador simulado pierde dinero en ambos retrasos.
Según el gate acordado: **se reporta y no se construye más** (ni bot, ni seguimiento,
ni dinero real).

## Límites del estudio (honestidad)
- Una sola ventana de 30 días (julio 2026: Mundial + Wimbledon + MLB) y un solo corte
  60/40; mercados top por volumen. Una señal débil real podría escondérsenos — pero el
  resultado coincide con la literatura (solo ~12.7% de usuarios rentables; ~45% del
  volumen deportivo señalado como wash trading por el estudio de Columbia 2025).
- El slippage real de un copiador sería PEOR que el simulado (impacto de mercado propio,
  honeypots documentados contra copiones).

## Reproducir
Workflow `poly-study` (dispatch o tocar `.github/poke-poly`) → log + artifact
`poly-study` (JSON completo con top wallets y simulación).
