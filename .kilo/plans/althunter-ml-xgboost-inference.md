# Plan: XGBoost/LightGBM ML Inference on Vercel + Supabase (Free Tier)

**Target:** Add real ML (not heuristics) to Althunter v2 while staying on free Vercel + Supabase.
**Model:** XGBoost or LightGBM gradient boosted trees, trained in GitHub Actions (Python), exported to JSON, inferred manually in TypeScript on Vercel.
**Scope:** Training pipeline + JSON artifact + TypeScript inference + Supabase metrics storage + walk-forward OOS validation.

---

## Constraints (non-negotiable)

- No Python runtime on Vercel. Inference must be pure TypeScript (tree traversal if-else).
- No paid infra. GitHub Actions free minutes for training; Vercel Hobby for API routes; Supabase free tier for state/metrics.
- Max 60s per Vercel serverless invocation. Training cannot run on Vercel; must run in GitHub Actions.
- Model artifact must be small (JSON/ONNX, <1MB) so it loads cold in serverless.
- Existing code in `lib/algorithms/`, `lib/quant/`, `pages/api/` must keep working; ML is additive, not replacement.

---

## Decisions (resolved)

| Decision | Value |
|---|---|
| Algorithm | XGBoost (`reg:squarederror`) or LightGBM (`regression`), exported to JSON |
| Target | Forward-N bar log-return (regression). Optional: 3-class ordinal (up/down/flat) |
| Quantile | Train two models (q=0.1, q=0.9) or single median + residual spread; enables P(return>0) probability |
| Training env | GitHub Actions (`ubuntu-latest` + `setup-python`), scheduled daily |
| Artifact location | `ml/models/<symbol>_<interval>.json` committed to repo + GitHub Release artifact |
| Inference | Manual JSON tree traversal in `lib/ml/inference.ts` (pure TS, no deps) |
| Feature source | Reuse existing `lib/algorithms/indicators.ts` + `lib/algorithms/relativeStrength.ts` calculations |
| Metrics storage | Supabase table `ml_model_runs` (created via migration) |
| Validation | Walk-forward OOS (reuse `lib/quant/walkForward.ts` logic), Sharpe > 1.0, MaxDD < 15%, PF > 1.2 gates |
| Serving route | `pages/api/ml-predict.ts` (GET: symbol, interval; returns prediction + probability) |

---

## File plan (new files only; existing files not edited unless noted)

### 1. `ml/train/train_model.py` (NEW)
- CLI script: `python ml/train/train_model.py --symbol ETHUSDT --interval 4h --lookback 1000`
- Fetch historical candles from Binance/Yahoo (reuse logic conceptually; implement standalone with `ccxt` or raw `requests`)
- Compute features: RS Z-score vs BTC, momentum lookbacks [5, 20, 60], volume ratio, ATR% normalized, BTC regime flag, hour-of-day
- Target: forward `N` bar log return (N = 1 for 4h → next bar return)
- Train XGBoost `reg:squarederror` with `max_depth=4`, `n_estimators=100`, `learning_rate=0.1`, `subsample=0.8`
- Walk-forward OOS: 3 windows anchored expanding; record OOS Sharpe, MaxDD, PF, win rate
- Export model to JSON via `xgb.get_booster().save_model()` (native JSON)
- Write `ml/models/ETHUSDT_4h.json` + `ml/models/ETHUSDT_4h.meta.json` (features, metrics, train date, feature importances)
- Exit non-zero if OOS gates fail (Sharpe ≤ 1.0, MaxDD ≥ 15%, PF ≤ 1.2)

### 2. `ml/train/requirements.txt` (NEW)
```
xgboost>=2.0
pandas>=2.0
numpy>=1.24
requests>=2.31
```

### 3. `.github/workflows/ml-train.yml` (NEW)
- Schedule: `0 2 * * *` (daily 02:00 UTC)
- Matrix: symbols [ETHUSDT, SOLUSDT, BNBUSDT, XRPUSDT], interval 4h
- Steps: checkout, setup-python, install deps, run train_model.py, commit JSON artifacts to branch `ml-artifacts` (or push to same repo), upload GitHub Release artifact
- Gate: if any symbol fails OOS, workflow fails but does not block main branch

### 4. `lib/ml/inference.ts` (NEW)
- `loadModel(path: string): Model` — read JSON model (at build time or runtime from `/public` or bundled)
- `predict(features: number[]): { value: number; probabilityUp: number }` — tree traversal
- Tree node JSON format: `{ nodeid, yes, no, missing, feature, gain, cover, leaf }`
- If `leaf` present → return leaf value. Else traverse `feature` index into `features[]`, go `yes`/`no`/`missing`.
- `probabilityUp`: sigmoid of (value / residual_spread) or trained quantile ratio; clamp [0,1]
- Fallback: if model file missing → return `{ value: 0, probabilityUp: 0.5, source: 'fallback' }`

