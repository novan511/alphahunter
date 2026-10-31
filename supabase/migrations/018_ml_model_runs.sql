create table if not exists ml_model_runs (
  id uuid default gen_random_uuid() primary key,
  symbol text not null,
  interval text not null,
  model_version text not null,
  prediction double precision not null,
  probability_up double precision not null,
  confidence double precision not null,
  actual_return double precision,
  created_at timestamptz default now()
);

create index if not exists idx_ml_model_runs_symbol_interval
  on ml_model_runs(symbol, interval, created_at desc);

create index if not exists idx_ml_model_runs_created_at
  on ml_model_runs(created_at desc);
