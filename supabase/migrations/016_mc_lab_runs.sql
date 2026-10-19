-- Laboratorium Monte Carlo otonom (/backtest)
-- Run once in Supabase SQL Editor.

create table if not exists public.mc_lab_runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running',
  stage text,
  progress int,
  asset text,
  interval text,
  family text,
  macro_filter text,
  verdict text,
  score double precision,
  reasons jsonb,
  rationale text,
  source text,
  metrics jsonb,
  error text
);

create index if not exists mc_lab_runs_created_idx
  on public.mc_lab_runs (created_at desc);

create index if not exists mc_lab_runs_cell_idx
  on public.mc_lab_runs (asset, family, interval);

alter table public.mc_lab_runs enable row level security;

-- Baca publik (halaman riwayat), tulis lewat service-role saja.
drop policy if exists "anon read mc_lab_runs" on public.mc_lab_runs;
create policy "anon read mc_lab_runs"
  on public.mc_lab_runs for select to anon using (true);

drop policy if exists "anon write mc_lab_runs" on public.mc_lab_runs;
