# Plan: ML Model v2 — Arena-Inspired (Long/Short, Compounded R, Guardrails)

**Masalah:** ML model XGBoost saat ini "tolol" karena cuma prediksi log-return mentah tanpa manajemen risiko, exit ladder, atau self-learning. Arena (LLM) kalah karena Arena adalah **sistem trading lengkap**, bukan sekadar model prediksi.

**Tujuan:** Bangun ML model yang menggabungkan kekuatan XGBoost (pattern recognition) dengan disiplin manajemen risiko Arena (guardrails, exit ladder, archetype, self-learning). Tetap pakai infra gratis (Vercel + Supabase + GitHub Actions).

---

## Kriteria Keberhasilan (dari Arena)

| Metrik | Target |
|--------|--------|
| Expectancy R (per trade) | > 0.1R |
| Profit Factor | > 1.2 |
| Max Drawdown | < 50% |
| Win Rate | > 20% (bisa rendah kalau RR tinggi) |
| Trades minimum | > 50 per aset |

---

## Perubahan Arsitektur

### 1. Target: Classification (Arah) bukan Regresi (Return)
- Target: 1 (naik), 0 (flat), -1 (turun) berdasarkan forward N-bar return dengan ambang threshold
- Alasan: Prediksi arah lebih mudah dari prediksi return numerik yang sangat noisy
- Cocok untuk keputusan entry long/short/flat

### 2. Risk Management Guardrails (Engine-level, mirip Arena)
Setiap prediksi ML harus melewati guardrail sebelum dieksekusi:
- **Risk per trade:** max 1-3% equity
- **Stop Loss:** 2× ATR (hard, tidak boleh dihilangkan)
- **Take Profit:** 3-5× ATR (RR 1:1.5 hingga 1:5)
- **Circuit breaker:** Jika open unrealized R ≤ -3R, blokir entry baru
- **Knockout:** Equity ≤ 50% dari awal → model ditiadakan
- **Loss streak:** Jika 3 trade beruntun loss, turunkan risk per trade bertahap (2% → 1.5% → 1% → 0.5%)
- **Correlation:** Jangan entry symbol yang korelasi ≥ 0.8 dengan posisi open yang sama arah
- **Max positions:** 4 posisi concurrent

### 3. Exit Ladder (otomatis, bukan discretion)
- +1R → stop pindah ke breakeven
- +1.5R → bank separuh posisi, sisa trailing ATR
- +3R → trailing lebih ketat
- Time stop: max 30 bar (4h) atau sesuai timeframe

### 4. Archetype per Aset (bukan satu heuristic untuk semua)
Setiap aset mendapatkan "mandate" berbeda:
- **Trend Follower:** momentum + MTF confluence, hold saat trend tahan
- **Spike Hunter:** HANYA sinyal spike volume, target pendek, stop ketat
- **Decoupling:** RS decoupling vs index, short yang melemah vs benchmark
- **Mean Reversion:** tag overshoot, target cepat
- **Asymmetric:** jarang entry, tapi target jauh (wide RR)
- **Compounder:** risiko mini, banyak posisi kecil, exit cepat

Model ML akan dilatih terpisah per archetype per aset.

### 5. Self-Learning dari History (mirip Arena)
Model dilatih ulang secara berkala dengan:
- Per-symbol performance (mana yang konsisten untung/rugi)
- Mistake ledger (simbol yang konsisten rugi → dilarang entry)
- Exit reason analysis (mana exit yang sering loss: SL, TP, time_stop)
- Loss streak management

### 6. Fitur Baru (dari Arena)
- Regime BTC (bull/bear/sideways) — filter regime
- Correlation vs posisi open (hindari risiko terpusat)
- Loss streak counter
- Per-symbol avgR history
- Exit reason distribution
- Macro context (VIX, DXY — jika tersedia via Yahoo)

---

## File Plan

### 1. `ml/train/train_model_v2.py` (NEW)
- CLI: `--symbol`, `--interval`, `--task-type classification`, `--regime-filter`, `--prob-threshold`, `--rr-ratio`, `--risk-per-trade`, `--stop-loss-atr`, `--take-profit-atr`, `--max-hold-bars`, `--leverage`, `--allow-short`
- Target: classification (1/0/-1) dengan threshold return
- Walk-forward OOS dengan compounded R position sizing
- Gate: expectancy R > 0.05, MaxDD < 50%, win rate > 20%, PF > 1.05
- Ekspor model JSON + meta (termasuk archetype, parameter trading)

