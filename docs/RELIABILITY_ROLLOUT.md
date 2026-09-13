# Reliability rollout and remaining execution plan

Tracking: #244. Implementation: #245. NBA/WNBA monitoring defect: #243.

## Release boundary

This release changes producer evidence, monitoring and presentation, not the prediction formulas, trained coefficients, selection gates or human approval. It does not promote AA Lab or any closed sport. No paid service or new production credential is introduced.

## Order of operations

1. Test the exact PR revision with the full unit suite, existing MLB/QA/Central browser regressions and reliability tests in Chromium, Firefox and WebKit at desktop, 390 and 360 pixels, in Spanish and English.
2. Inspect the diff and screenshots. Squash-merge only the verified revision. Temporary source-assembly files must not remain in the final tree.
3. Trigger the existing deployment with `.github/poke-deploy` in a separate reviewed PR. The deployment applies the additive D1 migration, then Worker and Pages.
4. Verify the deployment and its automatic read-only production audit, including MLB standings, data freshness and public desktop/mobile navigation/search.
5. Trigger NBA and WNBA producers with their existing poke files. Check actual producer job completion and read back `/v1/{nba,wnba}/pipeline-health`. A schema update alone is not proof that a producer completed.
6. Record the observed states and timestamps in #243 and #244. Pending grading or upstream failures must remain visible; do not turn them green to close an issue.

## Producer-health contract

`basketball_producer_health` persists each attempt independently of prediction rows. `last_success_at` advances only after valid capture evidence and all required publishing steps complete. Failed/running attempts preserve the preceding success. The NBA cadence remains six hours; WNBA remains hourly. The maximum producer/evidence age is two expected intervals.

The capture receipt must belong to the current workflow attempt and contain successfully observed, complete today/tomorrow scoreboards with matching eligible/logged counts. Missing or malformed upstream and D1/KV responses fail the strict producer run rather than returning a silent success. A verified empty calendar can be `idle_no_games` even when the last prediction is old. An old prediction cannot substitute for a producer heartbeat. Historical unresolved results remain a separate `pending_grading` condition.

The public API and Cerebro display producer and prediction timestamps separately. Monitoring status does not approve publication or establish predictive accuracy/profitability.

## User-facing evidence contract

Missing risk inputs return an unknown descriptive index, not zero/low risk. Historical cached risk labels without the new coverage evidence are displayed as unknown. One-language legacy verdicts cannot resurrect obsolete value claims. Probability differences use percentage points; positive differences and model-estimated EV are not promises of profitable odds. Missing and zero/negative differences do not claim moderate or solid value.

Mobile search remains visible and is tested through the actual user control. The existing production audit must not skip it merely because the viewport is small.

## Recovery

If the release causes a verified regression, revert the application/workflow changes through a reviewed PR and use the normal deployment mechanism. The migration only adds a heartbeat table; do not delete prediction history, reset model evidence or open gates to recover monitoring. Preserve the heartbeat history available in D1 and the test/deployment receipts. A failed source is an operational incident, not a reason to fabricate a successful timestamp.

## Remaining work and acceptance criteria

- Private model integrity: training/serving window parity (including NHL 40), complete behavior signatures, measured schedule/duplicate coverage, complete two-sided prices with real-price EV, durable forward-ledger recovery. The current connector blocked the private-branch write; these changes are NOT included in #245.
- Modeling: immutable point-in-time feature/price snapshots, lineup completeness, preregistered ablations against the same-time market, selected-cohort calibration and actual-price evaluation. Accept a challenger only on genuinely future held-out evidence and existing approval gates; more code is not proof of improved accuracy.
- Identity: real Google login, cross-device favorites/account persistence and allowed/denied private-QA sessions with test identities. Mocked UI and anonymous rejection checks do not establish these outcomes.
- Devices/capacity/security: actual Safari/iOS and physical-device behavior, a bounded staging capacity test with stop criteria, and a scoped security review remain unverified. Playwright WebKit is not a physical Safari certification. No production stress test or destructive scan is part of this release.
- Architecture: incremental frontend/Worker modules and explicit probability provenance, each behind regression tests, without a wholesale framework rewrite.

Completion status belongs in #244 with actual commit, CI, deployment and production-readback evidence, not a guessed percentage complete.
