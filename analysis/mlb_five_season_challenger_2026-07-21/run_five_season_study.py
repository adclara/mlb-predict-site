#!/usr/bin/env python3
"""Causal five-season AA Lab challenger study.

Research only. Builds pregame team/context features from strictly earlier dates,
selects a challenger on 2022-2025 rolling-season validation, then uses 2026 once
as the untouched final examination. It never changes AA or production files.
"""

from __future__ import annotations

import json
import math
import subprocess
import warnings
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np
from sklearn.ensemble import GradientBoostingClassifier, HistGradientBoostingClassifier, RandomForestClassifier
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, brier_score_loss, log_loss, roc_auc_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler


SEED = 20260721
HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
YEARS = list(range(2021, 2027))
FEATURES = [
    "win5_diff", "win10_diff", "win20_diff",
    "run_diff5", "run_diff10", "run_diff20",
    "runs_for10_diff", "runs_against10_diff", "pyth20_diff",
    "blended_win_diff", "blended_pyth_diff", "split_form_diff",
    "prior_win_diff", "prior_pyth_diff", "elo_diff",
    "rest_diff", "density7_diff", "streak_diff", "h2h_diff",
    "park_runs_factor", "league_runs_environment", "season_progress",
]
COMPACT_FEATURES = [
    "pyth20_diff", "blended_pyth_diff", "split_form_diff", "prior_pyth_diff",
    "elo_diff", "rest_diff", "density7_diff", "streak_diff", "h2h_diff",
    "park_runs_factor", "league_runs_environment", "season_progress",
]
COMPACT_COLUMNS = [FEATURES.index(name) for name in COMPACT_FEATURES]


def safe_mean(values):
    return float(np.mean(values)) if values else np.nan


def pythag(runs_for, runs_against, exponent=1.83):
    if runs_for + runs_against <= 0:
        return np.nan
    a, b = runs_for ** exponent, runs_against ** exponent
    return a / (a + b)


def team_summary(games):
    if not games:
        return {"win": 0.5, "pyth": 0.5, "rf": 4.5, "ra": 4.5, "n": 0}
    wins = sum(game["won"] for game in games)
    rf = sum(game["rf"] for game in games)
    ra = sum(game["ra"] for game in games)
    return {"win": wins / len(games), "pyth": pythag(rf, ra), "rf": rf / len(games), "ra": ra / len(games), "n": len(games)}


def rolling_stats(games, window):
    sample = games[-window:]
    if not sample:
        return {"win": np.nan, "rf": np.nan, "ra": np.nan, "rd": np.nan, "pyth": np.nan}
    rf = sum(game["rf"] for game in sample)
    ra = sum(game["ra"] for game in sample)
    return {
        "win": sum(game["won"] for game in sample) / len(sample),
        "rf": rf / len(sample), "ra": ra / len(sample),
        "rd": (rf - ra) / len(sample), "pyth": pythag(rf, ra),
    }


def day_number(day, season):
    return (date.fromisoformat(day) - date(season, 3, 1)).days


def date_gap(a, b):
    return (date.fromisoformat(a) - date.fromisoformat(b)).days


def load_games():
    rows = []
    for year in YEARS:
        payload = json.loads((HERE / "seasons" / f"{year}.json").read_text())
        for game in payload["games"]:
            game = dict(game)
            game["season"] = year
            game["home_win"] = int(game["home_runs"] > game["away_runs"])
            rows.append(game)
    rows.sort(key=lambda game: (game["date"], game["game_pk"]))
    return rows