### 5. `lib/ml/features.ts` (NEW)
- `buildFeatures(candles: Candle[], indexCandles: Candle[]): number[]` — pure TS, mirrors Python training feature order exactly
- Reuse `sma`, `standardDeviation`, `atr`, `rollingReturn` from `lib/algorithms/indicators.ts`
- `calculateRSData` from `lib/algorithms/relativeStrength.ts`
- Output fixed-length feature vector (same order as Python training)

### 6. `pages/api/ml-predict.ts` (NEW)
- GET `?symbol=ETHUSDT&interval=4h`
- Fetch recent candles (reuse `fetchBinanceKlines` from `lib/api.ts`)
- Build features via `lib/ml/features.ts`
- Load model JSON from `ml/models/<symbol>_<interval>.json` (bundled at build via `next.config.js` or public copy)
- Return `{ symbol, interval, prediction, probabilityUp, confidence, featuresUsed, modelVersion, timestamp }`
- Rate limit: simple in-memory per-IP cooldown (optional, Vercel Hobby friendly)

### 7. `supabase/migrations/018_ml_model_runs.sql` (NEW)
```sql
create table if not exists ml_model_runs (
  id uuid default gen_random_uuid() primary key,
  symbol text not null,
  interval text not null,
  model_version text not null,
  prediction double precision not null,
  probability_up double precision not null,
  actual_return double precision, -- filled later when bar closes
  created_at timestamptz default now()
);
create index if not exists idx_ml_model_runs_symbol_interval on ml_model_runs(symbol, interval, created_at desc);
```

### 8. `pages/api/ml-feedback.ts` (NEW) (optional, phase 2)
- POST endpoint to record actual return after bar closes, for drift monitoring
- Called by scan-cron or GitHub Actions daily

---

## Integration points with existing code

- `pages/backtest.tsx` — can optionally call `/api/ml-predict` as an additional signal input (display only, no trade execution change)
- `lib/quant/signals.ts` — ML prediction can be added as a signal candidate source (strength derived from probabilityUp)
- Existing `detectDecoupling` backtest unchanged; ML runs in parallel

---

## Validation gates (must pass before ML used in production signaling)

1. **OOS Sharpe > 1.0** (annualized, per-bar returns)
2. **OOS Max Drawdown < 15%**
3. **OOS Profit Factor > 1.2**
4. **Feature importances not degenerate** (no single feature > 70% importance)
5. **Prediction vs actual correlation > 0.1** on most recent 100 bars (drift check)

If any gate fails → model artifact marked `rejected`, API returns fallback probability 0.5.

---

## Rollout / migration path

- **Phase 1:** Training pipeline + JSON artifacts + inference API (read-only, no trading impact)
- **Phase 2:** Display ML probability on backtest page / scan results as "ML signal" (informational)
- **Phase 3:** Use ML probability as filter/strength modifier in `signals.ts` (optional config flag `USE_ML_FILTER`)
- **Phase 4:** Auto-retrain on drift detection (probability calibration drift > threshold)

---

## Risks & mitigation

| Risk | Mitigation |
|---|---|
| Training data ≠ inference data (feature order mismatch) | Single source of truth: `lib/ml/features.ts` mirrored in Python via shared spec; unit test compares Python vs TS feature output on same candles |
| Model staleness (concept drift) | Daily retrain + Supabase feedback table; gate rejects model if recent calibration poor |
| Vercel cold start loads large JSON | Keep model <500KB; cache in-memory per instance |
| GitHub Actions minutes exhausted | Matrix limited to 4 symbols × 1 interval; daily only |
| No Python on Vercel for retraining | Explicitly excluded; retraining only in Actions |

---

## Open questions (to resolve before implementation)

1. Target horizon N: 1 bar (next 4h return) or multi-bar (e.g. 3-bar cumulative)? Recommended: 1 bar for simplicity.
2. Probability calibration: sigmoid on raw prediction vs trained quantile models (q=0.1/q=0.9)? Recommended: single median model + empirical residual spread from OOS.
3. Commit JSON artifacts to main repo vs separate branch? Recommended: separate branch `ml-artifacts` to keep main clean, API reads from bundled/public copy.

---

## Success criteria

- `/api/ml-predict?symbol=ETHUSDT&interval=4h` returns `{ probabilityUp: number, prediction: number }` with model loaded from JSON
- GitHub Actions workflow trains and exports model without failure on main branch
- OOS metrics logged to Supabase `ml_model_runs`
- No existing API route or backtest result changes behavior when ML model missing (graceful fallback)
