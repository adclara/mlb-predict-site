# Plan de inteligencia MLB — AA Sports

**Fecha del estudio:** 21 de julio de 2026

**Estado:** plan técnico; no despliega ni promociona ningún modelo

**Objetivo:** aumentar la calidad predictiva y la tasa de acierto sin inventar ventaja, sin fuga temporal y manteniendo infraestructura $0.

## Resumen ejecutivo

La prioridad no es añadir más variables ni reentrenar cada 15 minutos. La auditoría encontró que las filas que alimentan a Cerebro AA se recalculan y sobrescriben durante el día, incluso después del primer lanzamiento. Por eso una parte de la evidencia actual no representa lo que el algoritmo sabía cuando publicó la decisión.

El plan correcto tiene cuatro capas separadas:

1. **Capturar cada 20 minutos:** calendario, abridores, lineup, mercado, clima y estado, en snapshots append-only.
2. **Predecir con un corte explícito:** una decisión oficial a las 7am ET y, en sombra, otra T−90 minutos cuando exista lineup confirmado.
3. **Aprender solo con juegos Final:** resultados nuevos actualizan labels; el refit/calibración ocurre una vez al día y la promoción de modelos una vez por semana.
4. **Publicar solo después de un gate forward:** comparar champion contra challenger con el mismo timestamp, precio real y muestra independiente.

Cloudflare debe ser el reloj de ingesta porque el cron horario de GitHub no está cumpliendo una hora: en los 100 runs programados auditados, la mediana entre ejecuciones fue 127.8 minutos y el máximo 232.2. GitHub Actions seguirá siendo el motor privado del algoritmo; un Worker ligero solo capturará hechos públicos en D1.

## 1. Qué existe hoy

```text
StatsAPI / ESPN / Open-Meteo
  → daily.mjs / computeDay()
  → Elo + carreras esperadas + simulación
  → factores AA: momentum, pitching, F5, bats, schedule, manager, news
  → odds / consenso
  → learner + Platt
  → ancla al mercado = p_final
  → Top / Gema / ORO / laboratorios sombra
  → games/YYYY-MM-DD.json
  → grading + learning.json + simulate.mjs
  → KV/D1 → Worker → frontend
```

Inventario medido:

- 116 días, 1,544 filas y 1,506 filas gradadas.
- 1,333 filas gradadas provienen del backfill as-of; 173 son nativas.
- 16 `game_pk` repetidos; uno fue gradado dos veces.
- Cero filas con consenso multicasa real.
- Cero Over forward gradados con apertura verificable.
- Cero F5 forward gradados con score explícito.

Las métricas que hoy genera el repo son:

| Modelo | Acierto OOS reportado | Log-loss | Brier |
|---|---:|---:|---:|
| Clásico | 54.22% | .7209 | .2621 |
| Aprendido | 53.72% | .6953 | .2510 |
| Combinado | 53.86% | .6942 | .2504 |
| Mercado | 56.43% | .6845 | .2457 |

Lectura provisional: el aprendizaje reduce sobreconfianza y mejora log-loss/Brier frente al clásico, pero no mejora el acierto de clasificación y aún queda detrás del mercado. Estas cifras deben reconstruirse sobre snapshots de decisión inmutables antes de tratarlas como evidencia de promoción.

## 2. Hallazgos que deben corregirse antes de un boost

### P0. Las features de entrenamiento no están congeladas

`upsertGames()` preserva el resultado y parte de las odds, pero reemplaza el resto de la fila con la captura más reciente. En el 20 de julio cambiaron después de la publicación:

- `p_final`: 15 de 15 juegos; cambio absoluto medio de 4.11 puntos porcentuales y máximo de 15.47.
- `adrian_p`, `model_p` y `sp_fip_diff`: 14 de 15.
- `ml_pick`: 2 de 15.
- lado del total: 5 de 15.

Entre las 173 filas nativas gradadas, 94 quedaron guardadas con estado `Final`, 40 `In Progress` y solo 34 conservaron un estado pregame. El entrenamiento puede recibir FIP/forma/mercado posteriores al corte y, en algunos casos, posteriores al propio juego.

**Decisión:** crear un `prediction_snapshot` inmutable y separar todos los snapshots observacionales posteriores. El trainer solo podrá consumir una fila si `feature_as_of < first_pitch`.

