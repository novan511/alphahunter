#!/usr/bin/env python3
"""Train XGBoost model for RS decoupling prediction.

Exports model to JSON for pure-TypeScript inference on Vercel.
Runs in GitHub Actions (free tier). No Python runtime needed at inference.
"""

import argparse
import json
import math
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import requests
import xgboost as xgb

BINANCE_BASE = os.environ.get("BINANCE_BASE_URL", "https://data-api.binance.vision")
BINANCE_MAX_LIMIT = 1000
GATES = {
    "oos_sharpe_min": float(os.environ.get("ML_GATE_SHARPE_MIN", "0.5")),
    "oos_maxdd_max": float(os.environ.get("ML_GATE_MAXDD_MAX", "0.20")),
    "oos_pf_min": float(os.environ.get("ML_GATE_PF_MIN", "1.05")),
}


def fetch_klines(symbol: str, interval: str, limit: int) -> list[dict]:
    """Fetch klines from Binance, paginated if needed."""
    all_candles = []
    end_time = None
    remaining = limit

    while remaining > 0:
        batch = min(remaining, BINANCE_MAX_LIMIT)
        params = {
            "symbol": symbol.upper(),
            "interval": interval,
            "limit": batch,
        }
        if end_time:
            params["endTime"] = end_time

        resp = requests.get(
            f"{BINANCE_BASE}/api/v3/klines",
            params=params,
            headers={"User-Agent": "althunter-ml-train/1.0"},
            timeout=30,
        )
        if resp.status_code != 200:
            raise RuntimeError(f"Binance API error {resp.status_code}: {resp.text[:200]}")

        data = resp.json()
        if not data:
            break

        for row in data:
            all_candles.append({
                "time": int(row[0]) // 1000,
                "open": float(row[1]),
                "high": float(row[2]),
                "low": float(row[3]),
                "close": float(row[4]),
                "volume": float(row[5]),
            })

        end_time = int(data[0][0]) - 1
        remaining -= len(data)

        if len(data) < batch:
            break

    all_candles.sort(key=lambda c: c["time"])
    return all_candles


def sma(values: list[float], period: int) -> list[float]:
    out = []
    for i in range(len(values)):
        if i < period - 1:
            out.append(float("nan"))
        else:
            out.append(sum(values[i - period + 1 : i + 1]) / period)
    return out


def std_dev(values: list[float], period: int) -> list[float]:
    out = []
    for i in range(len(values)):
        if i < period - 1:
            out.append(float("nan"))
        else:
            window = values[i - period + 1 : i + 1]
            mean = sum(window) / period
            var = sum((x - mean) ** 2 for x in window) / period
            out.append(math.sqrt(var))
    return out


def atr(candles: list[dict], period: int) -> list[float]:
    tr = []
    for i, c in enumerate(candles):
        if i == 0:
            tr.append(c["high"] - c["low"])
        else:
            prev_close = candles[i - 1]["close"]
            tr.append(max(
                c["high"] - c["low"],
                abs(c["high"] - prev_close),
                abs(c["low"] - prev_close),
            ))
    out = []
    for i in range(len(tr)):
        if i < period - 1:
            out.append(float("nan"))
        elif i == period - 1:
            out.append(sum(tr[:period]) / period)
        else:
            out.append((out[i - 1] * (period - 1) + tr[i]) / period)
    return out


def rolling_return(closes: list[float], period: int) -> list[float]:
    out = []
    for i in range(len(closes)):
        if i < period:
            out.append(0.0)
        else:
            out.append((closes[i] - closes[i - period]) / closes[i - period])
    return out


