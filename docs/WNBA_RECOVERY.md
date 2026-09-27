# WNBA producer recovery (2026-09-27)

The observed incident was a gap between invocations, not a failed model run.
The last inspected original run 36306254859 completed at 08:27:53Z while later
main workflows continued. Do not use prediction-row age as producer liveness.

## Control
- Cron wakeups at :11, :31 and :51; successful producer work is still due hourly.
- Independent completed main workflows also wake the same serialized producer:
  mlb-live-observer, soccer-shadow, US sports freshness QA and nba-shadow.
- No subscription to market-intelligence/adrian-daily (they already listen to
  WNBA), no completion loops, no upstream artifacts/code, no branch execution.
- Preflight reads the authoritative D1 producer row and validated schedule
  evidence. A verified success <60 minutes old skips without heartbeat writes.
  Old prediction rows, closed model gates and zero-game days are not failures.
- In-flight attempts get 25 minutes before recovery, failed attempts get a
  15-minute cooldown, and unavailable reads request the existing strict producer
  instead of claiming health. Existing concurrency never cancels a running job.
- Historical backtests stay limited to explicit push/manual runs; redundant
  workflow_run triggers never rerun those expensive checks.
- Producer success remains after capture, Cerebro and simulation publication.
  Post-run D1/public API readback must match this exact successful run. Pending
  grading stays visible. A readback failure is not a fabricated producer success
  or a rewrite of an already-recorded real completion.
- Preflight/readback JSON artifacts are retained 7 days without credentials or
  model internals. A skipped preflight is not a new producer execution.

## Release acceptance
Run tests/wnba_watchdog.test.mjs, basketball lifecycle/capture tests and the
existing full PR CI. Merge through a reviewed PR. No Worker/Pages/model/schema
change requires web deployment. The .github/poke-us-sports change runs read-only
QA; its successful completion exercises the independent WNBA recovery path.
Verify that actual main run's producer steps and D1/public API readback finish,
and preserve run IDs plus observed timestamps in the PR. Never manufacture an
old success timestamp or widen the health threshold to make the incident green.

## Boundary and rollback
No private repo, paid source, model weights, publication gates or betting actions
are changed. Multiple GitHub wake sources reduce dependence on one dropped cron;
they do not guarantee availability during a GitHub-wide scheduler/runner outage.
A truly independent external trigger would require separately scoped credentials
and infrastructure review; none is introduced here. The existing daily alert
remains a monitor, not this producer's scheduler.
Rollback the workflow/helper via PR, preserving D1 and evidence. Use the existing
WNBA poke only when deliberately requesting a full operator-triggered run.
