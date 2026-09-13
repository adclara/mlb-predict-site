# Value decision engine — deployment and evaluation contract

## What changes

The public value table uses the same authorized side-oriented calibrated
probability as the prediction (`p_final`, or its sealed `prob_v2` fallback).
Legacy raw `g.value` is not republished as calibrated EV. Historical feature
rows and already-published selections are not rewritten. Missing calibrated
probability or a two-sided price pair suppresses EV. New cached UI guards reject
legacy/mismatched value payloads. The table names the quote source/time and the
break-even decimal price; this is a captured-price comparison, NOT an executable
bet recommendation. Observed/live prices cannot replace frozen decision prices.

The separate `robot/value_decision.mjs` experiment evaluates home and away
moneylines, including underdogs. It evaluates the freshest current observation
per provider and selects the best qualifying stress EV, or abstains. It never
uses historical `open`/`close` fallback fields as current quotes. Source polling
time is known; provider update time and user-accessible execution are NOT verified.
No trading, credentials, account balances, staking or bookmaker integration.

## Frozen research policy (not fitted, not a confidence interval)

Version: `value-shadow-v1`. Subtract 3 percentage points from each candidate's
estimated win probability and require >=2% expected return under that scenario.
Zero assumed transaction cost is explicit; the policy supports nonnegative
per-unit costs. These are conservative starting scenario settings, NOT measured
confidence bounds or evidence of profitability.

Only observations 1–180 minutes before that EVENT starts are eligible. Quotes
must be <=15 minutes old; generated probability <=60 minutes old. The scheduled
status must explicitly be pregame. Both official starters must match the model
inputs, and both lineups must be complete. Missing prices, identity, timestamps,
lineups, changed starters or duplicate events cause abstention. Maximum two
paper selections per official date and one per event, taken prospectively in
capture order (highest stress EV first within a simultaneous batch). No daily
quota is filled. A later more attractive candidate does not replace an earlier
selection. This is not a retrospective all-day Top 2 optimization.

## Append-only record

`data/history/value_decisions/YYYY-MM-DD.json` contains hash-checked immutable
snapshots of EACH considered event, alternatives, timestamped quote observations,
blocked reasons, probability/policy/model provenance, and `paper_selected`.
Independent hypothetical one-unit outcomes go in `settlements`; neither original
probabilities nor prices are edited. Actual execution is always unverified.
Files are atomically replaced while preserving immutable entries; malformed or
modified existing decision hashes fail rather than silently resetting history.
The existing daily workflow commits this folder with `data/history`.

This is shadow research in the existing repository, not a private access-control
boundary. No trained coefficients or credentials are added to these records.
A missing run produces no observation; there is no fabricated backfill. The
hourly producer does not guarantee exact T-180/T-60/T-15 captures: those labels
classify actual observations. A provider close or postgame quote is never used
as a fabricated pregame CLV reference. Verified close ingestion/CLV remains future
work. Hypothetical settlement assumes standard full-game moneyline final/void
outcomes; actual bookmaker-specific rules and fills have not been verified.

## Rollout / rollback

1. Run the complete Node test suite plus value/reliability browser flows in
   Chromium, Firefox and WebKit at 1280/390/360 widths and ES/EN.
2. Merge the tested PR, deploy Worker/Pages through `.github/poke-deploy`.
3. Run the existing daily producer via `.github/poke`; verify its outcome and
   the new ledger. Inspect the public value schema and post-deploy audit.
4. For rollback, revert the implementation commit through a PR and redeploy.
   Preserve the research ledger as evidence; do not overwrite it with old prices.

All model/market publication gates remain unchanged. `public_picks_enabled:false`
is not configurable here. Source-level or arithmetic tests do not establish
predictive accuracy, profitability, or authorize promotion of this policy.

## Follow-on work, not claimed complete

Private repository parity/signatures/windows and private runner selection still
require their separately authorized writable workflow. No private model source
was copied or modified for this release. Broad model ablations, new player
features, empirical uncertainty estimates, verified execution/close prices,
CLV, bankroll sizing and an independent prospective promotion review remain
separate work. Compare the existing model + new selector before changing the
probability model; do not tune on the final evaluation period.
