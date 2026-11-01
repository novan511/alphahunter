#!/usr/bin/env python3
"""Batch training v2: Grid search on top assets across timeframes and parameters.

Tests:
- Top assets from previous run
- Timeframes: 1h, 4h, 1d
- Task type: regression (classification inference not yet in TS)
- Prob thresholds: 0.50, 0.55, 0.65
- RR ratios: 1:1.5, 1:2, 1:3
- Regime filters: none, both

Exports results to ml/batch_training_v2_results.json.
Logs progress to ml/batch_training_v2_progress.log.
"""

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# Top assets from previous batch run (those with positive/near-positive expectancy)
TOP_ASSETS = [
    # Crypto
    ("MATICUSDT", "1d"), ("MATICUSDT", "4h"),
    ("BNBUSDT", "1d"), ("BNBUSDT", "4h"),
    ("BTCUSDT", "1d"), ("BTCUSDT", "4h"),
    ("ETHUSDT", "1d"), ("ETHUSDT", "4h"),
    ("XRPUSDT", "1d"), ("XRPUSDT", "4h"),
    ("ADAUSDT", "1d"), ("ADAUSDT", "4h"),
    ("SOLUSDT", "1d"), ("SOLUSDT", "4h"),
    ("AVAXUSDT", "1d"), ("AVAXUSDT", "4h"),
    # Commodities
    ("GC=F", "1d"), ("GC=F", "4h"),
    ("SI=F", "1d"), ("SI=F", "4h"),
    ("CL=F", "1d"), ("CL=F", "4h"),
    ("NG=F", "1d"),
    # Indices
    ("^N225", "1d"), ("^N225", "4h"),
    ("^VIX", "1d"), ("^VIX", "4h"),
    ("^GSPC", "1d"), ("^GSPC", "4h"),
    ("^IXIC", "1d"), ("^IXIC", "4h"),
    ("^DJI", "1d"),
    ("^KS11", "1d"),
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
    ("GOOGL", "1d"),
    ("AMZN", "1d"),
    ("NFLX", "1d"),
    ("AMD", "1d"),
    ("CRM", "1d"),
]

# Grid search parameters - REGRESSION ONLY
PROB_THRESHOLDS = [0.50, 0.55, 0.65]
RR_RATIOS = [1.5, 2.0, 3.0]
REGIME_FILTERS = ["none", "both"]
TASK_TYPES = ["regression"]

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
               rr_ratio: float, regime_filter: str) -> list[str]:
    return [
        "python3", "ml/train/train_model.py",
        "--symbol", symbol,
        "--interval", interval,
        "--forward-bars", "3",
        "--task-type", task_type,
        "--regime-filter", regime_filter,
        "--prob-threshold", str(prob_threshold),
        "--rr-ratio", str(rr_ratio),
    ] + COMMON_ARGS


def main():
    results = []
    total_combinations = len(TOP_ASSETS) * len(PROB_THRESHOLDS) * len(RR_RATIOS) * len(REGIME_FILTERS) * len(TASK_TYPES)
    count = 0
    saved_count = 0

    print(f"Starting batch training v2: {total_combinations} combinations across {len(TOP_ASSETS)} assets")
    print(f"  Assets: {len(TOP_ASSETS)}")
    print(f"  Prob thresholds: {PROB_THRESHOLDS}")
    print(f"  RR ratios: {RR_RATIOS}")
    print(f"  Regime filters: {REGIME_FILTERS}")
    print(f"  Task types: {TASK_TYPES}")
    print(f"  Total combinations: {total_combinations}")
    print(f"{'='*70}")

    start_total = time.time()

    for symbol, interval in TOP_ASSETS:
        for task_type in TASK_TYPES:
            for prob_threshold in PROB_THRESHOLDS:
                for rr_ratio in RR_RATIOS:
                    for regime_filter in REGIME_FILTERS:
                        count += 1
                        args = build_args(symbol, interval, task_type, prob_threshold, rr_ratio, regime_filter)

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
                            trades = None
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
                                            trades = int(part.split("=")[1])
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
                                "expectancy_r": expectancy,
                                "total_return_pct": total_return,
                                "maxdd_pct": maxdd,
                                "win_rate_pct": winrate,
                                "profit_factor": pf,
                                "trades": trades,
                                "sharpe": sharpe,
                                "model_saved": model_saved,
                                "elapsed_sec": round(elapsed, 1),
                                "returncode": proc.returncode,
                            }
                            results.append(result)

                            status = "SAVED" if model_saved else "REJECTED"
                            exp_str = f"{expectancy:.3f}R" if expectancy is not None else "N/A"
                            print(f"  -> {status} | Expectancy={exp_str} | Return={total_return}% | MaxDD={maxdd}% | WR={winrate}% | PF={pf} | Trades={trades} | {elapsed:.1f}s")

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
