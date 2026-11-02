#!/usr/bin/env python3
"""
ML Auto-Optimization Engine v1
================================
Sistem yang belajar dari hasil training sebelumnya dan terus berevolusi.
Tidak hanya grid search acak, tapi menggunakan evolutionary algorithm
dan mistake pattern analysis untuk mencari parameter terbaik.

Fitur:
1. Model Performance Tracking - catat semua hasil ke Supabase
2. Mistake Pattern Analysis - analisis kenapa model gagal
3. Evolutionary Optimization - cari parameter terbaik berdasarkan hasil sebelumnya
4. Auto-Retrain Loop - otomatis latihlah model baru dari hasil terbaik
"""

import json
import math
import os
import random
import statistics
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

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


def supabase_query(table: str, select: str = "*", filters: dict = None, order: str = None, limit: int = None) -> list:
    """Query data from Supabase table."""
    if not SUPABASE_HEADERS:
        return []
    try:
        params = {"select": select}
        if filters:
            for k, v in filters.items():
                params[f"{k}"] = f"eq.{v}"
        if order:
            params["order"] = order
        if limit:
            params["limit"] = str(limit)

        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/{table}",
            headers=SUPABASE_HEADERS,
            params=params,
            timeout=30,
        )
        if resp.status_code == 200:
            return resp.json()
        print(f"  Supabase query {table} failed: {resp.status_code} {resp.text[:200]}")
        return []
    except Exception as e:
        print(f"  Supabase query {table} error: {e}")
        return []


# ============================================================================
# ML OPTIMIZATION ENGINE
# ============================================================================