def compute_features(
    asset_candles: list[dict],
    index_candles: list[dict],
    rs_period: int = 20,
) -> pd.DataFrame:
    """Build feature DataFrame matching lib/ml/features.ts exactly."""
    n = min(len(asset_candles), len(index_candles))
    asset = asset_candles[-n:]
    index_ = index_candles[-n:]

    closes = [c["close"] for c in asset]
    highs = [c["high"] for c in asset]
    lows = [c["low"] for c in asset]
    volumes = [c["volume"] for c in asset]
    index_closes = [c["close"] for c in index_]

    # RS line: asset close / index close (aligned by position)
    rs_line = [a / i if i != 0 else 1.0 for a, i in zip(closes, index_closes)]

    # RS MA and std
    rs_ma = sma(rs_line, rs_period)
    rs_std = std_dev(rs_line, rs_period)

    # RS Z-score
    rs_zscore = []
    for i in range(n):
        if math.isnan(rs_ma[i]) or math.isnan(rs_std[i]) or rs_std[i] == 0:
            rs_zscore.append(0.0)
        else:
            rs_zscore.append((rs_line[i] - rs_ma[i]) / rs_std[i])

    # RS momentum
    rs_momentum = [0.0] + [rs_line[i] - rs_line[i - 1] for i in range(1, n)]

    # Asset returns (lookback 6)
    lookback = 6
    asset_returns = [0.0] * lookback + [
        (closes[i] - closes[i - lookback]) / closes[i - lookback]
        for i in range(lookback, n)
    ]

    # Volume ratio vs prior window MA (exclude current bar)
    vol_ma_prior = []
    vol_period = 20
    for i in range(n):
        if i < vol_period:
            vol_ma_prior.append(float("nan"))
        else:
            vol_ma_prior.append(sum(volumes[i - vol_period : i]) / vol_period)

    volume_ratio = []
    for i in range(n):
        if math.isnan(vol_ma_prior[i]) or vol_ma_prior[i] == 0:
            volume_ratio.append(1.0)
        else:
            volume_ratio.append(volumes[i] / vol_ma_prior[i])

    # ATR
    atr_series = atr(asset_candles, 14)
    atr_pct = [
        (atr_series[i] / closes[i] * 100) if (not math.isnan(atr_series[i]) and closes[i] > 0) else 0.0
        for i in range(n)
    ]

    # BTC regime: 20-bar return of index
    btc_regime = [0.0] * 20 + [
        (index_closes[i] - index_closes[i - 20]) / index_closes[i - 20]
        for i in range(20, n)
    ]

    # Momentum lookbacks [5, 20, 60]
    mom_5 = rolling_return(closes, 5)
    mom_20 = rolling_return(closes, 20)
    mom_60 = rolling_return(closes, 60)

    # SMA of close (trend filter)
    sma_close = sma(closes, 20)

    rows = []
    for i in range(n):
        rows.append({
            "time": asset[i]["time"],
            "close": closes[i],
            "rs": rs_line[i],
            "rs_zscore": rs_zscore[i],
            "rs_momentum": rs_momentum[i],
            "asset_return_6": asset_returns[i],
            "volume_ratio": volume_ratio[i],
            "atr_pct": atr_pct[i],
            "btc_regime_20": btc_regime[i],
            "mom_5": mom_5[i],
            "mom_20": mom_20[i],
            "mom_60": mom_60[i],
            "close_over_sma20": (closes[i] / sma_close[i] - 1.0) if not math.isnan(sma_close[i]) else 0.0,
        })

    return pd.DataFrame(rows)


def build_target(df: pd.DataFrame, forward_bars: int = 1) -> pd.Series:
    """Target: forward log-return of close."""
    closes = df["close"].values
    target = []
    for i in range(len(closes)):
        if i + forward_bars < len(closes) and closes[i] > 0 and closes[i + forward_bars] > 0:
            target.append(math.log(closes[i + forward_bars] / closes[i]))
        else:
            target.append(float("nan"))
    return pd.Series(target, index=df.index)