### P0. El récord público mezcla live y retrospectivo

Se auditaron 52 objetos de `plays` contra el horario oficial de StatsAPI:

- 13 fueron creados después del primer lanzamiento.
- 12 corresponden al backfill retrospectivo del 1–4 de julio.
- 1 pick del 16 de julio se creó 5.36 horas después de comenzar.
- Récord mostrado: 26–23.
- Récord estrictamente pregame: 18–18 sobre 36 picks.

La causa del caso del 16 de julio es `existingToday.plays?.length`: si la primera publicación tiene cero picks, el slate no queda congelado y una corrida posterior puede llenarlo.

**Decisión:** separar `backtest`, `shadow_forward` y `public_live`; congelar el slate mediante `published_at` aunque contenga cero candidatos; excluir de cualquier récord público lo que no cumpla `posted_at < first_pitch`.

### P0. El gate ORO no pasa al retirar filas nativas contaminadas

- Replay actualmente reportado: 76–30, n=106.
- Solo backfill as-of: 63–23, n=86.
- Tramo test del backfill: 19–6, n=25.
- Gate implementado: `all >= 100` y `test >= 30`.

Sin las 20 filas nativas que completan la muestra, el propio gate falla. Además, el replay se diseñó después de inspeccionar señales del mismo histórico y no reproduce todos los estados de producción.

**Decisión:** ORO vuelve a considerarse experimental/sombra hasta reunir forward limpio. El récord live previo de fijos, 11–7, es una muestra diferente y pequeña; no valida el replay 76–30.

### P0. Totales y F5 todavía no son boletos medibles

La línea clásica de total es la expectativa del propio modelo redondeada, no la línea del sportsbook. En 1,156 de 1,492 juegos con mercado (77.5%) difiere del O/U de ESPN. El acierto interno fue 51.9%; aplicado a la línea de ESPN fue 50.1%.

Para F5 no hay score explícito guardado en las 1,544 filas ni precio real de ambos lados. El fallback de la curva ESPN sirve para exploración, no para validar una apuesta F5.

**Decisión:** todo total debe unir predicción, línea y juice capturados antes del juego. F5 requiere score explícito tras cinco entradas y precio F5 real; hasta entonces continúa privado.

### P1. Odds y timestamps no demuestran apertura

- `p_home_open` existe en 168 de 1,544 filas.
- En las filas donde se pudo revisar, `captured_at` fue posterior al inicio en 78 de 93; mediana +7.5 horas.
- 1,338 filas de odds fueron backfilled con `stage: final`.
- No existe `captured_at_open` inmutable.

**Decisión:** guardar `market_as_of`, `captured_at_open`, `captured_at_close`, provider, precio de ambos lados y hash de fuente. Ningún valor capturado post-start podrá llamarse apertura o alimentar una decisión pregame.

### P1. La validación debe replicar exactamente producción

- El replay aprende el ancla `adrian_p + market`, pero producción aplica ese alpha a `p_comb + market`.
- Lambda se elige sobre el mismo OOS luego reportado.
- El ROI simulado supone −110 para todas las moneylines; ORO tuvo mediana −157 y rango −454 a −110.
- El bootstrap principal usa un LCG que pierde precisión en JavaScript y no centra bien sus medias. Con RNG corregido, el beneficio de log-loss sigue apareciendo; el acierto continúa empatado. Un bootstrap por fecha dio Δlog-loss −.027, IC95% [−.041, −.013], pero sigue usando filas cuya temporalidad debe repararse.
- El motor Monte Carlo usa `Math.random`, así que inputs idénticos pueden producir decisiones distintas cerca del umbral.

**Decisión:** replay y producción compartirán una sola función de scoring/selección; hiperparámetros se elegirán en un walk-forward anidado; remuestreo por fecha/serie; simulación analítica o semilla estable por `game_pk + model_version`.

## 3. Arquitectura $0 para ingesta cada 20 minutos

