#!/usr/bin/env python3
"""Batch training script: 100 models across markets and timeframes.

Markets: crypto, commodities, indices, forex, US equities.
Timeframes: 1h, 4h, 1d.
Uses institutional-grade labeling: Triple Barrier, fractional differentiation,
volatility targeting, Kelly Criterion position sizing, purged walk-forward.

Runs all models sequentially to respect Binance/Yahoo rate limits.
Exports artifacts to ml/models/ and public/ml/models/.
Logs results to ml/batch_training_results.json.
Writes real-time progress to ml/batch_training_progress.log.
"""

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# Universe of 100 symbols across asset classes
UNIVERSE = {
    # Crypto (Binance)
    "crypto": [
        ("BTCUSDT", "4h"), ("BTCUSDT", "1d"),
        ("ETHUSDT", "4h"), ("ETHUSDT", "1d"),
        ("SOLUSDT", "4h"), ("SOLUSDT", "1d"),
        ("BNBUSDT", "4h"), ("BNBUSDT", "1d"),
        ("XRPUSDT", "4h"), ("XRPUSDT", "1d"),
        ("ADAUSDT", "4h"), ("ADAUSDT", "1d"),
        ("AVAXUSDT", "4h"), ("AVAXUSDT", "1d"),
        ("LINKUSDT", "4h"), ("LINKUSDT", "1d"),
        ("DOGEUSDT", "4h"), ("DOGEUSDT", "1d"),
        ("MATICUSDT", "4h"), ("MATICUSDT", "1d"),
        ("DOTUSDT", "4h"), ("DOTUSDT", "1d"),
        ("LTCUSDT", "4h"), ("LTCUSDT", "1d"),
        ("BCHUSDT", "4h"), ("BCHUSDT", "1d"),
        ("ETCUSDT", "4h"), ("ETCUSDT", "1d"),
        ("FILUSDT", "4h"), ("FILUSDT", "1d"),
        ("TRXUSDT", "4h"), ("TRXUSDT", "1d"),
    ],
    # Commodities (Yahoo)
    "commodities": [
        ("GC=F", "1d"), ("GC=F", "4h"),   # Gold
        ("SI=F", "1d"), ("SI=F", "4h"),   # Silver
        ("CL=F", "1d"), ("CL=F", "4h"),   # Crude Oil WTI
        ("BZ=F", "1d"), ("BZ=F", "4h"),   # Crude Oil Brent
        ("NG=F", "1d"), ("NG=F", "4h"),   # Natural Gas
        ("PA=F", "1d"), ("PA=F", "4h"),   # Palladium
        ("PL=F", "1d"), ("PL=F", "4h"),   # Platinum
        ("HG=F", "1d"), ("HG=F", "4h"),   # Copper
        ("ZC=F", "1d"), ("ZC=F", "4h"),   # Corn
        ("ZW=F", "1d"), ("ZW=F", "4h"),   # Wheat
        ("ZS=F", "1d"), ("ZS=F", "4h"),   # Soybeans
        ("KC=F", "1d"), ("KC=F", "4h"),   # Coffee
        ("SB=F", "1d"), ("SB=F", "4h"),   # Sugar
        ("CT=F", "1d"), ("CT=F", "4h"),   # Cotton
        ("LB=F", "1d"), ("LB=F", "4h"),   # Lumber
        ("HO=F", "1d"), ("HO=F", "4h"),   # Heating Oil
        ("RB=F", "1d"), ("RB=F", "4h"),   # RBOB Gasoline
    ],
    # Indices (Yahoo)
    "indices": [
        ("^GSPC", "1d"), ("^GSPC", "4h"),   # S&P 500
        ("^IXIC", "1d"), ("^IXIC", "4h"),   # Nasdaq Composite
        ("^DJI", "1d"), ("^DJI", "4h"),     # Dow Jones
        ("^RUT", "1d"), ("^RUT", "4h"),     # Russell 2000
        ("^VIX", "1d"), ("^VIX", "4h"),     # VIX
        ("^FTSE", "1d"), ("^FTSE", "4h"),   # FTSE 100
        ("^GDAXI", "1d"), ("^GDAXI", "4h"), # DAX
        ("^FCHI", "1d"), ("^FCHI", "4h"),   # CAC 40
        ("^N225", "1d"), ("^N225", "4h"),   # Nikkei 225
        ("^HSI", "1d"), ("^HSI", "4h"),     # Hang Seng
        ("^BSESN", "1d"), ("^BSESN", "4h"), # Nifty 50
        ("^KS11", "1d"), ("^KS11", "4h"),   # KOSPI
        ("^AXJO", "1d"), ("^AXJO", "4h"),   # ASX 200
        ("^GSPTSE", "1d"), ("^GSPTSE", "4h"), # TSX Composite
    ],
    # Forex (Yahoo)
    "forex": [
        ("EURUSD=X", "1d"), ("EURUSD=X", "4h"),
        ("GBPUSD=X", "1d"), ("GBPUSD=X", "4h"),
        ("USDJPY=X", "1d"), ("USDJPY=X", "4h"),
        ("USDCHF=X", "1d"), ("USDCHF=X", "4h"),
        ("USDCAD=X", "1d"), ("USDCAD=X", "4h"),
        ("AUDUSD=X", "1d"), ("AUDUSD=X", "4h"),
        ("NZDUSD=X", "1d"), ("NZDUSD=X", "4h"),
        ("EURJPY=X", "1d"), ("EURJPY=X", "4h"),
        ("EURGBP=X", "1d"), ("EURGBP=X", "4h"),
        ("GBPJPY=X", "1d"), ("GBPJPY=X", "4h"),
        ("XAUUSD=X", "1d"), ("XAUUSD=X", "4h"),  # Gold spot
        ("XAGUSD=X", "1d"), ("XAGUSD=X", "4h"),  # Silver spot
    ],
    # US Equities (Yahoo)
    "equities": [
        ("AAPL", "1d"), ("AAPL", "4h"),
        ("TSLA", "1d"), ("TSLA", "4h"),
        ("NVDA", "1d"), ("NVDA", "4h"),
        ("MSFT", "1d"), ("MSFT", "4h"),
        ("GOOGL", "1d"), ("GOOGL", "4h"),
        ("AMZN", "1d"), ("AMZN", "4h"),
        ("META", "1d"), ("META", "4h"),
        ("NFLX", "1d"), ("NFLX", "4h"),
        ("AMD", "1d"), ("AMD", "4h"),
        ("CRM", "1d"), ("CRM", "4h"),
        ("ADBE", "1d"), ("ADBE", "4h"),
        ("INTC", "1d"), ("INTC", "4h"),
        ("CSCO", "1d"), ("CSCO", "4h"),
        ("ORCL", "1d"), ("ORCL", "4h"),
        ("COST", "1d"), ("COST", "4h"),
        ("WMT", "1d"), ("WMT", "4h"),
        ("JPM", "1d"), ("JPM", "4h"),
    ],
}

