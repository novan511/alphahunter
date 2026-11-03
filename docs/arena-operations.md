# AI Arena operations

`/arena` is a **paper simulation**, not broker execution or a live-performance record. It uses completed candle data, simulated fills, and generic fee/slippage assumptions.

## Production prerequisites

1. Configure `SUPABASE_SERVICE_ROLE_KEY` in the server environment. Never expose it as a `NEXT_PUBLIC_*` variable or send it to the browser.
2. Configure a high-entropy `ARENA_CONTROL_TOKEN` in the server environment (for example, generate one with `openssl rand -hex 32`). Share it only with operators. The Arena page keeps the entered token in that browser tab's `sessionStorage` and sends it as a Bearer token.
3. Deploy the application code, then apply `supabase/migrations/020_ai_arena_write_lock.sql` to the same Supabase project. Mutations intentionally fail closed until the database lock RPCs exist. The migration removes anon/authenticated write access to arena state; reads remain public. Server writes/deletes use the service-role client.
4. Confirm the Arena status shows token-protected controls and database persistence. Start/stop/resume/step should return successfully. If a mutation reports that migration 020 is missing, verify the project and migration status before retrying.

Removing `ARENA_CONTROL_TOKEN` disables production controls. It does not delete state. Do not restore anonymous write policies as a troubleshooting shortcut.

## Scoring and history

- A completed position is one trade; its partial exits are combined into that trade's net PnL/R.
- Ranking sorts by `avgR × n / (n + 20)`, where `n` is the recorded trade sample. This shrinkage heuristic reduces small-sample outliers; it is **not** a confidence interval or a claim of statistical significance.
- The state retains at most 200 completed trades. Once capped, the displayed expectancy and related trade stats describe the retained history, not the full lifetime record.
- Legacy `partial_target` rows are merged into their matching completed trade or moved into the matching open position. Fees for legacy partials were not stored, so the merged fee total remains unavailable and the UI labels it as legacy/unknown.
- Drawdown is tracked going forward. For older states it can only be approximated from the stored, bounded equity curve.

## Candle and fill assumptions

- Strategy snapshots use completed bars. Yahoo's hourly data is resampled into 4-hour bars where needed. Open-position marks in the UI use the latest 1-minute candle close—not a broker tick.
- Simulated fees and slippage are applied per side using generic asset-class profiles shown in the Arena UI. They are illustrative, not venue-specific.
- Financing, borrow costs, futures funding, market impact, queue position, and partial-fill mechanics are not modeled. Candle OHLC cannot establish the exact path or fill a real venue would have provided.
- Decision audit records provider, request latency, input bar/snapshot metadata, candidate symbols, and applied intent. Model-authored rationale is not chain-of-thought and is not evidence that a decision is correct.

## Local checks

Run `npm run typecheck` and `npm run build` before deployment. `npm run lint` currently requires an ESLint configuration to be selected in this repository; do not select or add one implicitly as part of an Arena release.