```text
Cloudflare Cron */20
  → mlbCaptureLite()
  → 1 fetch StatsAPI schedule hidratado
  → 1 fetch ESPN scoreboard
  → D1 mlb_ingest_slots (append-only, idempotente)
          ↓
GitHub Actions privado
  → consume slots nuevos / watermark
  → materializa features por etapa
  → crea decision_snapshot inmutable
  → gradúa finales
  → entrena champion + challengers
  → publica solo resultados/gates aprobados a KV/D1
          ↓
Worker read-only → Pages
```

### Tabla D1 propuesta: `mlb_ingest_slots`

| Campo | Uso |
|---|---|
| `slot_id` PK | `floor(scheduled_time / 20min)`; deduplica delivery at-least-once |
| `date_et` | slate de MLB |
| `scheduled_at` | momento esperado del tick |
| `captured_at` | momento real de captura |
| `source_hash` | evita reescrituras cuando no cambió nada |
| `n_games` | reconciliación con la fuente |
| `stage` | early / published / lineup / pregame / live / final |
| `payload_json` | hechos públicos compactos; cero pesos o lógica privada |
| `status`, `error` | salud del pipeline |

### Tabla propuesta: `mlb_prediction_snapshots`

Una fila por `game_pk + horizon + model_version`:

- `horizon`: `official_07_et` o `lineup_t_minus_90`.
- `feature_as_of`, `market_as_of`, `first_pitch`.
- `feature_hash`, `input_version`, `model_version`, `calibrator_version`.
- probabilidad, pick, abstención, regla/tier y reason codes.
- `published_at` y `invalidated_at`; jamás UPDATE de inputs/probabilidad.
- outcome y grading en tabla separada o columnas que no alteren el hash de decisión.

### Presupuesto medido

El diseño añade un tercer cron de los cinco permitidos en Workers Free. Consumo aproximado:

- 72 invocaciones Worker/día.
- 144 fetches upstream/día.
- 72–144 filas D1 escritas/día.
- 10–20 KB por slot: 22–43 MB por 30 días, con retención/compactación.

No se debe ejecutar el workflow actual completo cada 20 minutos. Con las dos publicaciones, journal, injuries y Radar, la proyección ronda 1,029 escrituras KV/día, por encima del límite gratuito de 1,000. El Worker ligero usa D1 y el uploader solo escribe KV si cambió un hash canónico.

## 4. Cadencia operativa

| Cadencia | Trabajo | Qué no hace |
|---|---|---|
| Cada 20 min | schedule, estado, probable pitcher, lineup, ML/O-U/spread primarios, hash y timestamps | no reentrena ni cambia el snapshot oficial |
| Cada 5 min durante live | score y win probability; persistencia directa a D1 | no commits Git intradía |
| Cada 60 min | multi-book disponible, forecast, scratch/starter change | no convierte una captura tardía en apertura |
| Cada 6 h | injuries, transactions, season FIP, team splits/rosters | no toca resultados previos |
| Tras cada Final | outcome, F5 explícito, watermark, Elo y labels | no usa live/postgame como feature pregame |
| Diario | refit, calibración, challenger scoring, Cerebro AA | no promociona automáticamente |
| Semanal | nested walk-forward, block bootstrap, drift y promoción/rollback | no optimiza umbrales sobre el test reportado |

Run diario objetivo:

1. 05:30 ET — reconciliar finales, deduplicar y validar timestamps.
2. 06:00 ET — entrenar champion/challengers solo con decisiones anteriores.
3. 06:30 ET — calibrar, ejecutar gates y generar model card.
4. 07:00 ET — congelar `official_07_et`, aunque haya cero picks.
5. T−90 min — crear challenger de lineup; puede confirmar, retirar o invalidar, nunca reescribir el récord de las 7am.
6. Después de cada final — anexar outcome y actualizar el watermark de aprendizaje.

GitHub puede retrasar o descartar cron jobs bajo carga. Sin un nuevo token de GitHub, el SLA confiable aplica a la **captura** de Cloudflare, no al cómputo privado exacto de las 7am. Una fase opcional puede guardar un fine-grained `GH_TRIGGER_TOKEN` como secret del Worker y disparar un workflow corto mediante `repository_dispatch`; sigue costando $0, pero requiere autorización humana y debe limitarse a una ruta/job específico.

## 5. Cómo hacer más inteligente el modelo

### Champion inicial después del P0

El baseline limpio debe ser simple, reproducible e interpretable:

