-- ML Model Metrics: hasil OOS dari setiap model yang dilatih
create table if not exists ml_model_metrics (
  id uuid default gen_random_uuid() primary key,
  symbol text not null,
  interval text not null,
  task_type text not null default 'regression',
  regime_filter text not null default 'both',
  prob_threshold double precision not null default 0.55,
  rr_ratio double precision not null default 2.0,
  risk_per_trade double precision not null default 0.01,
  stop_loss_atr double precision not null default 2.0,
  take_profit_atr double precision not null default 4.0,
  max_hold_bars integer not null default 30,
  leverage double precision not null default 1.0,
  allow_short boolean not null default true,
  lookback integer not null default 1000,
  forward_bars integer not null default 3,
  expectancy_r double precision,
  total_return_pct double precision,
  maxdd_pct double precision,
  win_rate_pct double precision,
  profit_factor double precision,
  sharpe double precision,
  total_trades integer,
  trained_at timestamptz default now(),
  gates_passed boolean default false,
  file_exists boolean default false,
  meta jsonb
);

create index if not exists idx_ml_model_metrics_symbol_interval
  on ml_model_metrics(symbol, interval);
create index if not exists idx_ml_model_metrics_expectancy
  on ml_model_metrics(expectancy_r desc);
create index if not exists idx_ml_model_metrics_trained_at
  on ml_model_metrics(trained_at desc);

-- Backtest Results: ringkasan backtest per model
create table if not exists ml_backtest_results (
  id uuid default gen_random_uuid() primary key,
  symbol text not null,
  interval text not null,
  leverage double precision not null default 1.0,
  allow_short boolean not null default true,
  rr_ratio double precision not null default 2.0,
  risk_per_trade double precision not null default 0.01,
  total_trades integer,
  winning_trades integer,
  losing_trades integer,
  win_rate double precision,
  total_return_pct double precision,
  final_capital double precision,
  profit_factor double precision,
  max_drawdown_pct double precision,
  expectancy_r double precision,
  avg_r double precision,
  sharpe double precision,
  avg_bars_held double precision,
  backtested_at timestamptz default now(),
  config jsonb,
  guardrail_stats jsonb
);

create index if not exists idx_ml_backtest_results_symbol_interval
  on ml_backtest_results(symbol, interval);
create index if not exists idx_ml_backtest_results_backtested_at
  on ml_backtest_results(backtested_at desc);

-- Trade List: setiap trade dari backtest
create table if not exists ml_trade_list (
  id uuid default gen_random_uuid() primary key,
  symbol text not null,
  interval text not null,
  trade_id integer not null,
  entry_time timestamptz not null,
  exit_time timestamptz not null,
  entry_price double precision not null,
  exit_price double precision not null,
  side text not null,
  qty double precision not null,
  notional double precision not null,
  pnl double precision not null,
  pnl_percent double precision not null,
  r_multiple double precision not null,
  exit_reason text not null,
  bars_held integer not null,
  probability_up double precision,
  probability_down double precision,
  regime_pass boolean,
  backtest_id uuid references ml_backtest_results(id) on delete cascade
);

create index if not exists idx_ml_trade_list_symbol_interval
  on ml_trade_list(symbol, interval);
create index if not exists idx_ml_trade_list_backtest_id
  on ml_trade_list(backtest_id);
create index if not exists idx_ml_trade_list_exit_time
  on ml_trade_list(exit_time desc);
create index if not exists idx_ml_trade_list_side
  on ml_trade_list(side);
create index if not exists idx_ml_trade_list_pnl
  on ml_trade_list(pnl desc);

alter table ml_model_metrics enable row level security;
alter table ml_backtest_results enable row level security;
alter table ml_trade_list enable row level security;

create policy "anon read ml_model_metrics"
  on ml_model_metrics for select to anon using (true);
create policy "anon write ml_model_metrics"
  on ml_model_metrics for insert to anon with check (true);
create policy "anon update ml_model_metrics"
  on ml_model_metrics for update to anon using (true);

create policy "anon read ml_backtest_results"
  on ml_backtest_results for select to anon using (true);
create policy "anon write ml_backtest_results"
  on ml_backtest_results for insert to anon with check (true);
create policy "anon update ml_backtest_results"
  on ml_backtest_results for update to anon using (true);

create policy "anon read ml_trade_list"
  on ml_trade_list for select to anon using (true);
create policy "anon write ml_trade_list"
  on ml_trade_list for insert to anon with check (true);
create policy "anon delete ml_trade_list"
  on ml_trade_list for delete to anon using (true);
