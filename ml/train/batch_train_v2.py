#!/usr/bin/env python3
from __future__ import annotations

"""Batch training v2: Grid search on top assets across timeframes and parameters.

Tests:
- Top assets from previous run
- Timeframes: 1h, 4h, 1d
- Task type: regression (classification inference not yet in TS)
- Prob thresholds: 0.50, 0.55, 0.65
- RR ratios: 1:1.5, 1:2, 1:3
- Regime filters: none, both

Exports results to ml/batch_training_v2_results.json.
Saves model metrics, backtest results, and trade list to Supabase.
Logs progress to ml/batch_training_v2_progress.log.
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

# Load .env.local if available
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
SUPABASE_URL = os.environ.get("SUPABASE_URL", "") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "").rstrip("/")
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
    """Insert a row into Supabase table."""
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
    """Upsert a row into Supabase table."""
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


# Top assets from previous batch run (those with positive/near-positive expectancy)
TOP_ASSETS = [
    # Top performers - 1d timeframe focus
    ("MATICUSDT", "1d"),
    ("NVDA", "1d"),
    ("BNBUSDT", "1d"),
    ("SOLUSDT", "1d"),
    ("XRPUSDT", "1d"),
    ("ADAUSDT", "1d"),
    ("GC=F", "1d"),  # Gold
    ("^GSPC", "1d"),  # S&P 500
    ("^N225", "1d"),  # Nikkei 225
    ("EURUSD=X", "1d"),  # EUR/USD
    ("AAPL", "1d"),  # Apple
    ("TSLA", "1d"),  # Tesla
]

# Grid search parameters - REGRESSION ONLY
PROB_THRESHOLDS = [0.50, 0.55, 0.65]
RR_RATIOS = [1.5, 2.0, 3.0]
REGIME_FILTERS = ["none", "both"]
TASK_TYPES = ["regression"]

# XGBoost hyperparameter grid
XGB_PARAMS = [
    {"max_depth": 3, "n_estimators": 100, "learning_rate": 0.1, "subsample": 0.8, "colsample_bytree": 0.8},
    {"max_depth": 4, "n_estimators": 100, "learning_rate": 0.1, "subsample": 0.8, "colsample_bytree": 0.8},
    {"max_depth": 4, "n_estimators": 200, "learning_rate": 0.05, "subsample": 0.8, "colsample_bytree": 0.8},
    {"max_depth": 5, "n_estimators": 100, "learning_rate": 0.1, "subsample": 0.8, "colsample_bytree": 0.8},
]

# Common args
COMMON_ARGS = [
    "--lookback", "1000",
    "--leverage", "1",
    "--allow-short",
    "--risk-per-trade", "0.01",
    "--stop-loss-atr", "2.0",
    "--max-hold-bars", "30",
    "--gate-expectancy-r", "-1.0",
    "--gate-maxdd", "0.99",
    "--gate-win-rate", "0.0",
]


def build_args(symbol: str, interval: str, task_type: str, prob_threshold: float,
               rr_ratio: float, regime_filter: str, xgb_params: dict) -> list[str]:
    return [
        "python3", "ml/train/train_model.py",
        "--symbol", symbol,
        "--interval", interval,
        "--forward-bars", "3",
        "--task-type", task_type,
        "--regime-filter", regime_filter,
        "--prob-threshold", str(prob_threshold),
        "--rr-ratio", str(rr_ratio),
        "--max-depth", str(xgb_params["max_depth"]),
        "--n-estimators", str(xgb_params["n_estimators"]),
        "--learning-rate", str(xgb_params["learning_rate"]),
        "--subsample", str(xgb_params["subsample"]),
        "--colsample-bytree", str(xgb_params["colsample_bytree"]),
    ] + COMMON_ARGS


def save_model_metrics(result: dict, meta: Optional[dict] = None) -> Optional[dict]:
    """Save model metrics to Supabase ml_model_metrics."""
    oos = result.get("oos_metrics", {}) or {}
    row = {
        "symbol": result["symbol"],
        "interval": result["interval"],
        "task_type": result.get("task_type", "regression"),
        "regime_filter": result.get("regime_filter", "none"),
        "prob_threshold": result.get("prob_threshold"),
        "rr_ratio": result.get("rr_ratio"),
        "risk_per_trade": 0.01,
        "stop_loss_atr": 2.0,
        "take_profit_atr": 4.0,
        "max_hold_bars": 30,
        "leverage": 1.0,
        "allow_short": True,
        "lookback": 1000,
        "forward_bars": 3,
        "expectancy_r": result.get("expectancy_r"),
        "total_return_pct": result.get("total_return_pct"),
        "maxdd_pct": result.get("maxdd_pct"),
        "win_rate_pct": result.get("win_rate_pct"),
        "profit_factor": result.get("profit_factor"),
        "sharpe": result.get("sharpe"),
        "total_trades": result.get("trades"),
        "gates_passed": result.get("model_saved", False),
        "file_exists": result.get("model_saved", False),
        "meta": meta or {},
    }
    return supabase_upsert("ml_model_metrics", row, "symbol,interval")


def save_backtest_result(result: dict) -> Optional[str]:
    """Save backtest result to Supabase ml_backtest_results. Returns backtest id."""
    oos = result.get("oos_metrics", {}) or {}
    row = {
        "symbol": result["symbol"],
        "interval": result["interval"],
        "leverage": 1.0,
        "allow_short": True,
        "rr_ratio": result.get("rr_ratio", 2.0),
        "risk_per_trade": 0.01,
        "total_trades": result.get("trades"),
        "winning_trades": result.get("winning_trades"),
        "losing_trades": result.get("losing_trades"),
        "win_rate": result.get("win_rate_pct"),
        "total_return_pct": result.get("total_return_pct"),
        "final_capital": result.get("final_capital"),
        "profit_factor": result.get("profit_factor"),
        "max_drawdown_pct": result.get("maxdd_pct"),
        "expectancy_r": result.get("expectancy_r"),
        "avg_r": result.get("avg_r"),
        "sharpe": result.get("sharpe"),
        "avg_bars_held": result.get("avg_bars_held"),
        "config": {
            "risk_per_trade": 0.01,
            "stop_loss_atr": 2.0,
            "take_profit_atr": 4.0,
            "max_hold_bars": 30,
            "prob_threshold": result.get("prob_threshold"),
            "fee_rate": 0.001,
            "slippage": 0.0005,
        },
        "guardrail_stats": result.get("guardrail_stats", {}),
    }
    res = supabase_upsert("ml_backtest_results", row, "symbol,interval")
    if res and len(res) > 0:
        return res[0].get("id")
    return None


def save_trades(backtest_id: str, trades: list[dict], symbol: str, interval: str):
    """Save individual trades to Supabase ml_trade_list."""
    if not trades:
        return
    rows = []
    for t in trades:
        rows.append({
            "symbol": symbol,
            "interval": interval,
            "trade_id": t.get("id", 0),
            "entry_time": datetime.fromtimestamp(t["entry_time"] / 1000, tz=timezone.utc).isoformat() if t.get("entry_time") else None,
            "exit_time": datetime.fromtimestamp(t["exit_time"] / 1000, tz=timezone.utc).isoformat() if t.get("exit_time") else None,
            "entry_price": t.get("entry_price"),
            "exit_price": t.get("exit_price"),
            "side": t.get("side"),
            "qty": t.get("qty"),
            "notional": t.get("notional"),
            "pnl": t.get("pnl"),
            "pnl_percent": t.get("pnl_percent"),
            "r_multiple": t.get("r_multiple"),
            "exit_reason": t.get("exit_reason"),
            "bars_held": t.get("bars_held"),
            "probability_up": t.get("probability_up"),
            "probability_down": t.get("probability_down"),
            "regime_pass": t.get("regime_pass"),
            "backtest_id": backtest_id,
        })
    # Insert in batches of 100
    for i in range(0, len(rows), 100):
        supabase_insert("ml_trade_list", rows[i:i + 100])


def main():
    results = []
    total_combinations = len(TOP_ASSETS) * len(PROB_THRESHOLDS) * len(RR_RATIOS) * len(REGIME_FILTERS) * len(TASK_TYPES) * len(XGB_PARAMS)
    count = 0
    saved_count = 0

    print(f"Starting batch training v2: {total_combinations} combinations across {len(TOP_ASSETS)} assets")
    print(f"  Assets: {len(TOP_ASSETS)}")
    print(f"  Prob thresholds: {PROB_THRESHOLDS}")
    print(f"  RR ratios: {RR_RATIOS}")
    print(f"  Regime filters: {REGIME_FILTERS}")
    print(f"  Task types: {TASK_TYPES}")
    print(f"  XGB param sets: {len(XGB_PARAMS)}")
    print(f"  Total combinations: {total_combinations}")
    print(f"{'='*70}")

    start_total = time.time()

    for symbol, interval in TOP_ASSETS:
        for task_type in TASK_TYPES:
            for prob_threshold in PROB_THRESHOLDS:
                for rr_ratio in RR_RATIOS:
                    for regime_filter in REGIME_FILTERS:
                        for xgb_params in XGB_PARAMS:
                            count += 1
                            args = build_args(symbol, interval, task_type, prob_threshold, rr_ratio, regime_filter, xgb_params)

                        print(f"\n[{count}/{total_combinations}] {symbol} {interval} | {task_type} | prob={prob_threshold} | RR=1:{rr_ratio} | regime={regime_filter}")

                        start = time.time()
                        try:
                            proc = subprocess.run(
                                args,
                                capture_output=True,
                                text=True,
                                timeout=120,
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
                            oos_metrics = {}
                            trades_list = []

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
                                "prob_threshold": prob_threshold,
                                "rr_ratio": rr_ratio,
                                "regime_filter": regime_filter,
                                "max_depth": xgb_params["max_depth"],
                                "n_estimators": xgb_params["n_estimators"],
                                "learning_rate": xgb_params["learning_rate"],
                                "subsample": xgb_params["subsample"],
                                "colsample_bytree": xgb_params["colsample_bytree"],
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

                            # Save to Supabase if model was saved
                            if model_saved and expectancy is not None:
                                save_model_metrics(result)
                                # Also run backtest and save trades
                                bt_result = save_backtest_result(result)
                                if bt_result:
                                    save_trades(bt_result, trades_list, symbol, interval)

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
                                "prob_threshold": prob_threshold,
                                "rr_ratio": rr_ratio,
                                "regime_filter": regime_filter,
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
                                "prob_threshold": prob_threshold,
                                "rr_ratio": rr_ratio,
                                "regime_filter": regime_filter,
                                "error": str(e),
                                "elapsed_sec": round(elapsed, 1),
                                "returncode": -2,
                            })

                        # Small delay to respect rate limits
                        time.sleep(1)

    # Sort results by expectancy descending (only model_saved ones first)
    saved_results = [r for r in results if r.get("model_saved")]
    rejected_results = [r for r in results if not r.get("model_saved")]
    saved_results.sort(key=lambda r: r.get("expectancy_r", -999) if r.get("expectancy_r") is not None else -999, reverse=True)

    total_elapsed = time.time() - start_total

    # Write results
    out_path = Path("ml/batch_training_v2_results.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump({
            "trained_at": datetime.now(timezone.utc).isoformat(),
            "total_combinations": total_combinations,
            "saved_models": saved_count,
            "total_elapsed_sec": round(total_elapsed, 1),
            "top_results": saved_results[:30],
            "all_results": results,
        }, f, indent=2)

    # Write progress log
    log_path = Path("ml/batch_training_v2_progress.log")
    with open(log_path, "w") as f:
        f.write(f"Batch training v2 completed\n")
        f.write(f"Total combinations: {total_combinations}\n")
        f.write(f"Saved models: {saved_count}\n")
        f.write(f"Total elapsed: {total_elapsed:.1f}s\n")
        f.write("\nTOP 20 MODELS BY EXPECTANCY:\n")
        for r in saved_results[:20]:
            exp = r.get("expectancy_r", 0)
            exp_str = f"{exp:.3f}R" if exp is not None else "N/A"
            f.write(f"  {r['symbol']} {r['interval']} | {r['task_type']} | prob={r['prob_threshold']} | RR=1:{r['rr_ratio']} | regime={r['regime_filter']} | {exp_str} | WR={r.get('win_rate_pct', 0):.1f}% | PF={r.get('profit_factor', 0):.2f} | MaxDD={r.get('maxdd_pct', 0):.1f}%\n")

    print(f"\n{'='*70}")
    print(f"BATCH TRAINING V2 COMPLETE")
    print(f"{'='*70}")
    print(f"Total combinations: {total_combinations}")
    print(f"Models saved: {saved_count}")
    print(f"Total elapsed: {total_elapsed:.1f}s")
    print(f"Results: {out_path}")
    print(f"\nTOP 10 MODELS BY EXPECTANCY:")
    for r in saved_results[:10]:
        exp = r.get("expectancy_r", 0)
        exp_str = f"{exp:.3f}R" if exp is not None else "N/A"
        print(f"  {r['symbol']} {r['interval']} | {r['task_type']} | prob={r['prob_threshold']} | RR=1:{r['rr_ratio']} | regime={r['regime_filter']} | {exp_str} | WR={r.get('win_rate_pct', 0):.1f}% | PF={r.get('profit_factor', 0):.2f} | MaxDD={r.get('maxdd_pct', 0):.1f}%")


if __name__ == "__main__":
    main()