def walk_forward_oos(
    X: pd.DataFrame,
    y: pd.Series,
    n_windows: int = 3,
    warmup_frac: float = 0.25,
) -> dict:
    """Anchored expanding walk-forward. Returns OOS aggregate metrics."""
    n = len(X)
    if n < 80:
        return {
            "oos_sharpe": 0.0,
            "oos_maxdd": 0.0,
            "oos_pf": 0.0,
            "oos_winrate": 0.0,
            "oos_trades": 0,
            "windows": [],
        }

    warmup = int(n * warmup_frac)
    rest = n - warmup
    chunk = rest // n_windows

    window_results = []
    oos_returns_all = []

    for w in range(n_windows):
        oos_start = warmup + w * chunk
        oos_end = n - 1 if w == n_windows - 1 else warmup + (w + 1) * chunk - 1
        if oos_end - oos_start < 10:
            continue

        is_end = oos_start - 1
        if is_end < 10:
            continue

        X_is = X.iloc[: is_end + 1]
        y_is = y.iloc[: is_end + 1]
        X_oos = X.iloc[oos_start : oos_end + 1]
        y_oos = y.iloc[oos_start : oos_end + 1]

        # Train on in-sample
        model = xgb.XGBRegressor(
            objective="reg:squarederror",
            max_depth=4,
            n_estimators=100,
            learning_rate=0.1,
            subsample=0.8,
            colsample_bytree=0.8,
            random_state=42,
            n_jobs=1,
            verbosity=0,
        )
        model.fit(X_is, y_is)

        # Predict OOS
        y_pred = model.predict(X_oos)

        # Convert predictions to simple long-only signal: predict positive return -> long
        signal = (y_pred > 0).astype(int)
        actual_returns = y_oos.values

        # Strategy return: signal * actual return (long only, no short)
        strat_returns = signal * actual_returns

        # Equity curve
        equity = [1.0]
        for r in strat_returns:
            equity.append(equity[-1] * (1 + r))

        # Metrics
        returns_arr = np.array(strat_returns)
        mean_ret = np.mean(returns_arr)
        std_ret = np.std(returns_arr)
        sharpe = (mean_ret / std_ret * math.sqrt(365 * 6)) if std_ret > 0 else 0.0  # 4h bars/year

        # Max drawdown
        peak = equity[0]
        maxdd = 0.0
        for eq in equity:
            if eq > peak:
                peak = eq
            dd = (peak - eq) / peak
            if dd > maxdd:
                maxdd = dd

        # Profit factor
        gross_profit = sum(r for r in strat_returns if r > 0)
        gross_loss = abs(sum(r for r in strat_returns if r < 0))
        pf = gross_profit / gross_loss if gross_loss > 0 else (float("inf") if gross_profit > 0 else 0.0)

        win_rate = sum(1 for r in strat_returns if r > 0) / len(strat_returns) if strat_returns.size > 0 else 0.0

        window_results.append({
            "window": w + 1,
            "is_start": 0,
            "is_end": int(is_end),
            "oos_start": int(oos_start),
            "oos_end": int(oos_end),
            "oos_sharpe": float(sharpe),
            "oos_maxdd": float(maxdd),
            "oos_pf": float(pf) if math.isfinite(pf) else 0.0,
            "oos_winrate": float(win_rate),
            "oos_trades": int(len(strat_returns)),
        })
        oos_returns_all.extend(strat_returns.tolist())

    # Aggregate OOS
    if oos_returns_all:
        arr = np.array(oos_returns_all)
        mean_ret = np.mean(arr)
        std_ret = np.std(arr)
        oos_sharpe = (mean_ret / std_ret * math.sqrt(365 * 6)) if std_ret > 0 else 0.0

        equity = [1.0]
        for r in oos_returns_all:
            equity.append(equity[-1] * (1 + r))
        peak = equity[0]
        oos_maxdd = 0.0
        for eq in equity:
            if eq > peak:
                peak = eq
            dd = (peak - eq) / peak
            if dd > oos_maxdd:
                oos_maxdd = dd

        gross_profit = sum(r for r in oos_returns_all if r > 0)
        gross_loss = abs(sum(r for r in oos_returns_all if r < 0))
        oos_pf = gross_profit / gross_loss if gross_loss > 0 else (float("inf") if gross_profit > 0 else 0.0)
        oos_winrate = sum(1 for r in oos_returns_all if r > 0) / len(oos_returns_all)
        oos_trades = len(oos_returns_all)
    else:
        oos_sharpe = 0.0
        oos_maxdd = 0.0
        oos_pf = 0.0
        oos_winrate = 0.0
        oos_trades = 0

    return {
        "oos_sharpe": float(oos_sharpe),
        "oos_maxdd": float(oos_maxdd),
        "oos_pf": float(oos_pf) if math.isfinite(oos_pf) else 0.0,
        "oos_winrate": float(oos_winrate),
        "oos_trades": int(oos_trades),
        "windows": window_results,
    }


def train_final_model(X: pd.DataFrame, y: pd.DataFrame) -> xgb.XGBRegressor:
    """Train final model on all data."""
    model = xgb.XGBRegressor(
        objective="reg:squarederror",
        max_depth=4,
        n_estimators=100,
        learning_rate=0.1,
        subsample=0.8,
        colsample_bytree=0.8,
        random_state=42,
        n_jobs=1,
        verbosity=0,
    )
    model.fit(X, y)
    return model


def export_model_json(model: xgb.XGBRegressor, feature_names: list[str]) -> dict:
    """Export XGBoost model to JSON-compatible dict for TS inference."""
    booster = model.get_booster()
    json_str = booster.save_raw() if hasattr(booster, "save_raw") else booster.get_dump(with_stats=True)
    # Use get_dump for text format, then parse into our simple structure
    dump = booster.get_dump(with_stats=True)
    trees = []
    for tree_text in dump:
        trees.append(parse_xgb_dump(tree_text))
    return {
        "feature_names": feature_names,
        "num_trees": len(trees),
        "trees": trees,
        "base_score": float(booster.attr("base_score") or 0.5),
        "objective": "reg:squarederror",
    }