def build_features(games, return_initial_state=False):
    output = []
    elo = defaultdict(lambda: 1500.0)
    prior = defaultdict(lambda: {"win": 0.5, "pyth": 0.5, "rf": 4.5, "ra": 4.5, "n": 0})
    park_history = defaultdict(list)
    league_totals = []
    current_season = None
    initial_2026_state = None
    team_games = defaultdict(list)
    h2h = defaultdict(list)

    by_date = defaultdict(list)
    for game in games:
        by_date[game["date"]].append(game)

    for day in sorted(by_date):
        date_games = by_date[day]
        season = date_games[0]["season"]
        if season != current_season:
            if current_season is not None:
                for team, history in team_games.items():
                    prior[team] = team_summary(history)
                for team in list(elo):
                    elo[team] = 1500 + 0.55 * (elo[team] - 1500)
            current_season = season
            team_games = defaultdict(list)
            h2h = defaultdict(list)
            if season == 2026:
                initial_2026_state = {
                    "prior": {team: dict(values) for team, values in prior.items()},
                    "elo": {team: float(value) for team, value in elo.items()},
                    "park_history": {team: values[-100:] for team, values in park_history.items()},
                    "league_totals": league_totals[-500:],
                }

        pending_updates = []
        for game in date_games:
            home, away = game["home"], game["away"]
            hg, ag = team_games[home], team_games[away]
            hs = {window: rolling_stats(hg, window) for window in (5, 10, 20)}
            aps = {window: rolling_stats(ag, window) for window in (5, 10, 20)}
            hp, ap = prior[home], prior[away]

            def blended(history, previous, key, equivalent=20):
                current = team_summary(history)
                count = len(history)
                return (previous[key] * equivalent + current[key] * count) / (equivalent + count)

            home_split = [item["won"] for item in hg if item["at_home"]][-10:]
            away_split = [item["won"] for item in ag if not item["at_home"]][-10:]
            split_diff = safe_mean(home_split) - safe_mean(away_split)
            home_rest = date_gap(day, hg[-1]["date"]) if hg else np.nan
            away_rest = date_gap(day, ag[-1]["date"]) if ag else np.nan
            home_density = sum(date_gap(day, item["date"]) <= 7 for item in hg)
            away_density = sum(date_gap(day, item["date"]) <= 7 for item in ag)

            def streak(history):
                if not history:
                    return 0
                direction = 1 if history[-1]["won"] else -1
                length = 0
                for item in reversed(history):
                    if (1 if item["won"] else -1) != direction:
                        break
                    length += 1
                return direction * min(length, 6)

            series = h2h[tuple(sorted((home, away)))]
            h2h_diff = 0
            for item in series:
                h2h_diff += 1 if item["winner"] == home else -1
            h2h_diff = max(-4, min(4, h2h_diff))
            park_sample = park_history[home][-100:]
            league_sample = league_totals[-500:]
            league_mean = safe_mean(league_sample)
            park_mean = safe_mean(park_sample)
            park_factor = park_mean / league_mean if np.isfinite(park_mean) and np.isfinite(league_mean) and league_mean else np.nan

            values = [
                hs[5]["win"] - aps[5]["win"], hs[10]["win"] - aps[10]["win"], hs[20]["win"] - aps[20]["win"],
                hs[5]["rd"] - aps[5]["rd"], hs[10]["rd"] - aps[10]["rd"], hs[20]["rd"] - aps[20]["rd"],
                hs[10]["rf"] - aps[10]["rf"], hs[10]["ra"] - aps[10]["ra"], hs[20]["pyth"] - aps[20]["pyth"],
                blended(hg, hp, "win") - blended(ag, ap, "win"),
                blended(hg, hp, "pyth") - blended(ag, ap, "pyth"), split_diff,
                hp["win"] - ap["win"], hp["pyth"] - ap["pyth"], (elo[home] - elo[away]) / 100,
                np.clip(home_rest, 0, 7) - np.clip(away_rest, 0, 7) if np.isfinite(home_rest) and np.isfinite(away_rest) else np.nan,
                away_density - home_density, streak(hg) - streak(ag), h2h_diff,
                park_factor, league_mean / 2 if np.isfinite(league_mean) else np.nan, day_number(day, season) / 220,
            ]
            output.append({**game, "features": values, "history_home": len(hg), "history_away": len(ag)})
            pending_updates.append(game)

        # Same-date results are applied only after every game on the date has
        # received its features, preventing doubleheader leakage.
        elo_before = dict(elo)
        elo_changes = defaultdict(float)
        for game in sorted(pending_updates, key=lambda item: (str(item.get("start")), item["game_pk"])):
            home, away = game["home"], game["away"]
            home_win = game["home_win"]
            home_elo = elo_before.get(home, 1500.0)
            away_elo = elo_before.get(away, 1500.0)
            home_expectation = 1 / (1 + 10 ** (-((home_elo + 30) - away_elo) / 400))
            change = 20 * (home_win - home_expectation)
            elo_changes[home] += change
            elo_changes[away] -= change
            team_games[home].append({"date": day, "won": home_win, "rf": game["home_runs"], "ra": game["away_runs"], "at_home": True})
            team_games[away].append({"date": day, "won": 1 - home_win, "rf": game["away_runs"], "ra": game["home_runs"], "at_home": False})
            h2h[tuple(sorted((home, away)))].append({"winner": home if home_win else away})
            total = game["home_runs"] + game["away_runs"]
            park_history[home].append(total)
            league_totals.append(total)
        for team, change in elo_changes.items():
            elo[team] += change
    if return_initial_state:
        return output, initial_2026_state
    return output