class MLOptimizer:
    """
    Engine yang belajar dari hasil training sebelumnya dan terus berevolusi.
    Menggunakan evolutionary algorithm untuk mencari parameter terbaik.
    """

    def __init__(self):
        self.asset_universe = [
            "MATICUSDT", "BNBUSDT", "BTCUSDT", "ETHUSDT", "XRPUSDT",
            "ADAUSDT", "SOLUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT",
            "GC=F", "SI=F", "CL=F", "NG=F",
            "^N225", "^VIX", "^GSPC", "^IXIC", "^DJI", "^KS11",
            "EURUSD=X", "GBPUSD=X", "USDJPY=X", "XAUUSD=X",
            "NVDA", "META", "MSFT", "AAPL", "TSLA", "GOOGL", "AMZN",
            "NFLX", "AMD", "CRM",
        ]
        self.timeframes = ["1d", "4h"]

    def get_top_models(self, limit: int = 20) -> list:
        """Ambil model terbaik dari Supabase berdasarkan expectancy."""
        return supabase_query(
            "ml_model_metrics",
            select="*",
            filters={"gates_passed": "true"},
            order="expectancy_r.desc",
            limit=limit,
        )

    def get_all_results(self) -> list:
        """Ambil semua hasil training dari Supabase."""
        return supabase_query(
            "ml_model_metrics",
            select="*",
            order="trained_at.desc",
            limit=500,
        )

    def analyze_feature_importance_across_models(self, results: list) -> dict:
        """
        Analisis fitur mana yang paling sering muncul di model terbaik.
        """
        if not results:
            return {}

        # Kumpulkan feature importance dari semua model
        feature_scores = {}
        for r in results:
            meta = r.get("meta", {})
            if isinstance(meta, str):
                try:
                    meta = json.loads(meta)
                except:
                    meta = {}
            feature_importance = meta.get("feature_importance", {})
            if isinstance(feature_importance, str):
                try:
                    feature_importance = json.loads(feature_importance)
                except:
                    feature_importance = {}

            expectancy = r.get("oos_metrics", {}).get("oos_expectancy_r", 0)
            if isinstance(expectancy, str):
                try:
                    expectancy = float(expectancy)
                except:
                    expectancy = 0

            # Weight feature importance by expectancy (better models = more weight)
            weight = max(expectancy, 0.01)
            for feature, importance in feature_importance.items():
                if feature not in feature_scores:
                    feature_scores[feature] = {"total_importance": 0, "count": 0, "weighted_importance": 0}
                feature_scores[feature]["total_importance"] += importance
                feature_scores[feature]["count"] += 1
                feature_scores[feature]["weighted_importance"] += importance * weight

        # Hitung rata-rata weighted importance
        for feat, data in feature_scores.items():
            data["avg_importance"] = data["total_importance"] / data["count"] if data["count"] > 0 else 0
            data["avg_weighted_importance"] = data["weighted_importance"] / data["count"] if data["count"] > 0 else 0

        # Sort by weighted importance
        sorted_features = sorted(feature_scores.items(), key=lambda x: x[1]["avg_weighted_importance"], reverse=True)
        return dict(sorted_features)

    def analyze_parameter_correlation(self, results: list) -> dict:
        """
        Analisis parameter mana yang berkaitan dengan performa baik.
        """
        if not results:
            return {}

        param_performance = {}
        for r in results:
            meta = r.get("meta", {})
            if isinstance(meta, str):
                try:
                    meta = json.loads(meta)
                except:
                    meta = {}

            expectancy = r.get("oos_expectancy_r", 0)
            if isinstance(expectancy, str):
                try:
                    expectancy = float(expectancy)
                except:
                    expectancy = 0

            params = {
                "prob_threshold": r.get("prob_threshold"),
                "rr_ratio": r.get("rr_ratio"),
                "regime_filter": r.get("regime_filter"),
                "stop_loss_atr": r.get("stop_loss_atr"),
                "take_profit_atr": r.get("take_profit_atr"),
                "risk_per_trade": r.get("risk_per_trade"),
                "max_hold_bars": r.get("max_hold_bars"),
                "max_depth": meta.get("max_depth"),
                "n_estimators": meta.get("n_estimators"),
                "learning_rate": meta.get("learning_rate"),
            }

            for param_name, param_value in params.items():
                if param_value is None:
                    continue
                key = f"{param_name}={param_value}"
                if key not in param_performance:
                    param_performance[key] = {"expectancies": [], "count": 0}
                param_performance[key]["expectancies"].append(expectancy)
                param_performance[key]["count"] += 1

        # Hitung rata-rata expectancy untuk setiap parameter
        param_stats = {}
        for key, data in param_performance.items():
            exp_list = data["expectancies"]
            param_stats[key] = {
                "avg_expectancy": sum(exp_list) / len(exp_list) if exp_list else 0,
                "min_expectancy": min(exp_list) if exp_list else 0,
                "max_expectancy": max(exp_list) if exp_list else 0,
                "count": data["count"],
                "positive_rate": sum(1 for e in exp_list if e > 0) / len(exp_list) if exp_list else 0,
            }

        # Sort by avg expectancy
        sorted_params = sorted(param_stats.items(), key=lambda x: x[1]["avg_expectancy"], reverse=True)
        return dict(sorted_params)

    def analyze_consecutive_failures(self, results: list) -> dict:
        """
        Analisis pola kegagalan berurutan.
        """
        if not results:
            return {}

        failure_patterns = {}
        for r in results:
            meta = r.get("meta", {})
            if isinstance(meta, str):
                try:
                    meta = json.loads(meta)
                except:
                    meta = {}

            expectancy = r.get("oos_expectancy_r", 0)
            if isinstance(expectancy, str):
                try:
                    expectancy = float(expectancy)
                except:
                    expectancy = 0

            if expectancy <= 0:  # Gagal
                params = {
                    "symbol": r.get("symbol"),
                    "interval": r.get("interval"),
                    "task_type": r.get("task_type"),
                    "regime_filter": r.get("regime_filter"),
                    "prob_threshold": r.get("prob_threshold"),
                    "rr_ratio": r.get("rr_ratio"),
                }
                key = f"{params['symbol']}|{params['interval']}|{params['task_type']}|{params['regime_filter']}|prob={params['prob_threshold']}|RR=1:{params['rr_ratio']}"
                if key not in failure_patterns:
                    failure_patterns[key] = {"failures": 0, "total": 0}
                failure_patterns[key]["failures"] += 1
                failure_patterns[key]["total"] += 1
            else:
                # Hitung total untuk setiap kombinasi
                params = {
                    "symbol": r.get("symbol"),
                    "interval": r.get("interval"),
                    "task_type": r.get("task_type"),
                    "regime_filter": r.get("regime_filter"),
                    "prob_threshold": r.get("prob_threshold"),
                    "rr_ratio": r.get("rr_ratio"),
                }
                key = f"{params['symbol']}|{params['interval']}|{params['task_type']}|{params['regime_filter']}|prob={params['prob_threshold']}|RR=1:{params['rr_ratio']}"
                if key not in failure_patterns:
                    failure_patterns[key] = {"failures": 0, "total": 0}
                failure_patterns[key]["total"] += 1

        # Hitung failure rate
        failure_analysis = {}
        for key, data in failure_patterns.items():
            data["failure_rate"] = data["failures"] / data["total"] if data["total"] > 0 else 0
            failure_analysis[key] = data

        # Sort by failure rate
        sorted_failures = sorted(failure_analysis.items(), key=lambda x: x[1]["failure_rate"], reverse=True)
        return dict(sorted_failures)

    def generate_next_parameters(self, results: list, num_candidates: int = 20) -> list[dict]:
        """
        Generate parameter kombinasi baru berdasarkan analisis evolutioner.
        Menggunakan hasil terbaik sebagai parent dan membuat variasi.
        """
        if not results:
            return self._get_default_params()

        # Ambil model terbaik sebagai parent
        saved_results = [r for r in results if r.get("model_saved")]
        if not saved_results:
            return self._get_default_params()

        # Sort by expectancy
        saved_results.sort(key=lambda r: r.get("oos_expectancy_r", -999) if r.get("oos_expectancy_r") is not None else -999, reverse=True)
        top_models = saved_results[:10]

        # Ambil feature importance dan parameter korelasi
        feature_importance = self.analyze_feature_importance_across_models(results)
        param_correlation = self.analyze_parameter_correlation(results)
        failure_patterns = self.analyze_consecutive_failures(results)

        # Generate kandidat baru
        candidates = []

        # 1. Elitism - keep top 3 models as-is with slight mutation
        for model in saved_results[:3]:
            meta = model.get("meta", {})
            if isinstance(meta, str):
                try:
                    meta = json.loads(meta)
                except:
                    meta = {}

            candidates.append({
                "symbol": model.get("symbol"),
                "interval": model.get("interval"),
                "task_type": model.get("task_type", "regression"),
                "prob_threshold": model.get("prob_threshold"),
                "rr_ratio": model.get("rr_ratio"),
                "regime_filter": model.get("regime_filter"),
                "stop_loss_atr": meta.get("stop_loss_atr", 2.0),
                "risk_per_trade": meta.get("risk_per_trade", 0.01),
                "max_hold_bars": meta.get("max_hold_bars", 30),
                "max_depth": meta.get("max_depth", 4),
                "n_estimators": meta.get("n_estimators", 100),
                "learning_rate": meta.get("learning_rate", 0.1),
                "subsample": meta.get("subsample", 0.8),
                "colsample_bytree": meta.get("colsample_bytree", 0.8),
                "source": "elite",
            })

        # 2. Mutation - create variations of top models
        for _ in range(num_candidates - len(candidates)):
            parent = random.choice(saved_results[:5])
            meta = parent.get("meta", {})
            if isinstance(meta, str):
                try:
                    meta = json.loads(meta)
                except:
                    meta = {}

            # Mutasi parameter dengan probabilitas
            new_params = {
                "symbol": parent.get("symbol"),
                "interval": parent.get("interval"),
                "task_type": parent.get("task_type", "regression"),
                "prob_threshold": self._mutate_value(parent.get("prob_threshold", 0.55), [0.50, 0.55, 0.60, 0.65, 0.70]),
                "rr_ratio": self._mutate_value(parent.get("rr_ratio", 2.0), [1.5, 2.0, 3.0, 5.0]),
                "regime_filter": self._mutate_value(parent.get("regime_filter", "both"), ["none", "bull_only", "bear_only", "both"]),
                "stop_loss_atr": self._mutate_value(meta.get("stop_loss_atr", 2.0), [1.5, 2.0, 2.5, 3.0]),
                "risk_per_trade": self._mutate_value(meta.get("risk_per_trade", 0.01), [0.005, 0.01, 0.02]),
                "max_hold_bars": self._mutate_value(meta.get("max_hold_bars", 30), [20, 30, 50, 100]),
                "max_depth": self._mutate_value(meta.get("max_depth", 4), [3, 4, 5, 6]),
                "n_estimators": self._mutate_value(meta.get("n_estimators", 100), [50, 100, 200]),
                "learning_rate": self._mutate_value(meta.get("learning_rate", 0.1), [0.05, 0.1, 0.2]),
                "subsample": self._mutate_value(meta.get("subsample", 0.8), [0.7, 0.8, 0.9]),
                "colsample_bytree": self._mutate_value(meta.get("colsample_bytree", 0.8), [0.7, 0.8, 0.9]),
                "source": "mutation",
            }
            candidates.append(new_params)

        # 3. Crossover - combine parameters from two different good models
        for _ in range(max(0, num_candidates - len(candidates))):
            if len(saved_results) < 2:
                break
            p1 = random.choice(saved_results[:5])
            p2 = random.choice(saved_results[:5])
            meta1 = p1.get("meta", {}) if isinstance(p1.get("meta"), dict) else {}
            meta2 = p2.get("meta", {}) if isinstance(p2.get("meta"), dict) else {}

            candidates.append({
                "symbol": p1.get("symbol"),
                "interval": p1.get("interval"),
                "task_type": p1.get("task_type", "regression"),
                "prob_threshold": p1.get("prob_threshold") if random.random() > 0.5 else p2.get("prob_threshold"),
                "rr_ratio": p1.get("rr_ratio") if random.random() > 0.5 else p2.get("rr_ratio"),
                "regime_filter": p1.get("regime_filter") if random.random() > 0.5 else p2.get("regime_filter"),
                "stop_loss_atr": meta1.get("stop_loss_atr", 2.0) if random.random() > 0.5 else meta2.get("stop_loss_atr", 2.0),
                "risk_per_trade": meta1.get("risk_per_trade", 0.01) if random.random() > 0.5 else meta2.get("risk_per_trade", 0.01),
                "max_hold_bars": meta1.get("max_hold_bars", 30) if random.random() > 0.5 else meta2.get("max_hold_bars", 30),
                "max_depth": meta1.get("max_depth", 4) if random.random() > 0.5 else meta2.get("max_depth", 4),
                "n_estimators": meta1.get("n_estimators", 100) if random.random() > 0.5 else meta2.get("n_estimators", 100),
                "learning_rate": meta1.get("learning_rate", 0.1) if random.random() > 0.5 else meta2.get("learning_rate", 0.1),
                "subsample": meta1.get("subsample", 0.8) if random.random() > 0.5 else meta2.get("subsample", 0.8),
                "colsample_bytree": meta1.get("colsample_bytree", 0.8) if random.random() > 0.5 else meta2.get("colsample_bytree", 0.8),
                "source": "crossover",
            })

        return candidates[:num_candidates]

    def _mutate_value(self, current, options: list):
        """Mutasi nilai dengan probabilitas 70% tetap, 30% berubah."""
        if random.random() < 0.7:
            return current
        return random.choice(options)

    def _get_default_params(self) -> list[dict]:
        """Default parameters jika belum ada hasil."""
        return [
            {
                "symbol": "SOLUSDT",
                "interval": "1d",
                "task_type": "regression",
                "prob_threshold": 0.55,
                "rr_ratio": 2.0,
                "regime_filter": "both",
                "stop_loss_atr": 2.0,
                "risk_per_trade": 0.01,
                "max_hold_bars": 30,
                "max_depth": 4,
                "n_estimators": 100,
                "learning_rate": 0.1,
                "subsample": 0.8,
                "colsample_bytree": 0.8,
                "source": "default",
            }
        ]

    def save_optimization_result(self, symbol: str, interval: str, params: dict, oos_metrics: dict, meta: dict):
        """Simpan hasil optimasi ke Supabase."""
        row = {
            "symbol": symbol,
            "interval": interval,
            "task_type": params.get("task_type", "regression"),
            "regime_filter": params.get("regime_filter", "none"),
            "prob_threshold": params.get("prob_threshold"),
            "rr_ratio": params.get("rr_ratio"),
            "risk_per_trade": params.get("risk_per_trade", 0.01),
            "stop_loss_atr": params.get("stop_loss_atr", 2.0),
            "take_profit_atr": params.get("take_profit_atr", 4.0),
            "max_hold_bars": params.get("max_hold_bars", 30),
            "leverage": 1.0,
            "allow_short": True,
            "lookback": 1000,
            "forward_bars": 3,
            "expectancy_r": oos_metrics.get("oos_expectancy_r"),
            "total_return_pct": oos_metrics.get("oos_total_return_pct"),
            "maxdd_pct": oos_metrics.get("oos_maxdd_pct"),
            "win_rate_pct": oos_metrics.get("oos_win_rate"),
            "profit_factor": oos_metrics.get("oos_profit_factor"),
            "sharpe": oos_metrics.get("oos_sharpe"),
            "total_trades": oos_metrics.get("oos_total_trades"),
            "gates_passed": oos_metrics.get("oos_expectancy_r", 0) > 0.05,
            "file_exists": oos_metrics.get("oos_expectancy_r", 0) > 0.05,
            "meta": meta,
        }
        return supabase_upsert("ml_model_metrics", row, "symbol,interval")


