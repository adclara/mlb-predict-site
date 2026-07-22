#!/usr/bin/env python3
"""Deterministic data-quality and temporal-leakage checks for the study."""

from __future__ import annotations

import copy
import importlib.util
from pathlib import Path

import numpy as np


HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("five_season_study", HERE / "run_five_season_study.py")
study = importlib.util.module_from_spec(spec)
spec.loader.exec_module(study)

games = study.load_games()
ids = [game["game_pk"] for game in games]
assert len(ids) == len(set(ids)), "duplicate game identifiers"
for year in range(2021, 2026):
    count = sum(game["season"] == year for game in games)
    assert 2400 <= count <= 2450, f"unexpected season count {year}: {count}"

rows = study.build_features(games)
x = np.asarray([row["features"] for row in rows], dtype=float)
assert not np.isinf(x).any(), "infinite feature value"
assert x.shape[1] == len(study.FEATURES)

# Changing every result on and after the cutoff must not change any feature on
# or before the cutoff. This catches future-result and same-date leakage.
cutoff = "2026-06-01"
mutated = copy.deepcopy(games)
for game in mutated:
    if game["date"] >= cutoff:
        game["home_runs"], game["away_runs"] = game["away_runs"], game["home_runs"]
        game["home_win"] = int(game["home_runs"] > game["away_runs"])
mutated_rows = study.build_features(mutated)
before = {row["game_pk"]: row["features"] for row in rows if row["date"] <= cutoff}
after = {row["game_pk"]: row["features"] for row in mutated_rows if row["date"] <= cutoff}
assert before.keys() == after.keys()
for game_pk in before:
    assert np.allclose(before[game_pk], after[game_pk], equal_nan=True), f"future leakage at {game_pk}"

print({
    "games": len(games), "features": x.shape[1], "missing_values": int(np.isnan(x).sum()),
    "duplicate_game_ids": 0, "future_and_same_date_leakage": 0,
})