```text
logit(P(home)) = logit(P_market_as_of) + β · X_AA
```

El mercado pregame actúa como offset y AA aprende únicamente el residual que sus datos pueden explicar. Ridge regulariza los coeficientes. Si AA no mejora al mercado en el mismo timestamp, el coeficiente residual se encoge y el sistema abstiene; no fabrica una ventaja.

### Experimentos en sombra

| ID | Hipótesis | Diseño | Gate propuesto, no resultado actual |
|---|---|---|---|
| E0 | Snapshot inmutable elimina fuga temporal | official 7am y observaciones separadas | 100% antes del first pitch; 0 mutaciones; 0 duplicados |
| E1 | Residual al mercado mejora probabilidad | ridge con offset de mercado; nested WF | ≥1,000 OOS + ≥300 forward/60 fechas; IC por fecha de Δlog-loss <0; ECE ≤5%; Brier no peor |
| E2 | Quitar factores débiles reduce varianza | máximo cinco ablations preregistradas | mismo gate E1 y estabilidad por mes/local-visita/banda de cuota |
| E3 | Abridor/bullpen detallado añade señal | K−BB%, HR, FIP con shrinkage; pitcheos/relevistas L3 | ≥500 OOS + ≥200 forward; IC de Δlog-loss <0 |
| E4 | Lineup confirmado mejora la mañana | official 7am vs T−90m pareado | ≥300 juegos con ambos snapshots; cero mezcla de récords |
| E5 | Selector price-aware concentra edge | meta-selector que puede devolver cero | ≥100 picks forward/60 fechas; exceso sobre prob. implícita, ROI y CLV con IC por fecha positivo |
| E6 | Over/F5 son mercados publicables | línea+juice reales; F5 explícito | ≥200 decisiones forward por mercado; CLV positivo y límite inferior ROI >0 |
| E7 | Decay maneja cambios de temporada | ventana expansiva vs decay y prior multitemporada | nested WF; mejor rolling log-loss sin deterioro mensual persistente |

### Features con mayor prioridad

1. **Abridor con shrinkage:** K−BB%, HR/FB, FIP, pitch count y descanso; no ERA de tres aperturas sin encoger.
2. **Bullpen realmente disponible:** pitcheos, innings y leverage de relevistas usados en 1/3 días; no solo número de juegos.
3. **Lineup delta:** fuerza del lineup confirmado contra el proyectado y mano del abridor.
4. **Ofensiva rolling por mano:** ventanas temporales con prior de temporada, calculadas as-of.
5. **Descanso/viaje real:** solo juegos jugados; excluir postponed y corregir doubleheaders.
6. **Clima/park pregame:** forecast disponible al corte, nunca clima observado postgame.
7. **Mercado multi-book:** consenso y dispersión cuando existan dos o más precios verdaderos.

Factores que no deben recibir más peso sin nueva evidencia: racha simple, `prob >= 60%`, news binario y el `schedule` actual. El estudio vigente los clasifica como ruido o los define de forma insuficiente.

## 6. Métricas y gates de éxito

La tasa de acierto sola favorece favoritos caros. AA Sports debe separar dos productos:

- **Alta probabilidad:** maximiza acierto y siempre muestra precio/break-even; puede tener ROI negativo.
- **Valor medido:** exige superar la probabilidad implícita y el costo real; puede acertar menos y rendir mejor.

Scoreboard champion/challenger:

- Log-loss, Brier y ECE en probabilidades.
- Acierto con cobertura/abstención y Wilson 95%.
- ROI a precios capturados, no −110 fijo.
- CLV usando apertura verificable y cierre verificable.
- Métricas por mes, home/away, rango de precio, probable confirmado/scratch y etapa.
- Diferencias pareadas con bootstrap por fecha o serie.
- Frescura, missingness, duplicados, mutaciones y drift de features.

Promoción:

1. El challenger se registra antes de observar su forward.
2. Se evalúa con el mismo universo/timestamp que el champion.
3. Pasa todos los gates probabilísticos y operativos definidos para el experimento.
4. Se promueve semanalmente, nunca durante un mal/buen día aislado.
5. Se guarda champion anterior y rollback es un cambio de versión, no reescritura histórica.

## 7. QA y monitoreo obligatorios