def expected_calibration_error(y, probabilities, bins=10):
    total = 0.0
    for low in np.linspace(0, 1, bins, endpoint=False):
        high = low + 1 / bins
        mask = (probabilities >= low) & (probabilities < (high if high < 1 else 1.000001))
        if mask.sum():
            total += mask.mean() * abs(probabilities[mask].mean() - y[mask].mean())
    return float(total)


def metrics(y, p):
    return {
        "n": int(len(y)), "accuracy": float(accuracy_score(y, p >= 0.5)),
        "log_loss": float(log_loss(y, p)), "brier": float(brier_score_loss(y, p)),
        "auc": float(roc_auc_score(y, p)), "ece": expected_calibration_error(y, p),
    }


def factories():
    compact = lambda: ColumnTransformer([("keep", "passthrough", COMPACT_COLUMNS)], remainder="drop")
    return {
        "logit_equal": (lambda: make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), LogisticRegression(C=0.1, max_iter=2000)), None, FEATURES),
        "logit_recent_2y": (lambda: make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), LogisticRegression(C=0.1, max_iter=2000)), 730, FEATURES),
        "logit_compact_equal": (lambda: make_pipeline(compact(), SimpleImputer(strategy="median"), StandardScaler(), LogisticRegression(C=0.1, max_iter=2000)), None, COMPACT_FEATURES),
        "logit_compact_recent_2y": (lambda: make_pipeline(compact(), SimpleImputer(strategy="median"), StandardScaler(), LogisticRegression(C=0.1, max_iter=2000)), 730, COMPACT_FEATURES),
        "rf_equal": (lambda: make_pipeline(SimpleImputer(strategy="median"), RandomForestClassifier(n_estimators=300, max_depth=5, min_samples_leaf=35, max_features=0.7, random_state=SEED, n_jobs=1)), None, FEATURES),
        "rf_recent_2y": (lambda: make_pipeline(SimpleImputer(strategy="median"), RandomForestClassifier(n_estimators=300, max_depth=5, min_samples_leaf=35, max_features=0.7, random_state=SEED, n_jobs=1)), 730, FEATURES),
        "hist_gbdt_equal": (lambda: make_pipeline(SimpleImputer(strategy="median"), HistGradientBoostingClassifier(max_iter=180, learning_rate=0.035, max_leaf_nodes=9, min_samples_leaf=40, l2_regularization=8, random_state=SEED)), None, FEATURES),
        "hist_gbdt_recent_2y": (lambda: make_pipeline(SimpleImputer(strategy="median"), HistGradientBoostingClassifier(max_iter=180, learning_rate=0.035, max_leaf_nodes=9, min_samples_leaf=40, l2_regularization=8, random_state=SEED)), 730, FEATURES),
        "gbdt_recent_2y": (lambda: make_pipeline(SimpleImputer(strategy="median"), GradientBoostingClassifier(n_estimators=140, learning_rate=0.025, max_depth=2, min_samples_leaf=35, subsample=0.8, random_state=SEED)), 730, FEATURES),
    }


def weights_for(train_dates, reference_year, half_life):
    if half_life is None:
        return None
    ref = date(reference_year, 1, 1)
    age = np.array([(ref - date.fromisoformat(value)).days for value in train_dates], dtype=float)
    return np.maximum(0.05, 0.5 ** (age / half_life))


