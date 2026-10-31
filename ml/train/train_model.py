#!/usr/bin/env python3
"""Train XGBoost model for RS decoupling prediction — LONG + SHORT, leverage, professional RR.

Improvements:
- Multi-bar target (forward N bars return)
- Regime filter (BTC trend alignment)
- LONG + SHORT signals
- Optional leverage
- Professional Reward:Risk ratio (default 1:2)
- Compounded R position sizing (account grows/shrinks per trade)
- Gates based on expectancy in R

Exports model to JSON for pure-TypeScript inference on Vercel.
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

# Probability calibration scaling: raw log-return * SIGMOID_SCALE -> probability
SIGMOID_SCALE = 300.0


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
    vol_period = 20
    vol_ma_prior = []
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

    # BTC regime: 20-bar return of index (macro trend filter)
    btc_regime_20 = [0.0] * 20 + [
        (index_closes[i] - index_closes[i - 20]) / index_closes[i - 20]
        for i in range(20, n)
    ]

    # BTC regime: 60-bar return (slower trend)
    btc_regime_60 = [0.0] * 60 + [
        (index_closes[i] - index_closes[i - 60]) / index_closes[i - 60]
        for i in range(60, n)
    ]

    # BTC bull filter: 1 if 20-bar return > 0 (bull regime)
    btc_bull_filter = [1.0 if r > 0 else 0.0 for r in btc_regime_20]

    # Momentum lookbacks [5, 20, 60]
    mom_5 = rolling_return(closes, 5)
    mom_20 = rolling_return(closes, 20)
    mom_60 = rolling_return(closes, 60)

    # SMA of close (trend filter)
    sma_close = sma(closes, 20)
    close_over_sma20 = [
        (closes[i] / sma_close[i] - 1.0) if not math.isnan(sma_close[i]) else 0.0
        for i in range(n)
    ]

    # RS trend: is RS line above its own SMA (asset outperforming index trend)
    rs_over_rs_ma = [
        1.0 if (not math.isnan(rs_ma[i]) and rs_line[i] > rs_ma[i]) else 0.0
        for i in range(n)
    ]

    # Volatility regime: ATR percentile vs its own history
    atr_ma = sma(atr_pct, 20)
    atr_regime = [
        1.0 if (not math.isnan(atr_ma[i]) and atr_pct[i] > atr_ma[i]) else 0.0
        for i in range(n)
    ]

    rows = []
    for i in range(n):
        rows.append({
            "time": asset[i]["time"],
            "close": closes[i],
            "rs_zscore": rs_zscore[i],
            "rs_momentum": rs_momentum[i],
            "asset_return_6": asset_returns[i],
            "volume_ratio": volume_ratio[i],
            "atr_pct": atr_pct[i],
            "btc_regime_20": btc_regime_20[i],
            "btc_regime_60": btc_regime_60[i],
            "btc_bull_filter": btc_bull_filter[i],
            "mom_5": mom_5[i],
            "mom_20": mom_20[i],
            "mom_60": mom_60[i],
            "close_over_sma20": close_over_sma20[i],
            "rs_over_rs_ma": rs_over_rs_ma[i],
            "atr_regime": atr_regime[i],
        })

    return pd.DataFrame(rows)


def build_target(df: pd.DataFrame, forward_bars: int = 3) -> pd.Series:
    """Target: forward log-return of close over N bars (reduces noise)."""
    closes = df["close"].values
    target = []
    for i in range(len(closes)):
        if i + forward_bars < len(closes) and closes[i] > 0 and closes[i + forward_bars] > 0:
            target.append(math.log(closes[i + forward_bars] / closes[i]))
        else:
            target.append(float("nan"))
    return pd.Series(target, index=df.index)


def apply_regime_filter(df: pd.DataFrame, regime_filter: str = "none") -> pd.DataFrame:
    """Filter rows by regime. 'none' = no filter, 'bull_only' = BTC bull regime only, 'both' = all."""
    if regime_filter in ("none", "both"):
        return df
    if regime_filter == "bull_only":
        return df[df["btc_bull_filter"] == 1.0].copy()
    if regime_filter == "bear_only":
        return df[df["btc_bull_filter"] == 0.0].copy()
    return df


def run_backtest_compounded_r(
    X: pd.DataFrame,
    y: pd.Series,
    close_prices: np.ndarray,
    high_prices: np.ndarray,
    low_prices: np.ndarray,
    initial_capital: float = 1000.0,
    risk_per_trade: float = 0.01,
    stop_loss_atr: float = 2.0,
    take_profit_atr: float = 2.5,
    max_hold_bars: int = 30,
    prob_threshold: float = 0.55,
    leverage: float = 1.0,
    allow_short: bool = True,
    regime_filter: str = 'both',
    fee_rate: float = 0.001,
    slippage: float = 0.0005,
) -> dict:
    """
    Walk-forward backtest with compounded R position sizing.
    
    Position sizing: risk_per_trade * account / stop_distance_price
    Each trade risks R units. Account compounds after each trade.
    Leverage affects margin, not risk (risk stays at risk_per_trade % of account).
    """
    n = len(X)
    if n < 80:
        return {
            "oos_expectancy_r": 0.0,
            "oos_total_return_pct": 0.0,
            "oos_maxdd_pct": 0.0,
            "oos_win_rate": 0.0,
            "oos_profit_factor": 0.0,
            "oos_total_trades": 0,
            "oos_avg_r": 0.0,
            "oos_sharpe": 0.0,
            "windows": [],
        }

    warmup = int(n * 0.25)
    rest = n - warmup
    n_windows = 3
    chunk = rest // n_windows

    window_results = []
    all_r_multiples = []
    all_returns = []
    equity_curve = [initial_capital]
    account = initial_capital

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

        # Train model on in-sample
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

        # Regime filter
        btc_filter = X_oos["btc_bull_filter"].values if "btc_bull_filter" in X_oos.columns else np.ones(len(X_oos))

        # ATR for stop distance
        # We need ATR values; reconstruct from close using simple approximation
        # Use atr_pct feature column (index 4) as proxy for ATR%
        atr_pct_col = X_oos["atr_pct"].values if "atr_pct" in X_oos.columns else np.full(len(X_oos), 2.0)

        # Probability calibration
        scaled = y_pred * SIGMOID_SCALE
        probs = 1 / (1 + np.exp(-np.clip(scaled, -10, 10)))

        # Account tracking for this window
        window_account = account
        window_trades = []
        window_r_multiples = []

        for i in range(len(X_oos)):
            close = close_prices[oos_start + i] if oos_start + i < len(close_prices) else 0
            if close <= 0:
                continue

            atr_pct = atr_pct_col[i] if i < len(atr_pct_col) else 2.0
            atr_abs = close * (atr_pct / 100.0)
            if atr_abs <= 0:
                continue

            prob_up = probs[i] if i < len(probs) else 0.5
            prob_down = 1.0 - prob_up

            # Determine signal
            # Regime filter logic
            if regime_filter == 'none':
                regime_pass_long = True
                regime_pass_short = True
            elif regime_filter == 'bull_only':
                regime_pass_long = btc_filter[i] == 1.0
                regime_pass_short = False
            elif regime_filter == 'bear_only':
                regime_pass_long = False
                regime_pass_short = btc_filter[i] == 0.0
            else:  # both
                regime_pass_long = True
                regime_pass_short = True

            take_long = prob_up > prob_threshold and regime_pass_long
            take_short = allow_short and prob_down > prob_threshold and regime_pass_short

            # Only take one direction per bar
            side = None
            if take_long and prob_up >= prob_down:
                side = "long"
            elif take_short and prob_down > prob_up:
                side = "short"

            if side is None:
                continue

            # Stop distance in price
            stop_dist = stop_loss_atr * atr_abs
            if stop_dist <= 0:
                continue

            # Take profit distance based on RR ratio
            tp_dist = stop_dist * (take_profit_atr / stop_loss_atr)  # RR ratio = TP/SL

            # Position size: risk_per_trade * account / stop_dist
            risk_amount = window_account * risk_per_trade
            qty = risk_amount / stop_dist  # units of asset

            # Simulate trade over max_hold_bars or until SL/TP hit
            entry_price = close * (1 + slippage if side == "long" else 1 - slippage)
            if side == "long":
                stop_price = entry_price - stop_dist
                tp_price = entry_price + tp_dist
            else:
                stop_price = entry_price + stop_dist
                tp_price = entry_price - tp_dist

            exit_price = None
            exit_reason = "time"
            exit_idx = min(i + max_hold_bars, len(X_oos) - 1)

            # Check SL/TP hit in subsequent bars
            for j in range(i + 1, exit_idx + 1):
                abs_j = oos_start + j
                bar_high = float(high_prices[abs_j]) if abs_j < len(high_prices) else close
                bar_low = float(low_prices[abs_j]) if abs_j < len(low_prices) else close

                if side == "long":
                    if bar_low <= stop_price:
                        exit_price = stop_price
                        exit_reason = "sl"
                        break
                    if bar_high >= tp_price:
                        exit_price = tp_price
                        exit_reason = "tp"
                        break
                else:  # short
                    if bar_high >= stop_price:
                        exit_price = stop_price
                        exit_reason = "sl"
                        break
                    if bar_low <= tp_price:
                        exit_price = tp_price
                        exit_reason = "tp"
                        break

            if exit_price is None:
                exit_price = X_oos["close"].values[exit_idx] if "close" in X_oos.columns else entry_price
                exit_reason = "time"

            # Calculate PnL
            if side == "long":
                gross_pnl = qty * (exit_price - entry_price)
            else:
                gross_pnl = qty * (entry_price - exit_price)

            # Fees: entry + exit
            fees = qty * entry_price * fee_rate + qty * exit_price * fee_rate
            slippage_cost = qty * entry_price * slippage + qty * exit_price * slippage
            net_pnl = gross_pnl - fees - slippage_cost

            # R multiple
            r_multiple = net_pnl / risk_amount if risk_amount > 0 else 0.0

            # Update account (compounded)
            window_account += net_pnl
            account = window_account

            window_trades.append({
                "side": side,
                "entry_price": entry_price,
                "exit_price": exit_price,
                "pnl": net_pnl,
                "r_multiple": r_multiple,
                "exit_reason": exit_reason,
            })
            window_r_multiples.append(r_multiple)
            all_r_multiples.append(r_multiple)

            # Move i to exit to avoid overlapping trades
            i = exit_idx

        # Window metrics
        if window_r_multiples:
            arr = np.array(window_r_multiples)
            mean_r = np.mean(arr)
            std_r = np.std(arr)
            window_sharpe = (mean_r / std_r * math.sqrt(365 * 6)) if std_r > 0 else 0.0

            gross_profit = sum(r for r in window_r_multiples if r > 0)
            gross_loss = abs(sum(r for r in window_r_multiples if r < 0))
            window_pf = gross_profit / gross_loss if gross_loss > 0 else (float("inf") if gross_profit > 0 else 0.0)

            window_win_rate = sum(1 for r in window_r_multiples if r > 0) / len(window_r_multiples)

            # Max DD for window
            peak = window_account
            window_maxdd = 0.0
            running_eq = window_account - sum(t["pnl"] for t in window_trades)  # starting equity of window
            for t in window_trades:
                running_eq += t["pnl"]
                if running_eq > peak:
                    peak = running_eq
                dd = (peak - running_eq) / peak
                if dd > window_maxdd:
                    window_maxdd = dd

            window_results.append({
                "window": w + 1,
                "oos_sharpe": float(window_sharpe),
                "oos_maxdd_pct": float(window_maxdd * 100),
                "oos_pf": float(window_pf) if math.isfinite(window_pf) else 0.0,
                "oos_win_rate": float(window_win_rate),
                "oos_trades": len(window_r_multiples),
                "oos_avg_r": float(mean_r),
                "oos_total_pnl": float(sum(t["pnl"] for t in window_trades)),
            })
            all_returns.extend(window_r_multiples)

    # Aggregate
    if all_returns:
        arr = np.array(all_returns)
        mean_r = np.mean(arr)
        std_r = np.std(arr)
        oos_expectancy_r = float(mean_r)
        oos_sharpe = (mean_r / std_r * math.sqrt(365 * 6)) if std_r > 0 else 0.0

        total_pnl_r = sum(all_returns)
        gross_profit_r = sum(r for r in all_returns if r > 0)
        gross_loss_r = abs(sum(r for r in all_returns if r < 0))
        oos_pf = gross_profit_r / gross_loss_r if gross_loss_r > 0 else (float("inf") if gross_profit_r > 0 else 0.0)
        oos_win_rate = sum(1 for r in all_returns if r > 0) / len(all_returns)
        oos_avg_r = float(mean_r)

        # Total return % from compounded account
        oos_total_return_pct = ((account - initial_capital) / initial_capital) * 100

        # Max DD from equity curve
        peak = initial_capital
        oos_maxdd = 0.0
        running_eq = initial_capital
        for r in all_returns:
            # Approximate: each R = risk_per_trade * account_at_time
            # Simplified: use R multiple as % of risk
            running_eq = running_eq * (1 + r * risk_per_trade)
            if running_eq > peak:
                peak = running_eq
            dd = (peak - running_eq) / peak
            if dd > oos_maxdd:
                oos_maxdd = dd
    else:
        oos_expectancy_r = 0.0
        oos_sharpe = 0.0
        oos_pf = 0.0
        oos_win_rate = 0.0
        oos_total_return_pct = 0.0
        oos_maxdd = 0.0
        oos_avg_r = 0.0

    return {
        "oos_expectancy_r": oos_expectancy_r,
        "oos_total_return_pct": float(oos_total_return_pct),
        "oos_maxdd_pct": float(oos_maxdd * 100),
        "oos_win_rate": float(oos_win_rate),
        "oos_profit_factor": float(oos_pf) if math.isfinite(oos_pf) else 0.0,
        "oos_total_trades": int(len(all_returns)),
        "oos_avg_r": oos_avg_r,
        "oos_sharpe": float(oos_sharpe),
        "windows": window_results,
    }


def train_final_model(X: pd.DataFrame, y: pd.Series) -> xgb.XGBRegressor:
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
    dump = booster.get_dump(with_stats=True)
    trees = []
    for tree_text in dump:
        trees.append(parse_xgb_dump(tree_text, feature_names))
    return {
        "feature_names": feature_names,
        "num_trees": len(trees),
        "trees": trees,
        "base_score": float(booster.attr("base_score") or 0.5),
        "objective": "reg:squarederror",
    }


def parse_xgb_dump(dump_text: str, feature_names: list[str]) -> dict:
    """Parse XGBoost text dump into nested node structure."""
    lines = dump_text.strip().split("\n")
    nodes = []
    feature_index = {name: i for i, name in enumerate(feature_names)}

    for line in lines:
        line = line.strip()
        if not line:
            continue
        node_id_str, rest = line.split(":", 1)
        node_id = int(node_id_str)

        if rest.startswith("leaf"):
            leaf_val = float(rest.split("=")[1].split(",")[0])
            nodes.append({
                "nodeid": node_id,
                "leaf": leaf_val,
            })
        else:
            bracket_start = rest.index("[")
            bracket_end = rest.index("]")
            feat_part = rest[bracket_start + 1 : bracket_end]

            if feat_part.startswith("f"):
                feature_idx = int(feat_part[1:])
            else:
                feature_idx = feature_index.get(feat_part, 0)

            thr_str = rest.split("<")[1].split("]")[0]
            threshold = float(thr_str)

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
    parser.add_argument("--symbol", required=True, help="Asset symbol, e.g. SOLUSDT")
    parser.add_argument("--interval", required=True, help="Candle interval, e.g. 4h")
    parser.add_argument("--lookback", type=int, default=1000, help="Number of candles to fetch")
    parser.add_argument("--forward-bars", type=int, default=3, help="Forward bars for target")
    parser.add_argument("--regime-filter", type=str, default="both", choices=["none", "bull_only", "bear_only", "both"], help="Regime filter")
    parser.add_argument("--prob-threshold", type=float, default=0.55, help="Probability threshold for signal")
    parser.add_argument("--leverage", type=float, default=1.0, help="Leverage multiplier (1 = spot)")
    parser.add_argument("--allow-short", action="store_true", default=True, help="Allow short positions")
    parser.add_argument("--no-short", action="store_true", help="Disable short positions")
    parser.add_argument("--rr-ratio", type=float, default=2.0, help="Reward:Risk ratio (TP/SL)")
    parser.add_argument("--risk-per-trade", type=float, default=0.01, help="Risk per trade as fraction of account")
    parser.add_argument("--stop-loss-atr", type=float, default=2.0, help="Stop loss in ATR multiples")
    parser.add_argument("--take-profit-atr", type=float, default=5.0, help="Take profit in ATR multiples")
    parser.add_argument("--max-hold-bars", type=int, default=30, help="Max bars to hold position")
    parser.add_argument("--gate-expectancy-r", type=float, default=0.1, help="Minimum expectancy in R per trade")
    parser.add_argument("--gate-maxdd", type=float, default=0.50, help="Maximum drawdown (fraction)")
    parser.add_argument("--gate-win-rate", type=float, default=0.40, help="Minimum win rate (fraction)")
    args = parser.parse_args()

    symbol = args.symbol.upper()
    interval = args.interval
    lookback = args.lookback
    forward_bars = args.forward_bars
    regime_filter = args.regime_filter
    prob_threshold = args.prob_threshold
    leverage = args.leverage
    allow_short = args.allow_short and not args.no_short
    rr_ratio = args.rr_ratio
    risk_per_trade = args.risk_per_trade
    sl_atr = args.stop_loss_atr
    tp_atr = args.take_profit_atr
    max_hold = args.max_hold_bars

    gates = {
        "expectancy_r_min": args.gate_expectancy_r,
        "maxdd_max": args.gate_maxdd,
        "win_rate_min": args.gate_win_rate,
    }

    print(f"[train] {symbol} {interval} | lev={leverage}x short={allow_short} RR=1:{rr_ratio} risk={risk_per_trade*100:.1f}% SL={sl_atr}ATR TP={tp_atr}ATR maxHold={max_hold}")
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
    # Preserve OHLC from raw candles for backtest SL/TP checking
    asset_close_prices = [c["close"] for c in asset_candles]
    asset_high_prices = [c["high"] for c in asset_candles]
    asset_low_prices = [c["low"] for c in asset_candles]

    df = compute_features(asset_candles, index_candles)

    df = apply_regime_filter(df, regime_filter)
    if len(df) < 80:
        print(f"[train] ERROR: insufficient data after regime filter ({len(df)} rows)")
        sys.exit(1)

    # Reindex price arrays to match df index after regime filter
    df_index = df.index
    close_prices = np.array(asset_close_prices)[df_index]
    high_prices = np.array(asset_high_prices)[df_index]
    low_prices = np.array(asset_low_prices)[df_index]

    df["target"] = build_target(df, forward_bars=forward_bars)

    feature_cols = [
        "rs_zscore", "rs_momentum", "asset_return_6", "volume_ratio",
        "atr_pct", "btc_regime_20", "btc_regime_60", "btc_bull_filter",
        "mom_5", "mom_20", "mom_60", "close_over_sma20",
        "rs_over_rs_ma", "atr_regime",
    ]
    df_clean = df.dropna(subset=feature_cols + ["target"]).copy()
    if len(df_clean) < 80:
        print(f"[train] ERROR: insufficient clean data ({len(df_clean)} rows)")
        sys.exit(1)

    # Reindex price arrays to match df_clean index
    clean_idx = df_clean.index
    close_prices = close_prices[clean_idx]
    high_prices = high_prices[clean_idx]
    low_prices = low_prices[clean_idx]

    X = df_clean[feature_cols]
    y = df_clean["target"]

    print(f"[train] Walk-forward backtest (n={len(X)}, forward={forward_bars}, regime={regime_filter}, prob_thresh={prob_threshold})")
    oos = run_backtest_compounded_r(
        X, y, close_prices, high_prices, low_prices,
        initial_capital=1000.0,
        risk_per_trade=risk_per_trade,
        stop_loss_atr=sl_atr,
        take_profit_atr=tp_atr,
        max_hold_bars=max_hold,
        prob_threshold=prob_threshold,
        leverage=leverage,
        allow_short=allow_short,
        regime_filter=regime_filter,
        fee_rate=0.001,
        slippage=0.0005,
    )

    print(f"[train] OOS Expectancy={oos['oos_expectancy_r']:.3f}R TotalReturn={oos['oos_total_return_pct']:.2f}% MaxDD={oos['oos_maxdd_pct']:.2f}% WinRate={oos['oos_win_rate']:.1%} PF={oos['oos_profit_factor']:.2f} Trades={oos['oos_total_trades']} Sharpe={oos['oos_sharpe']:.2f}")

    # Gates
    passed = True
    if oos["oos_expectancy_r"] < gates["expectancy_r_min"]:
        print(f"[train] GATE FAIL: Expectancy {oos['oos_expectancy_r']:.3f}R < {gates['expectancy_r_min']}R")
        passed = False
    if oos["oos_maxdd_pct"] / 100 > gates["maxdd_max"]:
        print(f"[train] GATE FAIL: MaxDD {oos['oos_maxdd_pct']:.2f}% > {gates['maxdd_max']*100:.0f}%")
        passed = False
    if oos["oos_win_rate"] < gates["win_rate_min"]:
        print(f"[train] GATE FAIL: WinRate {oos['oos_win_rate']:.1%} < {gates['win_rate_min']*100:.0f}%")
        passed = False

    if not passed:
        print("[train] Model rejected by OOS gates. Not exporting.")
        sys.exit(1)

    print("[train] Training final model on all data")
    model = train_final_model(X, y)

    importance = model.get_booster().get_score(importance_type="gain")
    feature_importance = {f: float(importance.get(f, 0.0)) for f in feature_cols}

    print("[train] Exporting model to JSON")
    model_json = export_model_json(model, feature_cols)

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
        "forward_bars": forward_bars,
        "regime_filter": regime_filter,
        "prob_threshold": prob_threshold,
        "leverage": leverage,
        "allow_short": allow_short,
        "rr_ratio": rr_ratio,
        "risk_per_trade": risk_per_trade,
        "stop_loss_atr": sl_atr,
        "take_profit_atr": tp_atr,
        "max_hold_bars": max_hold,
        "feature_cols": feature_cols,
        "feature_importance": feature_importance,
        "oos_metrics": oos,
        "gates": gates,
        "gates_passed": True,
        "model_type": "xgboost_reg_squarederror_long_short",
        "base_score": model_json["base_score"],
    }
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)

    print(f"[train] Model saved to {model_path}")
    print(f"[train] Meta saved to {meta_path}")
    print("[train] Done.")


if __name__ == "__main__":
    main()