Tests de integridad:

1. `decision_snapshot_is_immutable`.
2. `decision_captured_before_first_pitch`.
3. `postgame_refresh_cannot_change_feature_hash`.
4. `duplicate_game_pk_is_rejected`.
5. `same_timestamp_market_baseline`.
6. `deployed_p_final_matches_walk_forward_chain`.
7. `nested_hyperparameter_selection`.
8. `same_inputs_same_prediction`.
9. `starter_change_marks_void_or_creates_new_version`.
10. `total_and_f5_require_line_and_price`.
11. `production_selector_equals_replay_selector`.
12. `doubleheader_postponed_and_et_cutoff`.
13. `api_failure_uses_stale_snapshot_and_abstains`.
14. `zero_candidates_is_valid_and_frozen`.
15. Reconciliación diaria de juegos, decisiones, outcomes y descartes.

SLO operativo propuesto:

- `last_capture_age <= 30 min` mientras existe slate activo.
- Alerta solo tras dos slots perdidos, aproximadamente 45 minutos.
- 0 filas de training con `feature_as_of >= first_pitch`.
- 0 mutaciones del hash de decisión.
- 0 duplicados por `game_pk + horizon + model_version`.
- Uso KV P95 diario por debajo de 800 writes para conservar 20% de margen.
- Worker capture P95 CPU por debajo de 8 ms; cero `exceededCpu`.

## 8. Roadmap

### Fase 0 — integridad y honestidad

- Nuevo esquema append-only y snapshot oficial inmutable.
- Congelar slate con cero picks.
- Separar récord backtest/live y corregir la curva pública.
- Devolver ORO a sombra hasta evidencia forward limpia.
- Corregir total, F5, dedupe, postponed y timestamps de odds.
- Reemplazar RNG defectuoso y hacer determinista el motor.

**Salida:** ningún test P0 falla; el sistema puede demostrar qué sabía y cuándo.

### Fase 1 — ingesta 20 minutos

- Tercer Cron Trigger Cloudflare.
- `mlb_ingest_slots` idempotente en D1 y retención de 30 días.
- Separar watcher, refresh, learner y uploader.
- Eliminar commits intradía; compactar una vez al día.
- Endpoint privado/operativo de salud del pipeline.

**Salida:** captura fresca sin exceder free tier y sin tocar el algoritmo privado.

### Fase 2 — baseline limpio

- Rehacer evaluación end-to-end exacta de `p_final`.
- Nested walk-forward, block bootstrap y precios reales.
- Model card/versionado y rollback.
- Cerebro AA diferencia claramente observación, hipótesis y señal aprobada.

**Salida:** champion defendible, aunque el resultado sea “empate con mercado”.

### Fase 3 — challengers

- E1 residual al mercado.
- Ablations de factores débiles.
- Abridor/bullpen real y horizonte T−90m.
- Over/F5 permanecen en sombra hasta sus propios gates.

**Salida:** solo se promociona una mejora que demuestre ganancia forward independiente.

### Fase 4 — aprendizaje continuo gobernado

- Drift, calibration decay, promotion/rollback semanal.
- Selector price-aware con abstención.
- Documentación pública honesta de muestra, cobertura y estado del gate.

## 9. Qué no se promete

- No existe una forma honesta de garantizar más aciertos.
- Capturar más seguido no crea señal por sí solo.
- Reentrenar con un juego que no terminó no es aprendizaje.
- Un favorito con 70% de probabilidad no es automáticamente una buena apuesta si su precio exige 75%.
- Un backtest no se mezcla con el récord live.

La mejora defendible es convertir AA Sports en un sistema que recuerda exactamente qué sabía en cada corte, aprende solo de resultados válidos, compara ideas en sombra y publica menos cuando la evidencia no alcanza.

## English summary

The audit found that native training rows are overwritten during and after games, so the first priority is temporal integrity rather than additional model complexity. The recommended design captures public data every 20 minutes into append-only D1 slots, keeps the private model in GitHub Actions, freezes an immutable 7am ET decision snapshot, learns only after Final outcomes, and promotes challengers through independent forward gates. Current ORO, total and F5 evidence is not strong enough for a new performance claim. No improvement in hit rate is promised before clean forward validation.