def fit_model(model, x, y, sample_weight):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        if sample_weight is None:
            model.fit(x, y)
        else:
            last = model.steps[-1][0]
            model.fit(x, y, **{f"{last}__sample_weight": sample_weight})
    return model


def calibrate(oof_y, oof_p, current_p):
    logits = np.log(np.clip(oof_p, 1e-4, 1 - 1e-4) / (1 - np.clip(oof_p, 1e-4, 1 - 1e-4))).reshape(-1, 1)
    calibration = LogisticRegression(C=1000, max_iter=2000).fit(logits, oof_y)
    now = np.log(np.clip(current_p, 1e-4, 1 - 1e-4) / (1 - np.clip(current_p, 1e-4, 1 - 1e-4))).reshape(-1, 1)
    return calibration.predict_proba(now)[:, 1], {"slope": float(calibration.coef_[0, 0]), "intercept": float(calibration.intercept_[0])}


def champion_pairs():
    js = r"""
import fs from 'node:fs'; import path from 'node:path'; import { walkForwardEnsemble } from './robot/learn.js';
let rows=[]; for (const f of fs.readdirSync('data/history/games').filter(x=>x.endsWith('.json')).sort()) rows.push(...(JSON.parse(fs.readFileSync(path.join('data/history/games',f),'utf8')).games||[]));
const run=walkForwardEnsemble(rows,{market:'ml',minTrain:100,lambda:1});
console.log(JSON.stringify(run._pairs.rows.map((r,i)=>({game_pk:String(r.game_pk),date:run._pairs.dates[i],y:run._pairs.y[i],p:run._pairs.combined[i]}))));
"""
    return json.loads(subprocess.check_output(["node", "--input-type=module", "-e", js], cwd=REPO, text=True))


def date_bootstrap(y, reference, challenger, dates, repetitions=2000):
    rng = np.random.default_rng(SEED)
    blocks = [np.where(dates == day)[0] for day in sorted(set(dates))]
    values = defaultdict(list)
    for _ in range(repetitions):
        sample = np.concatenate([blocks[i] for i in rng.integers(0, len(blocks), len(blocks))])
        yy, rr, cc = y[sample], reference[sample], challenger[sample]
        values["accuracy"].append(accuracy_score(yy, cc >= 0.5) - accuracy_score(yy, rr >= 0.5))
        values["log_loss"].append(log_loss(yy, cc) - log_loss(yy, rr))
        values["brier"].append(brier_score_loss(yy, cc) - brier_score_loss(yy, rr))
    return {key: {"mean": float(np.mean(vals)), "ci95": [float(np.quantile(vals, 0.025)), float(np.quantile(vals, 0.975))]} for key, vals in values.items()}


def top_two(y, p, dates):
    selected = []
    for day in sorted(set(dates)):
        indices = np.where(dates == day)[0]
        selected.extend(indices[np.argsort(-np.abs(p[indices] - 0.5))][:2])
    selected = np.asarray(selected, dtype=int)
    wins = int(np.sum((p[selected] >= 0.5) == y[selected]))
    n = int(len(selected))
    if not n:
        interval = [None, None]
    else:
        z, rate = 1.96, wins / n
        denominator = 1 + z * z / n
        center = (rate + z * z / (2 * n)) / denominator
        radius = z * math.sqrt(rate * (1 - rate) / n + z * z / (4 * n * n)) / denominator
        interval = [max(0, center - radius), min(1, center + radius)]
    return {"n": n, "wins": wins, "rate": wins / n if n else None, "ci95": interval}


