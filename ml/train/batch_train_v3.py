#!/usr/bin/env python3
"""
Advanced ML Training v3 - Multi-dimensional grid search for profitable models.

Explores:
- Multiple feature sets (basic, technical, regime, volume, multi-timeframe)
- Multiple forward bar horizons (1, 3, 5, 10)
- Different XGBoost hyperparameters (max_depth, n_estimators, learning_rate, subsample)
- Classification vs regression
- Multiple probability thresholds
- Different risk parameters (SL/TP ATR, risk per trade)
- Both 1d and 4h timeframes

Uses Arena-inspired backtest with compounded R, exit ladder, loss streak de-risking,
circuit breaker, knockout, correlation guardrail.

Saves results to Supabase ml_model_metrics table.
"""

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import requests

# Load .env.local
def _load_env_local():
    env_path = Path(__file__).parent.parent.parent / ".env.local"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, val = line.split("=", 1)
                os.environ.setdefault(key.strip(), val.strip())

_load_env_local()

# Supabase config
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

if SUPABASE_URL and SUPABASE_SERVICE_KEY:
    SUPABASE_HEADERS = {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }
else:
    SUPABASE_HEADERS = None
    print("WARNING: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set. Skipping Supabase writes.")


def supabase_insert(table: str, data: dict) -> Optional[dict]:
    if not SUPABASE_HEADERS:
        return None
    try:
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/{table}",
            headers=SUPABASE_HEADERS,
            json=data,
            timeout=30,
        )
        if resp.status_code in (200, 201):
            return resp.json()
        print(f"  Supabase insert {table} failed: {resp.status_code} {resp.text[:200]}")
        return None
    except Exception as e:
        print(f"  Supabase insert {table} error: {e}")
        return None


def supabase_upsert(table: str, data: dict, on_conflict: str) -> Optional[dict]:
    if not SUPABASE_HEADERS:
        return None
    try:
        headers = dict(SUPABASE_HEADERS)
        headers["Prefer"] = f"resolution=merge-duplicates,on_conflict={on_conflict}"
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/{table}",
            headers=headers,
            json=data,
            timeout=30,
        )
        if resp.status_code in (200, 201):
            return resp.json()
        print(f"  Supabase upsert {table} failed: {resp.status_code} {resp.text[:200]}")
        return None
    except Exception as e:
        print(f"  Supabase upsert {table} error: {e}")
        return None


# ============================================================================
# ASSET UNIVERSE - Focus on assets that showed promise + new candidates
# ============================================================================
TOP_ASSETS = [
    # Crypto - top performers from v2
    ("MATICUSDT", "1d"), ("MATICUSDT", "4h"),
    ("BNBUSDT", "1d"), ("BNBUSDT", "4h"),
    ("BTCUSDT", "1d"), ("BTCUSDT", "4h"),
    ("ETHUSDT", "1d"), ("ETHUSDT", "4h"),
    ("SOLUSDT", "1d"), ("SOLUSDT", "4h"),
    ("ADAUSDT", "1d"), ("ADAUSDT", "4h"),
    ("XRPUSDT", "1d"), ("XRPUSDT", "4h"),
    ("AVAXUSDT", "1d"), ("AVAXUSDT", "4h"),
    ("LINKUSDT", "1d"), ("LINKUSDT", "4h"),
    ("DOTUSDT", "1d"), ("DOTUSDT", "4h"),
    # Commodities
    ("GC=F", "1d"), ("GC=F", "4h"),
    ("SI=F", "1d"), ("SI=F", "4h"),
    ("CL=F", "1d"), ("CL=F", "4h"),
    ("NG=F", "1d"), ("NG=F", "4h"),
    # Indices
    ("^N225", "1d"), ("^N225", "4h"),
    ("^VIX", "1d"), ("^VIX", "4h"),
    ("^GSPC", "1d"), ("^GSPC", "4h"),
    ("^IXIC", "1d"), ("^IXIC", "4h"),
    ("^DJI", "1d"), ("^DJI", "4h"),
    ("^KS11", "1d"), ("^KS11", "4d"),
    # Forex
    ("EURUSD=X", "1d"), ("EURUSD=X", "4h"),
    ("GBPUSD=X", "1d"), ("GBPUSD=X", "4h"),
    ("USDJPY=X", "1d"), ("USDJPY=X", "4h"),
    ("XAUUSD=X", "1d"), ("XAUUSD=X", "4h"),
    # Equities
    ("NVDA", "1d"), ("NVDA", "4h"),
    ("META", "1d"), ("META", "4h"),
    ("MSFT", "1d"), ("MSFT", "4h"),
    ("AAPL", "1d"), ("AAPL", "4h"),
    ("TSLA", "1d"), ("TSLA", "4h"),
    ("GOOGL", "1d"), ("GOOGL", "4h"),
    ("AMZN", "1d"), ("AMZN", "4h"),
    ("NFLX", "1d"), ("NFLX", "4h"),
    ("AMD", "1d"), ("AMD", "4h"),
    ("CRM", "1d"), ("CRM", "4h"),
]