def parse_xgb_dump(dump_text: str) -> dict:
    """Parse XGBoost text dump into nested node structure."""
    lines = dump_text.strip().split("\n")
    nodes = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        # Format: 0:[f0<2.5] yes=1,no=2,missing=1, gain=0.123, cover=45.6
        # or: 0:leaf=0.5
        node_id_str, rest = line.split(":", 1)
        node_id = int(node_id_str)

        if rest.startswith("leaf"):
            # Leaf node
            leaf_val = float(rest.split("=")[1].split(",")[0])
            nodes.append({
                "nodeid": node_id,
                "leaf": leaf_val,
            })
        else:
            # Split node
            # Extract feature
            feat_part = rest.split("[")[1].split("]")[0]
            # f0 -> 0
            feature_idx = int(feat_part.replace("f", ""))

            # Extract threshold
            thr_str = rest.split("<")[1].split("]")[0]
            threshold = float(thr_str)

            # Extract yes/no/missing
            yes = int(rest.split("yes=")[1].split(",")[0])
            no = int(rest.split("no=")[1].split(",")[0])
            missing = int(rest.split("missing=")[1].split(",")[0])

            nodes.append({
                "nodeid": node_id,
                "feature": feature_idx,
                "threshold": threshold,
                "yes": yes,
                "no": no,
                "missing": missing,
            })

    return {"nodes": nodes, "root": 0}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", required=True, help="Asset symbol, e.g. ETHUSDT")
    parser.add_argument("--interval", required=True, help="Candle interval, e.g. 4h")
    parser.add_argument("--lookback", type=int, default=1000, help="Number of candles to fetch")
    args = parser.parse_args()

    symbol = args.symbol.upper()
    interval = args.interval
    lookback = args.lookback

    print(f"[train] Fetching {symbol} {interval} candles (limit={lookback})")
    asset_candles = fetch_klines(symbol, interval, lookback)
    if len(asset_candles) < 80:
        print(f"[train] ERROR: insufficient data ({len(asset_candles)} candles)")
        sys.exit(1)

    print(f"[train] Fetching BTCUSDT {interval} candles (benchmark)")
    index_candles = fetch_klines("BTCUSDT", interval, lookback)
    if len(index_candles) < 80:
        print(f"[train] ERROR: insufficient BTC data ({len(index_candles)} candles)")
        sys.exit(1)

    print("[train] Computing features")
    df = compute_features(asset_candles, index_candles)
    df["target"] = build_target(df, forward_bars=1)

    # Drop rows with NaN target or NaN features
    feature_cols = [
        "rs_zscore", "rs_momentum", "asset_return_6", "volume_ratio",
        "atr_pct", "btc_regime_20", "mom_5", "mom_20", "mom_60", "close_over_sma20",
    ]
    df_clean = df.dropna(subset=feature_cols + ["target"]).copy()
    if len(df_clean) < 80:
        print(f"[train] ERROR: insufficient clean data ({len(df_clean)} rows)")
        sys.exit(1)

    X = df_clean[feature_cols]
    y = df_clean["target"]

    print(f"[train] Running walk-forward OOS (n={len(X)})")
    oos = walk_forward_oos(X, y, n_windows=3)
    print(f"[train] OOS Sharpe={oos['oos_sharpe']:.3f} MaxDD={oos['oos_maxdd']:.3%} PF={oos['oos_pf']:.3f} WinRate={oos['oos_winrate']:.3%} Trades={oos['oos_trades']}")

    # Gates
    passed = True
    if oos["oos_sharpe"] < GATES["oos_sharpe_min"]:
        print(f"[train] GATE FAIL: OOS Sharpe {oos['oos_sharpe']:.3f} < {GATES['oos_sharpe_min']}")
        passed = False
    if oos["oos_maxdd"] > GATES["oos_maxdd_max"]:
        print(f"[train] GATE FAIL: OOS MaxDD {oos['oos_maxdd']:.3%} > {GATES['oos_maxdd_max']:.0%}")
        passed = False
    if oos["oos_pf"] < GATES["oos_pf_min"]:
        print(f"[train] GATE FAIL: OOS PF {oos['oos_pf']:.3f} < {GATES['oos_pf_min']}")
        passed = False

    if not passed:
        print("[train] Model rejected by OOS gates. Not exporting.")
        sys.exit(1)

    print("[train] Training final model on all data")
    model = train_final_model(X, y)

    # Feature importances
    importance = model.get_booster().get_score(importance_type="gain")
    feature_importance = {f: float(importance.get(f, 0.0)) for f in feature_cols}

    print("[train] Exporting model to JSON")
    model_json = export_model_json(model, feature_cols)

    # Write artifacts
    out_dir = Path("ml/models")
    out_dir.mkdir(parents=True, exist_ok=True)

    model_path = out_dir / f"{symbol}_{interval}.json"
    meta_path = out_dir / f"{symbol}_{interval}.meta.json"

    with open(model_path, "w") as f:
        json.dump(model_json, f, indent=2)

    meta = {
        "symbol": symbol,
        "interval": interval,
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "lookback": lookback,
        "forward_bars": 1,
        "feature_cols": feature_cols,
        "feature_importance": feature_importance,
        "oos_metrics": oos,
        "gates_passed": True,
        "model_type": "xgboost_reg_squarederror",
        "base_score": model_json["base_score"],
    }
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)

    print(f"[train] Model saved to {model_path}")
    print(f"[train] Meta saved to {meta_path}")
    print("[train] Done.")


if __name__ == "__main__":
    main()