def main():
    games = load_games()
    rows, initial_2026_state = build_features(games, return_initial_state=True)
    x = np.asarray([row["features"] for row in rows], dtype=float)
    y = np.asarray([row["home_win"] for row in rows], dtype=int)
    seasons = np.asarray([row["season"] for row in rows], dtype=int)
    dates = np.asarray([row["date"] for row in rows])
    game_ids = np.asarray([row["game_pk"] for row in rows])

    validation = {}
    oof_store = {}
    for name, (factory, half_life, _) in factories().items():
        fold_rows, all_y, all_p = {}, [], []
        for holdout in (2022, 2023, 2024, 2025):
            train = seasons < holdout
            test = seasons == holdout
            model = fit_model(factory(), x[train], y[train], weights_for(dates[train], holdout, half_life))
            p = np.clip(model.predict_proba(x[test])[:, 1], 1e-4, 1 - 1e-4)
            fold_rows[str(holdout)] = metrics(y[test], p)
            all_y.extend(y[test]); all_p.extend(p)
        all_y, all_p = np.asarray(all_y), np.asarray(all_p)
        validation[name] = {"pooled": metrics(all_y, all_p), "by_season": fold_rows}
        oof_store[name] = (all_y, all_p)

    selected = min(validation, key=lambda name: validation[name]["pooled"]["log_loss"])
    final_models, final_probabilities, calibrators = {}, {}, {}
    train, test = seasons < 2026, seasons == 2026
    for name, (factory, half_life, _) in factories().items():
        model = fit_model(factory(), x[train], y[train], weights_for(dates[train], 2026, half_life))
        raw = np.clip(model.predict_proba(x[test])[:, 1], 1e-4, 1 - 1e-4)
        calibrated, calibration = calibrate(*oof_store[name], raw)
        final_models[name] = model
        final_probabilities[name] = calibrated
        calibrators[name] = calibration

    final_results = {name: {"metrics": metrics(y[test], p), "top_two": top_two(y[test], p, dates[test])} for name, p in final_probabilities.items()}
    home_rate = float(np.mean(y[train]))
    baseline = np.full(int(np.sum(test)), home_rate)
    final_results["home_baseline"] = {"metrics": metrics(y[test], baseline), "top_two": top_two(y[test], baseline, dates[test])}

    selected_p = final_probabilities[selected]
    by_id = {game_id: (probability, outcome, day) for game_id, probability, outcome, day in zip(game_ids[test], selected_p, y[test], dates[test])}
    aa = [row for row in champion_pairs() if row["game_pk"] in by_id]
    aa_y = np.asarray([row["y"] for row in aa], dtype=int)
    aa_p = np.asarray([row["p"] for row in aa], dtype=float)
    challenger_p = np.asarray([by_id[row["game_pk"]][0] for row in aa], dtype=float)
    aa_dates = np.asarray([row["date"] for row in aa])

    selected_estimator = final_models[selected].steps[-1][1]
    selected_features = factories()[selected][2]
    importance = None
    if hasattr(selected_estimator, "feature_importances_"):
        importance = sorted(
            ({"feature": feature, "importance": float(value)} for feature, value in zip(selected_features, selected_estimator.feature_importances_)),
            key=lambda item: item["importance"], reverse=True,
        )
    elif hasattr(selected_estimator, "coef_"):
        importance = sorted(
            ({"feature": feature, "coefficient_standardized": float(value), "absolute": abs(float(value))} for feature, value in zip(selected_features, selected_estimator.coef_[0])),
            key=lambda item: item["absolute"], reverse=True,
        )

    agreement = (aa_p >= 0.5) == (challenger_p >= 0.5)
    agreement_summary = {
        "n": int(agreement.sum()), "share": float(agreement.mean()),
        "challenger_accuracy": float(accuracy_score(aa_y[agreement], challenger_p[agreement] >= 0.5)),
        "aa_accuracy": float(accuracy_score(aa_y[agreement], aa_p[agreement] >= 0.5)),
        "challenger_top_two": top_two(aa_y[agreement], challenger_p[agreement], aa_dates[agreement]),
    }

    validation_mask = (seasons >= 2022) & (seasons <= 2025)
    validation_dates = dates[validation_mask]
    selected_validation_y, selected_validation_p = oof_store[selected]
    equal_validation_y, equal_validation_p = oof_store["logit_equal"]
    assert np.array_equal(selected_validation_y, equal_validation_y)
    selection_delta = date_bootstrap(
        selected_validation_y, equal_validation_p, selected_validation_p, validation_dates
    )

    counts = {str(year): int(np.sum(seasons == year)) for year in YEARS}
    duplicate_ids = len(game_ids) - len(set(game_ids.tolist()))
    output = {
        "study": {
            "name": "AA Lab MLB five-season challenger", "policy": "research_only_no_champion_change",
            "selection_period": "rolling season holdouts 2022-2025", "final_exam": "2026 untouched until model selection",
            "primary_metric": "log_loss", "generated_at": "2026-07-21",
        },
        "data": {
            "source": "official MLB StatsAPI regular-season final games", "games": len(rows), "by_season": counts,
            "first_date": min(dates.tolist()), "last_date": max(dates.tolist()), "duplicate_game_ids": duplicate_ids,
            "feature_count": len(FEATURES), "features": FEATURES,
            "limitations": ["No historical auditable odds", "No historical confirmed lineups", "No historical pregame weather", "No starting-pitcher or Statcast block in this challenger"],
        },
        "validation_2022_2025": validation,
        "selection": {
            "model": selected,
            "reason": "lowest pooled rolling-season validation log loss before viewing 2026",
            "delta_vs_logit_equal": selection_delta,
        },
        "final_2026": {
            "models": final_results, "calibrators": calibrators,
            "selected_delta_vs_home_baseline": date_bootstrap(y[test], baseline, selected_p, dates[test]),
        },
        "champion_overlap": {
            "n": len(aa), "dates": len(set(aa_dates.tolist())),
            "aa": {"metrics": metrics(aa_y, aa_p), "top_two": top_two(aa_y, aa_p, aa_dates)},
            "challenger": {"metrics": metrics(aa_y, challenger_p), "top_two": top_two(aa_y, challenger_p, aa_dates)},
            "direction_agreement": agreement_summary,
            "delta_challenger_minus_aa": date_bootstrap(aa_y, aa_p, challenger_p, aa_dates),
        },
        "selected_feature_effects": importance,
        "gate": {
            "publish": False,
            "rule": "AA remains champion; challenger may enter forward shadow only if final 2026 proper scores and uncertainty justify it",
        },
    }
    (HERE / "results.json").write_text(json.dumps(output, indent=2))

    selected_pipeline = final_models[selected]
    imputer = next(step for _, step in selected_pipeline.steps if isinstance(step, SimpleImputer))
    scaler = next(step for _, step in selected_pipeline.steps if isinstance(step, StandardScaler))
    classifier = next(step for _, step in selected_pipeline.steps if isinstance(step, LogisticRegression))
    selected_features = factories()[selected][2]
    model_artifact = {
        "schema": "aa_lab_mlb_shadow_v1",
        "version": "aa_lab_mlb_v1",
        "status": "shadow_only",
        "published": False,
        "trained_seasons": [2021, 2022, 2023, 2024, 2025],
        "trained_through": max(row["date"] for row in rows if row["season"] == 2025),
        "selection_period": "rolling season holdouts 2022-2025",
        "primary_metric": "log_loss",
        "model": selected,
        "recency_half_life_days": factories()[selected][1],
        "features": selected_features,
        "imputer_medians": [float(value) for value in imputer.statistics_],
        "scaler_mean": [float(value) for value in scaler.mean_],
        "scaler_scale": [float(value) for value in scaler.scale_],
        "coefficients": [float(value) for value in classifier.coef_[0]],
        "intercept": float(classifier.intercept_[0]),
        "platt": calibrators[selected],
        "validation": validation[selected]["pooled"],
        "holdout_2026": final_results[selected]["metrics"],
        "initial_2026_state": initial_2026_state,
        "selection_policy": {
            "version": "aa_lab_top2_abs_margin_v1",
            "max_per_day": 2,
            "rule": "largest absolute calibrated probability distance from 0.5",
            "public": False,
        },
    }
    model_path = REPO / "robot/models/aa_lab_mlb_v1.json"
    model_path.parent.mkdir(parents=True, exist_ok=True)
    model_path.write_text(json.dumps(model_artifact, indent=2))
    print(json.dumps({
        "selected": selected, "validation": validation[selected]["pooled"],
        "final_2026": final_results[selected], "champion_overlap": output["champion_overlap"],
    }, indent=2))


if __name__ == "__main__":
    main()