### 2. `ml/train/batch_train_v2.py` (EXISTING — diperbaiki)
- Grid search pada top assets (MATICUSDT, BNBUSDT, BTCUSDT, ETHUSDT, XRPUSDT, NVDA, META, MSFT, AAPL, GC=F, ^N225, ^VIX, EURUSD=X, dll.)
- Timeframe: 1d dan 4h
- Parameter: prob_threshold [0.50, 0.55, 0.65], rr_ratio [1.5, 2.0, 3.0], regime_filter [none, both]

### 3. `lib/ml/inference.ts` (EXISTING — diperbaiki)
- Support classification (3 kelas: long/short/flat)
- Support regime filter (bull_only/bear_only/none)
- Support probability threshold gating
- Return: signal ('long'|'short'|'flat'), probabilityUp, probabilityDown, regimePass

### 4. `lib/ml/backtest.ts` (EXISTING — diperbaiki)
- Long/Short entry/exit
- SL/TP/time stop
- Compounded R position sizing
- R-multiple metrics (expectancy R, avg R, profit factor, Sharpe)
- Equity curve dan max drawdown

### 5. `pages/api/ml-predict.ts` (EXISTING — diperbaiki)
- Return: probabilityUp, probabilityDown, signal, regimePass, leverage, allowShort, rrRatio, riskPerTrade, stopLossATR, takeProfitATR, latestClose, atrPct

### 6. `pages/api/ml-backtest.ts` (EXISTING — diperbaiki)
- Query params: leverage, allowShort, riskPerTrade, stopLossATR, takeProfitATR, maxHoldBars, probThreshold
- Return: full backtest result dengan trade list, equity curve, Monte Carlo, walk-forward

### 7. `pages/ml-dashboard.tsx` (EXISTING — diperbaiki)
- Model selector grouped by asset class (Crypto, Komoditas, Indeks, Forex, Saham US)
- Toggle "Hanya model positif (expectancy > 0)"
- Trade setup chart (Entry/SL/TP/R:R/Kelly Size)
- Backtest results table, Monte Carlo, walk-forward OOS
- Feature importance bar chart

---

## Rollout

1. **Phase 1:** Retrain model terbaik (MATICUSDT 1d) dengan classification task + regime filter + compounded R backtest
2. **Phase 2:** Grid search 1008 kombinasi pada 44 aset (sudah dilakukan, hasil: MATICUSDT 1d terbaik 0.119R)
3. **Phase 3:** Tambah guardrails (loss streak, correlation, circuit breaker) ke inference + backtest
4. **Phase 4:** Archetype per aset (trend/spike/decoupling/mean-reversion/asymmetric/compounder)
5. **Phase 5:** Integrasi ML sebagai filter konfirmasi di backtest engine utama (tidak mengganti, hanya melapis)

---

## Risiko & Mitigasi

| Risiko | Mitigasi |
|--------|----------|
| Model masih overfit | Walk-forward OOS dengan gate ketat, test pada data yang belum dilihat |
| Drawdown tinggi (50%+) | Position sizing 1% per trade, circuit breaker -3R, knockout 50% |
| Concept drift | Retrain harian via GitHub Actions, monitoring drift di Supabase |
| Vercel cold start | Model JSON < 500KB, in-memory cache per instance |
| Tidak ada Python di Vercel | Training di GitHub Actions, inferensi pure TypeScript |

---

## Open Questions

1. Apakah menggabungkan ML sebagai **filter konfirmasi** di atas backtest manual (bukan mengganti)?
2. Target horizon: 1 bar (4h/1d berikutnya) atau multi-bar (3-5 bar)?
3. Probability calibration: sigmoid pada raw prediction atau quantile models?

---

## Success Criteria

- Setidaknya 1 model dengan expectancy R > 0.1 dan MaxDD < 50%
- Dashboard menampilkan model terbaik dengan trade setup lengkap (Entry/SL/TP/R:R)
- Endpoint `/api/ml-predict` dan `/api/ml-backtest` berfungsi dengan lengkap
- Tidak ada regresi pada fitur existing (backtest, scan, arena)