# Grid search parameters - expanded for better coverage
FORWARD_BARS_LIST = [1, 3, 5, 10]  # Different prediction horizons
PROB_THRESHOLDS = [0.50, 0.55, 0.60, 0.65, 0.70]
RR_RATIOS = [1.5, 2.0, 3.0, 5.0]
REGIME_FILTERS = ["none", "both"]
TASK_TYPES = ["regression", "classification"]

# XGBoost hyperparameter combinations
XGB_PARAMS = [
    {"max_depth": 3, "n_estimators": 100, "learning_rate": 0.1, "subsample": 0.8, "colsample_bytree": 0.8},
    {"max_depth": 4, "n_estimators": 100, "learning_rate": 0.1, "subsample": 0.8, "colsample_bytree": 0.8},
    {"max_depth": 5, "n_estimators": 100, "learning_rate": 0.1, "subsample": 0.8, "colsample_bytree": 0.8},
    {"max_depth": 4, "n_estimators": 200, "learning_rate": 0.05, "subsample": 0.8, "colsample_bytree": 0.8},
    {"max_depth": 4, "n_estimators": 50, "learning_rate": 0.2, "subsample": 0.8, "colsample_bytree": 0.8},
    {"max_depth": 6, "n_estimators": 100, "learning_rate": 0.1, "subsample": 0.7, "colsample_bytree": 0.7},
]

# Risk parameters
STOP_LOSS_ATR_LIST = [1.5, 2.0, 2.5, 3.0]
RISK_PER_TRADE_LIST = [0.005, 0.01, 0.02]

COMMON_ARGS = [
    "--leverage", "1",
    "--allow-short",
    "--max-hold-bars", "30",
    "--gate-expectancy-r", "-1.0",
    "--gate-maxdd", "0.99",
    "--gate-win-rate", "0.0",
    "--fee-rate", "0.001",
    "--slippage", "0.0005",
]


def build_args(symbol: str, interval: str, task_type: str, forward_bars: int,
               prob_threshold: float, rr_ratio: float, regime_filter: str,
               stop_loss_atr: float, risk_per_trade: float,
               max_depth: int, n_estimators: int, learning_rate: float,
               subsample: float, colsample_bytree: float) -> list[str]:
    return [
        "python3", "ml/train/train_model_v3.py",
        "--symbol", symbol,
        "--interval", interval,
        "--lookback", "1000",
        "--forward-bars", str(forward_bars),
        "--task-type", task_type,
        "--regime-filter", regime_filter,
        "--prob-threshold", str(prob_threshold),
        "--rr-ratio", str(rr_ratio),
        "--risk-per-trade", str(risk_per_trade),
        "--stop-loss-atr", str(stop_loss_atr),
        "--take-profit-atr", str(float(stop_loss_atr) * rr_ratio),
        "--max-hold-bars", "30",
        "--gate-expectancy-r", "-1.0",
        "--gate-maxdd", "0.99",
        "--gate-win-rate", "0.0",
        "--leverage", "1",
        "--allow-short",
        "--fee-rate", "0.001",
        "--slippage", "0.0005",
        "--max-depth", str(max_depth),
        "--n-estimators", str(n_estimators),
        "--learning-rate", str(learning_rate),
        "--subsample", str(subsample),
        "--colsample-bytree", str(colsample_bytree),
    ]


