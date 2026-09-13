# Value ledger temporal-label correction

The first production observation at 2026-09-13T02:12:50.068Z correctly rejected
already-started games (`action: abstain`, `paper_selected: false`). However, its
presentation-only horizon bin could call a negative lead time `T15`.

New observations store signed `seconds_before_start` and explicitly label a
zero/negative lead as `after_start`. Eligibility, model probabilities, stress
thresholds and public publication gates are unchanged. The source fingerprint
distinguishes the corrected producer.

Do not rewrite the initial snapshots or their hashes. For every historical
analysis, independently require `evaluated_at < start` and the appropriate
eligibility/selection flags. A horizon label alone is never evidence of a
pregame prediction. Initial rejected after-start observations are not a
forward-performance cohort and never become hypothetical bets.
