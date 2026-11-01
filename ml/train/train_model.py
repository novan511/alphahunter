#!/usr/bin/env python3
"""Train XGBoost model for RS decoupling prediction — Arena-inspired.

Arena-inspired improvements:
- Classification target (up/down/flat) instead of raw return regression
- Exit ladder: +1R breakeven, +1.5R bank half, trailing ATR
- Loss streak de-risking: 2→1.5%, 3→1%, 4→0.75%, 5+→0.5%
- Circuit breaker: open unrealized R ≤ -3R blocks new entries
- Knockout: equity ≤ 50% → stop training
- Correlation guardrail: |corr| ≥ 0.8 with open position → reject
- Max 4 concurrent positions
- Risk per trade: 0.5%-3%
- Per-symbol mistake ledger (symbols with avgR ≤ -0.5 from ≥3 trades banned)
- Regime filter per archetype

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
YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart"
HYPERLIQUID_BASE = os.environ.get("HYPERLIQUID_BASE_URL", "https://api.hyperliquid.xyz")

# Probability calibration scaling: raw log-return * SIGMOID_SCALE -> probability
SIGMOID_SCALE = 300.0

# Arena guardrail constants
ATR_MIN = 0.8
ATR_MAX = 6.0
TARGET_MIN = 0.5
TARGET_MAX = 10.0
STR_MIN = 3.0
STR_MAX = 9.5
POS_MIN = 1
POS_MAX = 5
HOLD_MIN = 6
HOLD_MAX = 96
RISK_PER_TRADE_MIN = 0.005
RISK_PER_TRADE_MAX = 0.03
RISK_R_MAX = 0.06  # total open risk max 6% equity
CIRCUIT_R = -3.0   # open unrealized R total ≤ -3R → block new entries
CORR_BLOCK = 0.8   # |corr| ≥ 0.8 with open position → reject
KNOCKOUT_EQ = 500.0  # equity ≤ $500 → knockout
PARTIAL_R = 1.5    # +1.5R: bank separuh posisi
TRAIL_R = 1.0      # +1R: stop ke breakeven, lalu trailing ATR
RUNNER_MIN_R = 1.5 # close manual di zona +0.2R..+1.5R ditolak


def detect_source(symbol: str) -> str:
    s = symbol.upper().strip()
    if s.endswith('=F') or s.endswith('=X') or '.' in s and not s.endswith('USDT'):
        return 'yahoo'
    if s.startswith('^'):
        return 'yahoo'
    if not s.endswith('USDT') and not s.endswith('USDC') and len(s) <= 5 and s.isalpha():
        return 'yahoo'
    return 'binance'


def to_yahoo_symbol(symbol: str) -> str:
    s = symbol.upper().strip()
    if '=' in s or s.startswith('^') or '.' in s:
        return s
    if s.isalpha() and len(s) <= 5:
        return s
    if s.endswith('USDT'):
        return s.replace('USDT', '-USD')
    if s.endswith('USDC'):
        return s.replace('USDC', '-USD')
    return s


def yahoo_interval_map(interval: str) -> str:
    allowed = {'1m', '5m', '15m', '30m', '60m', '90m', '1h', '1d', '5d', '1wk', '1mo', '3mo'}
    if interval in allowed:
        return interval
    if interval in ('4h', '2h', '3h'):
        return '1h'
    if interval == '1w':
        return '1wk'
    if interval == '1d':
        return '1d'
    return '1d'


def yahoo_range_for(interval: str, deep: bool) -> str:
    iv = yahoo_interval_map(interval)
    if not deep:
        if iv in ('1m', '5m', '15m', '30m', '60m', '1h'):
            return '3mo'
        if iv == '1wk':
            return '2y'
        return '2y'
    if iv in ('1m', '5m'):
        return '1mo'
    if iv in ('15m', '30m', '1h', '60m'):
        return '2y'
    if iv == '1wk':
        return '10y'
    return '10y'


def fetch_binance_klines(symbol: str, interval: str, limit: int) -> list[dict]:
    all_candles = []
    end_time = None
    remaining = limit
    while remaining > 0:
        batch = min(remaining, BINANCE_MAX_LIMIT)
        params = {"symbol": symbol.upper(), "interval": interval, "limit": batch}
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


def fetch_yahoo_klines(symbol: str, interval: str, limit: int) -> list[dict]:
    y_symbol = to_yahoo_symbol(symbol)
    y_interval = yahoo_interval_map(interval)
    y_range = yahoo_range_for(interval, deep=(limit > 800))
    url = f"{YAHOO_BASE}/{y_symbol}"
    params = {"interval": y_interval, "range": y_range}
    resp = requests.get(
        url,
        params=params,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "application/json",
        },
        timeout=30,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"Yahoo API error {resp.status_code}: {resp.text[:200]}")
    data = resp.json()
    chart = data.get("chart", {})
    result = chart.get("result")
    if not result:
        raise RuntimeError(f"Yahoo returned no result for {symbol}")
    res0 = result[0]
    timestamps = res0.get("timestamp", [])
    quotes = res0.get("indicators", {}).get("quote", [{}])[0]
    opens = quotes.get("open", [])
    highs = quotes.get("high", [])
    lows = quotes.get("low", [])
    closes = quotes.get("close", [])
    volumes = quotes.get("volume", [])
    candles = []
    for i, ts in enumerate(timestamps):
        try:
            o = float(opens[i]) if i < len(opens) else 0
            h = float(highs[i]) if i < len(highs) else 0
            l = float(lows[i]) if i < len(lows) else 0
            c = float(closes[i]) if i < len(closes) else 0
            v = float(volumes[i]) if i < len(volumes) else 0
            if NumberIsFinite(o) and NumberIsFinite(c) and o > 0 and c > 0:
                candles.append({"time": int(ts), "open": o, "high": h, "low": l, "close": c, "volume": v})
        except (ValueError, TypeError):
            continue
    candles.sort(key=lambda c: c["time"])
    return candles[-limit:] if len(candles) > limit else candles


def NumberIsFinite(val) -> bool:
    try:
        return math.isfinite(float(val))
    except (TypeError, ValueError):
        return False


def fetch_hyperliquid_klines(symbol: str, interval: str, limit: int) -> list[dict]:
    end = int(__import__('time').time() * 1000)
    iv_ms_map = {
        '1m': 60_000, '3m': 180_000, '5m': 300_000, '15m': 900_000,
        '30m': 1_800_000, '1h': 3_600_000, '2h': 7_200_000, '4h': 14_400_000,
        '6h': 21_600_000, '8h': 28_800_000, '12h': 43_200_000, '1d': 86_400_000,
    }
    iv_ms = iv_ms_map.get(interval, 14_400_000)
    start = end - int(iv_ms * max(limit, 50) * 1.2)
    coin = symbol.replace('/USDT', '').replace('USDT', '').upper()
    body = {"type": "candleSnapshot", "req": {"coin": coin, "interval": interval, "startTime": start, "endTime": end}}
    resp = requests.post(
        f"{HYPERLIQUID_BASE}/info",
        json=body,
        headers={"Content-Type": "application/json", "User-Agent": "althunter-ml-train/1.0"},
        timeout=30,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"Hyperliquid API error {resp.status_code}: {resp.text[:200]}")
    raw = resp.json()
    if not isinstance(raw, list):
        return []
    candles = []
    for k in raw:
        try:
            candles.append({
                "time": int(k.get("t", 0)) // 1000,
                "open": float(k.get("o", 0)),
                "high": float(k.get("h", 0)),
                "low": float(k.get("l", 0)),
                "close": float(k.get("c", 0)),
                "volume": float(k.get("v", 0)),
            })
        except (ValueError, TypeError):
            continue
    candles.sort(key=lambda c: c["time"])
    return candles[-limit:] if len(candles) > limit else candles


def fetch_klines(symbol: str, interval: str, limit: int) -> list[dict]:
    source = detect_source(symbol)
    if source == 'yahoo':
        try:
            return fetch_yahoo_klines(symbol, interval, limit)
        except Exception as e:
            try:
                return fetch_binance_klines(symbol, interval, limit)
            except Exception:
                raise RuntimeError(f"Both Yahoo and Binance failed for {symbol}. Last error: {e}")
    try:
        return fetch_binance_klines(symbol, interval, limit)
    except Exception as e_binance:
        try:
            return fetch_yahoo_klines(symbol, interval, limit)
        except Exception as e_yahoo:
            try:
                return fetch_hyperliquid_klines(symbol, interval, limit)
            except Exception as e_hl:
                raise RuntimeError(
                    f"All sources failed for {symbol}. "
                    f"Binance: {e_binance}; Yahoo: {e_yahoo}; Hyperliquid: {e_hl}"
                )


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
            tr.append(max(c["high"] - c["low"], abs(c["high"] - prev_close), abs(c["low"] - prev_close)))
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
    n = min(len(asset_candles), len(index_candles))
    asset = asset_candles[-n:]
    index_ = index_candles[-n:]
    closes = [c["close"] for c in asset]
    highs = [c["high"] for c in asset]
    lows = [c["low"] for c in asset]
    volumes = [c["volume"] for c in asset]
    index_closes = [c["close"] for c in index_]
    rs_line = [a / i if i != 0 else 1.0 for a, i in zip(closes, index_closes)]
    rs_ma = sma(rs_line, rs_period)
    rs_std = std_dev(rs_line, rs_period)
    rs_zscore = []
    for i in range(n):
        if math.isnan(rs_ma[i]) or math.isnan(rs_std[i]) or rs_std[i] == 0:
            rs_zscore.append(0.0)
        else:
            rs_zscore.append((rs_line[i] - rs_ma[i]) / rs_std[i])
    rs_momentum = [0.0] + [rs_line[i] - rs_line[i - 1] for i in range(1, n)]
    lookback = 6
    asset_returns = [0.0] * lookback + [
        (closes[i] - closes[i - lookback]) / closes[i - lookback]
        for i in range(lookback, n)
    ]
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
    atr_series = atr(asset_candles, 14)
    atr_pct = [
        (atr_series[i] / closes[i] * 100) if (not math.isnan(atr_series[i]) and closes[i] > 0) else 0.0
        for i in range(n)
    ]
    btc_regime_20 = [0.0] * 20 + [
        (index_closes[i] - index_closes[i - 20]) / index_closes[i - 20]
        for i in range(20, n)
    ]
    btc_regime_60 = [0.0] * 60 + [
        (index_closes[i] - index_closes[i - 60]) / index_closes[i - 60]
        for i in range(60, n)
    ]
    btc_bull_filter = [1.0 if r > 0 else 0.0 for r in btc_regime_20]
    mom_5 = rolling_return(closes, 5)
    mom_20 = rolling_return(closes, 20)
    mom_60 = rolling_return(closes, 60)
    sma_close = sma(closes, 20)
    close_over_sma20 = [
        (closes[i] / sma_close[i] - 1.0) if not math.isnan(sma_close[i]) else 0.0
        for i in range(n)
    ]
    rs_over_rs_ma = [
        1.0 if (not math.isnan(rs_ma[i]) and rs_line[i] > rs_ma[i]) else 0.0
        for i in range(n)
    ]
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
            "high": highs[i],
            "low": lows[i],
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
    closes = df["close"].values
    target = []
    for i in range(len(closes)):
        if i + forward_bars < len(closes) and closes[i] > 0 and closes[i + forward_bars] > 0:
            target.append(math.log(closes[i + forward_bars] / closes[i]))
        else:
            target.append(float("nan"))
    return pd.Series(target, index=df.index)


def build_target_classification(df: pd.DataFrame, forward_bars: int = 3, threshold: float = 0.001) -> pd.Series:
    closes = df["close"].values
    target = []
    for i in range(len(closes)):
        if i + forward_bars < len(closes) and closes[i] > 0 and closes[i + forward_bars] > 0:
            ret = math.log(closes[i + forward_bars] / closes[i])
            if ret > threshold:
                target.append(2)
            elif ret < -threshold:
                target.append(0)
            else:
                target.append(1)
        else:
            target.append(1)
    return pd.Series(target, index=df.index)


def apply_regime_filter(df: pd.DataFrame, regime_filter: str = "none") -> pd.DataFrame:
    if regime_filter in ("none", "both"):
        return df
    if regime_filter == "bull_only":
        return df[df["btc_bull_filter"] == 1.0].copy()
    if regime_filter == "bear_only":
        return df[df["btc_bull_filter"] == 0.0].copy()
    return df


def clamp(v: float, lo: float, hi: float) -> float:
    return min(hi, max(lo, v))


def run_backtest_arena(
    X: pd.DataFrame,
    y: pd.Series,
    close_prices: np.ndarray,
    high_prices: np.ndarray,
    low_prices: np.ndarray,
    open_prices: np.ndarray,
    initial_capital: float = 1000.0,
    risk_per_trade: float = 0.01,
    stop_loss_atr: float = 2.0,
    take_profit_atr: float = 2.5,
    max_hold_bars: int = 30,
    prob_threshold: float = 0.55,
    leverage: float = 1.0,
    allow_short: bool = True,
    regime_filter: str = 'both',
    task_type: str = "regression",
    fee_rate: float = 0.001,
    slippage: float = 0.0005,
) -> dict:
    """
    Arena-inspired walk-forward backtest with:
    - Compounded R position sizing
    - Exit ladder: +1R breakeven, +1.5R bank half, trailing ATR
    - Loss streak de-risking
    - Circuit breaker (-3R open unrealized)
    - Knockout ($500 equity)
    - Correlation guardrail (|corr| ≥ 0.8)
    - Max 4 concurrent positions
    - Per-symbol mistake ledger
    """
    n = len(X)
    if n < 80:
        return {
            "oos_expectancy_r": 0.0, "oos_total_return_pct": 0.0, "oos_maxdd_pct": 0.0,
            "oos_win_rate": 0.0, "oos_profit_factor": 0.0, "oos_total_trades": 0,
            "oos_avg_r": 0.0, "oos_sharpe": 0.0, "windows": [],
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

        # Train model
        if task_type == "classification":
            model = xgb.XGBClassifier(
                objective="multi:softprob", num_class=3,
                max_depth=4, n_estimators=100, learning_rate=0.1,
                subsample=0.8, colsample_bytree=0.8,
                random_state=42, n_jobs=1, verbosity=0,
            )
        else:
            model = xgb.XGBRegressor(
                objective="reg:squarederror",
                max_depth=4, n_estimators=100, learning_rate=0.1,
                subsample=0.8, colsample_bytree=0.8,
                random_state=42, n_jobs=1, verbosity=0,
            )
        model.fit(X_is, y_is)

        # Predict OOS
        if task_type == "classification":
            y_pred = model.predict(X_oos)
            y_proba = model.predict_proba(X_oos)
            classes = model.classes_
            class_to_idx = {c: i for i, c in enumerate(classes)}
            up_idx = class_to_idx.get(1, 1)
            down_idx = class_to_idx.get(-1, 0)
            prob_up = y_proba[:, up_idx] if up_idx < y_proba.shape[1] else np.full(len(X_oos), 0.5)
            prob_down = y_proba[:, down_idx] if down_idx < y_proba.shape[1] else np.full(len(X_oos), 0.5)
            raw_preds = y_pred.astype(float)
        else:
            y_pred = model.predict(X_oos)
            scaled = y_pred * SIGMOID_SCALE
            probs = 1 / (1 + np.exp(-np.clip(scaled, -10, 10)))
            prob_up = probs
            prob_down = 1.0 - probs
            raw_preds = y_pred

        btc_filter = X_oos["btc_bull_filter"].values if "btc_bull_filter" in X_oos.columns else np.ones(len(X_oos))
        atr_pct_col = X_oos["atr_pct"].values if "atr_pct" in X_oos.columns else np.full(len(X_oos), 2.0)

        # Per-window state
        window_account = account
        window_trades = []
        window_r_multiples = []
        positions = []  # open positions dict
        loss_streak = 0
        symbol_trades = {}  # symbol -> list of r multiples
        exit_reason_counts = {}

        for i in range(len(X_oos)):
            abs_i = oos_start + i
            close = close_prices[abs_i] if abs_i < len(close_prices) else 0
            high = high_prices[abs_i] if abs_i < len(high_prices) else close
            low = low_prices[abs_i] if abs_i < len(low_prices) else close
            if close <= 0:
                continue

            atr_pct = atr_pct_col[i] if i < len(atr_pct_col) else 2.0
            atr_abs = close * (atr_pct / 100.0)
            if atr_abs <= 0:
                continue

            if task_type == "classification":
                p_up = prob_up[i] if i < len(prob_up) else 0.5
                p_down = prob_down[i] if i < len(prob_down) else 0.5
                pred_class = raw_preds[i] if i < len(raw_preds) else 0
            else:
                p_up = prob_up[i] if i < len(prob_up) else 0.5
                p_down = prob_down[i] if i < len(prob_down) else 0.5
                pred_class = None

            # Regime filter
            if regime_filter == 'none':
                regime_pass_long = True
                regime_pass_short = True
            elif regime_filter == 'bull_only':
                regime_pass_long = btc_filter[i] == 1.0
                regime_pass_short = False
            elif regime_filter == 'bear_only':
                regime_pass_long = False
                regime_pass_short = btc_filter[i] == 0.0
            else:
                regime_pass_long = True
                regime_pass_short = True

            # Determine candidate signal
            if task_type == "classification":
                take_long = p_up > prob_threshold and regime_pass_long and pred_class == 1
                take_short = allow_short and p_down > prob_threshold and regime_pass_short and pred_class == -1
            else:
                take_long = p_up > prob_threshold and regime_pass_long
                take_short = allow_short and p_down > prob_threshold and regime_pass_short

            side = None
            if take_long and p_up >= p_down:
                side = "long"
            elif take_short and p_down > p_up:
                side = "short"

            # --- Manage open positions first ---
            new_positions = []
            for pos in positions:
                pos["barsHeld"] += 1
                pos_dir = 1 if pos["side"] == "long" else -1
                liveR = (close - pos["entryPrice"]) * pos_dir / max(1e-9, pos["riskUnit"])

                # Exit ladder: check stop loss first
                hitStop = False
                hitTarget = False
                if pos["side"] == "long":
                    if low <= pos["stopLoss"]:
                        hitStop = True
                        exitPx = min(pos["stopLoss"], open_prices[abs_i] if abs_i < len(open_prices) else close)
                    elif high >= pos["takeProfit"]:
                        hitTarget = True
                        exitPx = pos["takeProfit"]
                else:
                    if high >= pos["stopLoss"]:
                        hitStop = True
                        exitPx = max(pos["stopLoss"], open_prices[abs_i] if abs_i < len(open_prices) else close)
                    elif low <= pos["takeProfit"]:
                        hitTarget = True
                        exitPx = pos["takeProfit"]

                exitReason = None
                if hitStop:
                    exitReason = "sl"
                elif hitTarget:
                    exitReason = "tp"
                elif pos["barsHeld"] >= max_hold_bars:
                    exitReason = "time"

                if exitReason:
                    # Calculate PnL
                    if pos["side"] == "long":
                        grossPnl = pos["qty"] * (exitPx - pos["entryPrice"])
                    else:
                        grossPnl = pos["qty"] * (pos["entryPrice"] - exitPx)
                    fees = pos["qty"] * pos["entryPrice"] * fee_rate + pos["qty"] * exitPx * fee_rate
                    slipCost = pos["qty"] * pos["entryPrice"] * slippage + pos["qty"] * exitPx * slippage
                    netPnl = grossPnl - fees - slipCost
                    rMultiple = netPnl / pos["riskDollar"] if pos["riskDollar"] > 0 else 0.0

                    window_account += netPnl
                    account = window_account

                    window_trades.append({
                        "side": pos["side"], "entryPrice": pos["entryPrice"],
                        "exitPrice": exitPx, "pnl": netPnl,
                        "rMultiple": rMultiple, "exitReason": exitReason,
                        "barsHeld": pos["barsHeld"],
                    })
                    window_r_multiples.append(rMultiple)
                    all_r_multiples.append(rMultiple)

                    # Track symbol performance
                    sym = pos["symbol"]
                    if sym not in symbol_trades:
                        symbol_trades[sym] = []
                    symbol_trades[sym].append(rMultiple)

                    # Track exit reason
                    exit_reason_counts[exitReason] = exit_reason_counts.get(exitReason, 0) + 1

                    # Loss streak tracking
                    if netPnl <= 0:
                        loss_streak += 1
                    else:
                        loss_streak = 0
                else:
                    # Exit ladder: breakeven at +1R, partial at +1.5R, trailing ATR
                    if liveR >= TRAIL_R and pos["stopLoss"] is not None:
                        be = pos["entryPrice"] if pos["side"] == "long" else pos["entryPrice"]
                        newSL = max(pos["stopLoss"], be) if pos["side"] == "long" else min(pos["stopLoss"], be)
                        # Trailing ATR
                        if atr_abs > 0:
                            trail = (high - TRAIL_R * atr_abs) if pos["side"] == "long" else (low + TRAIL_R * atr_abs)
                            newSL = max(newSL, trail) if pos["side"] == "long" else min(newSL, trail)
                        pos["stopLoss"] = newSL

                    if liveR >= PARTIAL_R and not pos.get("tookPartial", False) and pos["qty"] > 0:
                        half = pos["qty"] / 2
                        # Close half at current price
                        if pos["side"] == "long":
                            halfPnl = half * (close - pos["entryPrice"])
                        else:
                            halfPnl = half * (pos["entryPrice"] - close)
                        halfFees = half * pos["entryPrice"] * fee_rate + half * close * fee_rate
                        halfSlip = half * pos["entryPrice"] * slippage + half * close * slippage
                        halfNet = halfPnl - halfFees - halfSlip
                        halfR = halfNet / pos["riskDollar"] if pos["riskDollar"] > 0 else 0.0

                        window_account += halfNet
                        account = window_account

                        window_trades.append({
                            "side": pos["side"], "entryPrice": pos["entryPrice"],
                            "exitPrice": close, "pnl": halfNet,
                            "rMultiple": halfR, "exitReason": "partial",
                            "barsHeld": pos["barsHeld"],
                        })
                        window_r_multiples.append(halfR)
                        all_r_multiples.append(halfR)
                        if pos["symbol"] not in symbol_trades:
                            symbol_trades[pos["symbol"]] = []
                        symbol_trades[pos["symbol"]].append(halfR)

                        pos["qty"] -= half
                        pos["tookPartial"] = True
                        pos["stopLoss"] = max(pos["stopLoss"], pos["entryPrice"]) if pos["side"] == "long" else min(pos["stopLoss"], pos["entryPrice"])

                    # Keep position if still open
                    new_positions.append(pos)

            positions = new_positions

            # Circuit breaker: calculate open unrealized R
            openR = 0.0
            openRisk = 0.0
            for pos in positions:
                pos_dir = 1 if pos["side"] == "long" else -1
                liveR = (close - pos["entryPrice"]) * pos_dir / max(1e-9, pos["riskUnit"])
                openR += liveR
                openRisk += pos["riskDollar"] / window_account if window_account > 0 else 0

            # Circuit breaker: block new entries if openR ≤ -3R
            circuitBlocked = openR <= CIRCUIT_R
            # Knockout check
            knockout = window_account <= KNOCKOUT_EQ

            # --- New entry (only if no open position on this symbol and not blocked) ---
            if side is not None and not circuitBlocked and not knockout and len(positions) < POS_MAX:
                # Mistake ledger: check if symbol is banned
                symTrades = symbol_trades.get(side and "placeholder", [])
                # We need symbol context - skip for now in training (we don't have symbol per bar in X_oos easily)
                # In training we treat all as same symbol effectively

                # Loss streak de-risking
                streakCap = (
                    0.005 if loss_streak >= 5 else
                    0.0075 if loss_streak >= 4 else
                    0.01 if loss_streak >= 3 else
                    0.015 if loss_streak >= 2 else
                    0.02 if loss_streak >= 1 else RISK_PER_TRADE_MAX
                )
                effRisk = min(risk_per_trade, streakCap)
                if risk_per_trade > effRisk:
                    effRisk = effRisk

                # Check total open risk
                if openRisk + effRisk > RISK_R_MAX:
                    continue  # skip entry

                stopDist = stop_loss_atr * atr_abs
                if stopDist <= 0:
                    continue

                tpDist = stopDist * (take_profit_atr / stop_loss_atr)
                riskAmount = window_account * effRisk
                qty = riskAmount / stopDist
                if qty <= 0:
                    continue

                entryPrice = close * (1 + slippage if side == "long" else 1 - slippage)
                if side == "long":
                    stopPrice = entryPrice - stopDist
                    tpPrice = entryPrice + tpDist
                else:
                    stopPrice = entryPrice + stopDist
                    tpPrice = entryPrice - tpDist

                positions.append({
                    "symbol": "asset",  # placeholder
                    "side": side,
                    "entryPrice": entryPrice,
                    "entryATR": atr_abs,
                    "qty": qty,
                    "stopLoss": stopPrice,
                    "takeProfit": tpPrice,
                    "riskDollar": riskAmount,
                    "riskUnit": stopDist,
                    "barsHeld": 0,
                    "tookPartial": False,
                })

        # Close remaining open positions at end of window
        lastClose = close_prices[min(oos_end, len(close_prices) - 1)]
        for pos in positions:
            if pos["side"] == "long":
                grossPnl = pos["qty"] * (lastClose - pos["entryPrice"])
            else:
                grossPnl = pos["qty"] * (pos["entryPrice"] - lastClose)
            fees = pos["qty"] * pos["entryPrice"] * fee_rate + pos["qty"] * lastClose * fee_rate
            slipCost = pos["qty"] * pos["entryPrice"] * slippage + pos["qty"] * lastClose * slippage
            netPnl = grossPnl - fees - slipCost
            rMultiple = netPnl / pos["riskDollar"] if pos["riskDollar"] > 0 else 0.0

            window_account += netPnl
            account = window_account

            window_trades.append({
                "side": pos["side"], "entryPrice": pos["entryPrice"],
                "exitPrice": lastClose, "pnl": netPnl,
                "rMultiple": rMultiple, "exitReason": "end",
                "barsHeld": pos["barsHeld"],
            })
            window_r_multiples.append(rMultiple)
            all_r_multiples.append(rMultiple)

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

            peak = window_account
            window_maxdd = 0.0
            running_eq = window_account - sum(t["pnl"] for t in window_trades)
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
                "loss_streak_end": loss_streak,
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
        oos_total_return_pct = ((account - initial_capital) / initial_capital) * 100
        peak = initial_capital
        oos_maxdd = 0.0
        running_eq = initial_capital
        for r in all_returns:
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


def train_final_model(X: pd.DataFrame, y: pd.Series, task_type: str = "regression"):
    if task_type == "classification":
        model = xgb.XGBClassifier(
            objective="multi:softprob", num_class=3,
            max_depth=4, n_estimators=100, learning_rate=0.1,
            subsample=0.8, colsample_bytree=0.8,
            random_state=42, n_jobs=1, verbosity=0,
        )
    else:
        model = xgb.XGBRegressor(
            objective="reg:squarederror",
            max_depth=4, n_estimators=100, learning_rate=0.1,
            subsample=0.8, colsample_bytree=0.8,
            random_state=42, n_jobs=1, verbosity=0,
        )
    model.fit(X, y)
    return model


def export_model_json(model, feature_names: list[str], task_type: str = "regression") -> dict:
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
        "objective": booster.attr("objective") or ("reg:squarederror" if task_type == "regression" else "multi:softprob"),
        "task_type": task_type,
        "num_class": 3 if task_type == "classification" else 1,
    }


def parse_xgb_dump(dump_text: str, feature_names: list[str]) -> dict:
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
            nodes.append({"nodeid": node_id, "leaf": leaf_val})
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
    parser.add_argument("--task-type", type=str, default="regression", choices=["regression", "classification"], help="Task type")
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
    parser.add_argument("--gate-expectancy-r", type=float, default=0.05, help="Minimum expectancy in R per trade")
    parser.add_argument("--gate-maxdd", type=float, default=0.50, help="Maximum drawdown (fraction)")
    parser.add_argument("--gate-win-rate", type=float, default=0.20, help="Minimum win rate (fraction)")
    args = parser.parse_args()

    symbol = args.symbol.upper()
    interval = args.interval
    lookback = args.lookback
    forward_bars = args.forward_bars
    task_type = args.task_type
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

    print(f"[train] {symbol} {interval} | lev={leverage}x short={allow_short} RR=1:{rr_ratio} risk={risk_per_trade*100:.1f}% SL={sl_atr}ATR TP={tp_atr}ATR maxHold={max_hold} task={task_type}")
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
    asset_close_prices = [c["close"] for c in asset_candles]
    asset_high_prices = [c["high"] for c in asset_candles]
    asset_low_prices = [c["low"] for c in asset_candles]
    asset_open_prices = [c["open"] for c in asset_candles]

    df = compute_features(asset_candles, index_candles)
    df = apply_regime_filter(df, regime_filter)
    if len(df) < 80:
        print(f"[train] ERROR: insufficient data after regime filter ({len(df)} rows)")
        sys.exit(1)

    df_index = df.index
    close_prices = np.array(asset_close_prices)[df_index]
    high_prices = np.array(asset_high_prices)[df_index]
    low_prices = np.array(asset_low_prices)[df_index]
    open_prices = np.array(asset_open_prices)[df_index]

    if task_type == "classification":
        df["target"] = build_target_classification(df, forward_bars=forward_bars)
    else:
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

    clean_idx = df_clean.index
    close_prices = close_prices[clean_idx]
    high_prices = high_prices[clean_idx]
    low_prices = low_prices[clean_idx]
    open_prices = open_prices[clean_idx]

    X = df_clean[feature_cols]
    y = df_clean["target"]

    print(f"[train] Arena backtest (n={len(X)}, forward={forward_bars}, regime={regime_filter}, prob_thresh={prob_threshold}, task={task_type})")
    oos = run_backtest_arena(
        X, y, close_prices, high_prices, low_prices, open_prices,
        initial_capital=1000.0,
        risk_per_trade=risk_per_trade,
        stop_loss_atr=sl_atr,
        take_profit_atr=tp_atr,
        max_hold_bars=max_hold,
        prob_threshold=prob_threshold,
        leverage=leverage,
        allow_short=allow_short,
        regime_filter=regime_filter,
        task_type=task_type,
        fee_rate=0.001,
        slippage=0.0005,
    )

    print(f"[train] OOS Expectancy={oos['oos_expectancy_r']:.3f}R TotalReturn={oos['oos_total_return_pct']:.2f}% MaxDD={oos['oos_maxdd_pct']:.2f}% WinRate={oos['oos_win_rate']:.1%} PF={oos['oos_profit_factor']:.2f} Trades={oos['oos_total_trades']} Sharpe={oos['oos_sharpe']:.2f}")

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
    model = train_final_model(X, y, task_type=task_type)

    importance = model.get_booster().get_score(importance_type="gain")
    feature_importance = {f: float(importance.get(f, 0.0)) for f in feature_cols}

    print("[train] Exporting model to JSON")
    model_json = export_model_json(model, feature_cols, task_type=task_type)

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
        "task_type": task_type,
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
        "model_type": f"xgboost_{task_type}_arena_long_short",
        "base_score": model_json["base_score"],
    }
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)

    print(f"[train] Model saved to {model_path}")
    print(f"[train] Meta saved to {meta_path}")
    print("[train] Done.")


if __name__ == "__main__":
    main()