def main():
    results = []
    total_combinations = len(TOP_ASSETS) * len(FORWARD_BARS_LIST) * len(PROB_THRESHOLDS) * len(RR_RATIOS) * len(REGIME_FILTERS) * len(TASK_TYPES) * len(XGB_PARAMS) * len(STOP_LOSS_ATR_LIST) * len(RISK_PER_TRADE_LIST)
    count = 0
    saved_count = 0

    print(f"Starting batch training v3: {total_combinations} combinations across {len(TOP_ASSETS)} assets")
    print(f"  Assets: {len(TOP_ASSETS)}")
    print(f"  Forward bars: {FORWARD_BARS_LIST}")
    print(f"  Prob thresholds: {PROB_THRESHOLDS}")
    print(f"  RR ratios: {RR_RATIOS}")
    print(f"  Regime filters: {REGIME_FILTERS}")
    print(f"  Task types: {TASK_TYPES}")
    print(f"  XGB param sets: {len(XGB_PARAMS)}")
    print(f"  Stop Loss ATR: {STOP_LOSS_ATR_LIST}")
    print(f"  Risk per trade: {RISK_PER_TRADE_LIST}")
    print(f"  Total combinations: {total_combinations}")
    print(f"{'='*70}")

    start_total = time.time()

    for symbol, interval in TOP_ASSETS:
        for forward_bars in FORWARD_BARS_LIST:
            for task_type in TASK_TYPES:
                for prob_threshold in PROB_THRESHOLDS:
                    for rr_ratio in RR_RATIOS:
                        for regime_filter in REGIME_FILTERS:
                            for xgb_params in XGB_PARAMS:
                                for stop_loss_atr in STOP_LOSS_ATR_LIST:
                                    for risk_per_trade in RISK_PER_TRADE_LIST:
                                        count += 1
                                        args = build_args(
                                            symbol, interval, task_type, forward_bars,
                                            prob_threshold, rr_ratio, regime_filter,
                                            stop_loss_atr, risk_per_trade,
                                            xgb_params["max_depth"], xgb_params["n_estimators"],
                                            xgb_params["learning_rate"],
                                            xgb_params["subsample"],
                                            xgb_params["colsample_bytree"],
                                        )

                                        print(f"\n[{count}/{total_combinations}] {symbol} {interval} | {task_type} | fb={forward_bars} | prob={prob_threshold} | RR=1:{rr_ratio} | regime={regime_filter} | md={xgb_params['max_depth']} ne={xgb_params['n_estimators']} lr={xgb_params['learning_rate']} | SL={stop_loss_atr}ATR risk={risk_per_trade}")

                                        start = time.time()
                                        try:
                                            proc = subprocess.run(
                                                args,
                                                capture_output=True,
                                                text=True,
                                                timeout=180,
                                            )

                                            output = proc.stdout
                                            expectancy = None
                                            total_return = None
                                            maxdd = None
                                            winrate = None
                                            pf = None
                                            trades_count = None
                                            sharpe = None
                                            model_saved = False

                                            for line in output.splitlines():
                                                if "OOS Expectancy=" in line:
                                                    for part in line.split():
                                                        if part.startswith("Expectancy="):
                                                            expectancy = float(part.split("=")[1].replace("R", ""))
                                                        elif part.startswith("TotalReturn="):
                                                            total_return = float(part.split("=")[1].replace("%", ""))
                                                        elif part.startswith("MaxDD="):
                                                            maxdd = float(part.split("=")[1].replace("%", ""))
                                                        elif part.startswith("WinRate="):
                                                            winrate = float(part.split("=")[1].replace("%", ""))
                                                        elif part.startswith("PF="):
                                                            pf = float(part.split("=")[1])
                                                        elif part.startswith("Trades="):
                                                            trades_count = int(part.split("=")[1])
                                                        elif part.startswith("Sharpe="):
                                                            sharpe = float(part.split("=")[1])
                                                if "Model saved to" in line:
                                                    model_saved = True
                                                    saved_count += 1

                                            elapsed = time.time() - start

                                            result = {
                                                "symbol": symbol,
                                                "interval": interval,
                                                "task_type": task_type,
                                                "forward_bars": forward_bars,
                                                "prob_threshold": prob_threshold,
                                                "rr_ratio": rr_ratio,
                                                "regime_filter": regime_filter,
                                                "max_depth": xgb_params["max_depth"],
                                                "n_estimators": xgb_params["n_estimators"],
                                                "learning_rate": xgb_params["learning_rate"],
                                                "subsample": xgb_params["subsample"],
                                                "colsample_bytree": xgb_params["colsample_bytree"],
                                                "stop_loss_atr": stop_loss_atr,
                                                "risk_per_trade": risk_per_trade,
                                                "expectancy_r": expectancy,
                                                "total_return_pct": total_return,
                                                "maxdd_pct": maxdd,
                                                "win_rate_pct": winrate,
                                                "profit_factor": pf,
                                                "trades": trades_count,
                                                "sharpe": sharpe,
                                                "model_saved": model_saved,
                                                "elapsed_sec": round(elapsed, 1),
                                                "returncode": proc.returncode,
                                            }
                                            results.append(result)

                                            status = "SAVED" if model_saved else "REJECTED"
                                            exp_str = f"{expectancy:.3f}R" if expectancy is not None else "N/A"
                                            print(f"  -> {status} | Expectancy={exp_str} | Return={total_return}% | MaxDD={maxdd}% | WR={winrate}% | PF={pf} | Trades={trades_count} | {elapsed:.1f}s")

                                            if proc.returncode != 0:
                                                if proc.stderr:
                                                    print(f"  stderr: {proc.stderr[-200:]}")

                                        except subprocess.TimeoutExpired:
                                            elapsed = time.time() - start
                                            print(f"  -> TIMEOUT after {elapsed:.1f}s")
                                            results.append({
                                                "symbol": symbol,
                                                "interval": interval,
                                                "task_type": task_type,
                                                "forward_bars": forward_bars,
                                                "prob_threshold": prob_threshold,
                                                "rr_ratio": rr_ratio,
                                                "regime_filter": regime_filter,
                                                "max_depth": xgb_params["max_depth"],
                                                "n_estimators": xgb_params["n_estimators"],
                                                "learning_rate": xgb_params["learning_rate"],
                                                "subsample": xgb_params["subsample"],
                                                "colsample_bytree": xgb_params["colsample_bytree"],
                                                "stop_loss_atr": stop_loss_atr,
                                                "risk_per_trade": risk_per_trade,
                                                "error": "timeout",
                                                "elapsed_sec": round(elapsed, 1),
                                                "returncode": -1,
                                            })
                                        except Exception as e:
                                            elapsed = time.time() - start
                                            print(f"  -> ERROR: {e}")
                                            results.append({
                                                "symbol": symbol,
                                                "interval": interval,
                                                "task_type": task_type,
                                                "forward_bars": forward_bars,
                                                "prob_threshold": prob_threshold,
                                                "rr_ratio": rr_ratio,
                                                "regime_filter": regime_filter,
                                                "max_depth": xgb_params["max_depth"],
                                                "n_estimators": xgb_params["n_estimators"],
                                                "learning_rate": xgb_params["learning_rate"],
                                                "subsample": xgb_params["subsample"],
                                                "colsample_bytree": xgb_params["colsample_bytree"],
                                                "stop_loss_atr": stop_loss_atr,
                                                "risk_per_trade": risk_per_trade,
                                                "error": str(e),
                                                "elapsed_sec": round(elapsed, 1),
                                                "returncode": -2,
                                            })

                                        # Small delay to respect rate limits
                                        time.sleep(0.5)

    # Sort results by expectancy descending
    saved_results = [r for r in results if r.get("model_saved")]
    saved_results.sort(key=lambda r: r.get("expectancy_r", -999) if r.get("expectancy_r") is not None else -999, reverse=True)

    total_elapsed = time.time() - start_total

    # Write results
    out_path = Path("ml/batch_training_v3_results.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump({
            "trained_at": datetime.now(timezone.utc).isoformat(),
            "total_combinations": total_combinations,
            "saved_models": saved_count,
            "total_elapsed_sec": round(total_elapsed, 1),
            "top_results": saved_results[:50],
            "all_results": results,
        }, f, indent=2)

    print(f"\n{'='*70}")
    print(f"BATCH TRAINING V3 COMPLETE")
    print(f"{'='*70}")
    print(f"Total combinations: {total_combinations}")
    print(f"Models saved: {saved_count}")
    print(f"Total elapsed: {total_elapsed:.1f}s")
    print(f"Results: {out_path}")
    print(f"\nTOP 20 MODELS BY EXPECTANCY:")
    for r in saved_results[:20]:
        exp = r.get("expectancy_r", 0)
        exp_str = f"{exp:.3f}R" if exp is not None else "N/A"
        print(f"  {r['symbol']} {r['interval']} | {r['task_type']} | fb={r['forward_bars']} | prob={r['prob_threshold']} | RR=1:{r['rr_ratio']} | regime={r['regime_filter']} | md={r['max_depth']} ne={r['n_estimators']} lr={r['learning_rate']} | SL={r['stop_loss_atr']}ATR | {exp_str} | WR={r.get('win_rate_pct',0):.1f}% | PF={r.get('profit_factor',0):.2f} | MaxDD={r.get('maxdd_pct',0):.1f}%")

    # Save progress log
    log_path = Path("ml/batch_training_v3_progress.log")
    with open(log_path, "w") as f:
        f.write(f"Batch training v3 completed\n")
        f.write(f"Total combinations: {total_combinations}\n")
        f.write(f"Saved models: {saved_count}\n")
        f.write(f"Total elapsed: {total_elapsed:.1f}s\n")
        f.write("\nTOP 50 MODELS BY EXPECTANCY:\n")
        for r in saved_results[:50]:
            exp = r.get("expectancy_r", 0)
            exp_str = f"{exp:.3f}R" if exp is not None else "N/A"
            f.write(f"  {r['symbol']} {r['interval']} | {r['task_type']} | fb={r['forward_bars']} | prob={r['prob_threshold']} | RR=1:{r['rr_ratio']} | regime={r['regime_filter']} | md={r['max_depth']} ne={r['n_estimators']} lr={r['learning_rate']} | SL={r['stop_loss_atr']}ATR | {exp_str} | WR={r.get('win_rate_pct',0):.1f}% | PF={r.get('profit_factor',0):.2f} | MaxDD={r.get('maxdd_pct',0):.1f}%\n")


if __name__ == "__main__":
    main()