# Global optimizer instance
ml_optimizer = MLOptimizer()


def get_optimized_models(count: int = 20) -> list[dict]:
    """Dapatkan parameter model terbaik dari optimizer."""
    results = ml_optimizer.get_all_results()
    if not results:
        return ml_optimizer._get_default_params()

    return ml_optimizer.generate_next_parameters(results, count)


def save_optimization_result(symbol: str, interval: str, params: dict, oos_metrics: dict, meta: dict):
    """Simpan hasil optimasi."""
    return ml_optimizer.save_optimization_result(symbol, interval, params, oos_metrics, meta)


def get_optimization_summary() -> dict:
    """Dapatkan ringkasan optimasi dari semua hasil."""
    results = ml_optimizer.get_all_results()
    if not results:
        return {"error": "No results found"}

    saved = [r for r in results if r.get("model_saved")]
    feature_importance = ml_optimizer.analyze_feature_importance_across_models(results)
    param_correlation = ml_optimizer.analyze_parameter_correlation(results)
    failure_patterns = ml_optimizer.analyze_consecutive_failures(results)

    return {
        "total_models": len(results),
        "saved_models": len(saved),
        "top_features": list(feature_importance.items())[:10],
        "top_parameters": list(param_correlation.items())[:10],
        "worst_patterns": list(failure_patterns.items())[:10],
        "best_expectancy": max([r.get("oos_expectancy_r", -999) for r in results if r.get("oos_expectancy_r") is not None], default=0),
    }


