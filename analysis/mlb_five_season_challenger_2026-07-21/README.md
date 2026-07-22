# AA Lab MLB — five-season challenger

Research-only experiment. It does not modify the AA champion, frontend, Worker,
KV, D1, tickets, or production recommendations.

1. `node download_seasons.mjs` downloads final regular-season games for
   2021-2026 from the official, free MLB StatsAPI.
2. `python3 run_five_season_study.py` builds strictly pregame features, selects
   a fixed challenger family using rolling 2022-2025 season holdouts, and opens
   2026 once as the final exam. It exports the frozen server-side artifact to
   `robot/models/aa_lab_mlb_v1.json`.

The same-date batch guard prevents the first game of a doubleheader from being
used to predict the second game.

Production uses that artifact only through `robot/aa_lab.mjs`. The existing
hourly `adrian-daily` workflow freezes its forward predictions privately and
writes `data/history/aa_lab_forward.json`; neither the frontend nor the public
API receives AA Lab output. A human must approve any future promotion after the
pre-registered forward gate passes.
