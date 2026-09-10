-- Run once in Supabase SQL Editor
create table if not exists public.quant_lab_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  market_id text not null,
  status text not null default 'done',
  combo_count int,
  best_combo_id text,
  best_label text,
  best_score double precision,
  best_risk jsonb,
  best_metrics jsonb,
  rows jsonb,
  source text
);

create index if not exists quant_lab_runs_market_idx
  on public.quant_lab_runs (market_id, created_at desc);

alter table public.quant_lab_runs enable row level security;

drop policy if exists "anon rw quant_lab_runs" on public.quant_lab_runs;
create policy "anon rw quant_lab_runs"
  on public.quant_lab_runs for all to anon using (true) with check (true);

-- If table already exists without source column, run:
-- alter table public.quant_lab_runs add column if not exists source text;