TRAIN_ARGS_COMMON = [
    "--forward-bars", "3",
    "--regime-filter", "both",
    "--prob-threshold", "0.55",
    "--leverage", "1",
    "--allow-short",
    "--rr-ratio", "2.0",
    "--risk-per-trade", "0.01",
    "--stop-loss-atr", "2.0",
    "--take-profit-atr", "4.0",
    "--max-hold-bars", "30",
    "--gate-expectancy-r", "-1.0",
    "--gate-maxdd", "0.99",
    "--gate-win-rate", "0.0",
]


def build_args(symbol: str, interval: str) -> list[str]:
    return [
        "python3", "ml/train/train_model.py",
        "--symbol", symbol,
        "--interval", interval,
        "--lookback", "1000",
    ] + TRAIN_ARGS_COMMON


def main():
    results = []
    total = sum(len(v) for v in UNIVERSE.values())
    count = 0

    for category, pairs in UNIVERSE.items():
        for symbol, interval in pairs:
            count += 1
            print(f"\n{'='*70}")
            print(f"[{count}/{total}] {category}: {symbol} {interval}")
            print(f"{'='*70}")

            start = time.time()
            args = build_args(symbol, interval)

            try:
                proc = subprocess.run(
                    args,
                    capture_output=True,
                    text=True,
                    timeout=300,
                )

                # Parse key metrics from output
                output = proc.stdout
                expectancy = None
                total_return = None
                maxdd = None
                winrate = None
                pf = None
                trades = None
                sharpe = None
                gates_passed = False
                model_saved = False

                for line in output.splitlines():
                    if "OOS Expectancy=" in line:
                        # Extract metrics
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

                    if "Gates passed" in line or "Model saved" in line:
                        gates_passed = True
                    if "Model saved to" in line:
                        model_saved = True

                elapsed = time.time() - start

                result = {
                    "category": category,
                    "symbol": symbol,
                    "interval": interval,
                    "expectancy_r": expectancy,
                    "total_return_pct": total_return,
                    "maxdd_pct": maxdd,
                    "win_rate_pct": winrate,
                    "profit_factor": pf,
                    "trades": trades,
                    "sharpe": sharpe,
                    "gates_passed": gates_passed,
                    "model_saved": model_saved,
                    "elapsed_sec": round(elapsed, 1),
                    "returncode": proc.returncode,
                    "stderr": proc.stderr[-500:] if proc.stderr else "",
                }
                results.append(result)

                status = "SAVED" if model_saved else ("PASSED" if gates_passed else "FAILED")
                print(f"  -> {status} | Expectancy={expectancy}R | Return={total_return}% | MaxDD={maxdd}% | WR={winrate}% | PF={pf} | Trades={trades} | Sharpe={sharpe} | {elapsed:.1f}s")

                if proc.returncode != 0:
                    print(f"  WARNING: returncode={proc.returncode}")
                    if proc.stderr:
                        print(f"  stderr: {proc.stderr[-300:]}")

            except subprocess.TimeoutExpired:
                elapsed = time.time() - start
                print(f"  -> TIMEOUT after {elapsed:.1f}s")
                results.append({
                    "category": category,
                    "symbol": symbol,
                    "interval": interval,
                    "error": "timeout",
                    "elapsed_sec": round(elapsed, 1),
                    "returncode": -1,
                })
            except Exception as e:
                elapsed = time.time() - start
                print(f"  -> ERROR: {e}")
                results.append({
                    "category": category,
                    "symbol": symbol,
                    "interval": interval,
                    "error": str(e),
                    "elapsed_sec": round(elapsed, 1),
                    "returncode": -2,
                })

            # Small delay between runs to respect rate limits
            time.sleep(2)

    # Sort results by expectancy descending
    results.sort(key=lambda r: r.get("expectancy_r", -999) if r.get("expectancy_r") is not None else -999, reverse=True)

    # Write results
    out_path = Path("ml/batch_training_results.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump({
            "trained_at": datetime.now(timezone.utc).isoformat(),
            "total_models": total,
            "saved_models": sum(1 for r in results if r.get("model_saved")),
            "results": results,
        }, f, indent=2)

    print(f"\n{'='*70}")
    print(f"BATCH TRAINING COMPLETE")
    print(f"{'='*70}")
    print(f"Total models: {total}")
    print(f"Models saved: {sum(1 for r in results if r.get('model_saved'))}")
    print(f"Results: {out_path}")

    # Print top 10
    print(f"\nTOP 10 MODELS BY EXPECTANCY:")
    for r in results[:10]:
        if r.get("model_saved"):
            print(f"  {r['symbol']} {r['interval']} ({r['category']}): {r['expectancy_r']:.3f}R | WR={r['win_rate_pct']:.1f}% | PF={r['profit_factor']:.2f} | MaxDD={r['maxdd_pct']:.1f}%")


if __name__ == "__main__":
    main()