if __name__ == "__main__":
    # Test optimizer
    results = ml_optimizer.get_all_results()
    print(f"Total models in Supabase: {len(results)}")

    summary = get_optimization_summary()
    print(f"\nOptimization Summary:")
    print(f"  Total models: {summary.get('total_models', 0)}")
    print(f"  Saved models: {summary.get('saved_models', 0)}")
    print(f"  Best expectancy: {summary.get('best_expectancy', 0):.3f}R")

    print("\nTop Features:")
    for feat, data in summary.get("top_features", [])[:5]:
        print(f"  {feat}: avg_importance={data.get('avg_importance', 0):.4f}, weighted={data.get('avg_weighted_importance', 0):.4f}")

    print("\nTop Parameters:")
    for param, data in summary.get("top_parameters", [])[:5]:
        print(f"  {param}: avg_exp={data.get('avg_expectancy', 0):.3f}R, win_rate={data.get('positive_rate', 0):.1%}")

    print("\nWorst Patterns:")
    for pattern, data in summary.get("worst_patterns", [])[:5]:
        print(f"  {pattern}: fail_rate={data.get('failure_rate', 0):.1%}, failures={data.get('failures', 0)}/{data.get('total', 0)}")

    # Generate next candidates
    candidates = get_optimized_models(10)
    print(f"\nNext {len(candidates)} candidate models:")
    for c in candidates:
        print(f"  {c['symbol']} {c['interval']} | prob={c['prob_threshold']} | RR=1:{c['rr_ratio']} | regime={c['regime_filter']} | md={c['max_depth']} ne={c['n_estimators']} | source={c['source']}")