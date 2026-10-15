-- Scan history table for autonomous scan results.
--
-- Run once in the Supabase SQL Editor.

create table if not exists public.scan_history (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  scan_type text not null default 'crypto',
  mode text not null default 'autonomous',
  index_symbol text not null,
  interval text not null default '4h',
  market_regime jsonb,
  autonomous_params jsonb,
  results jsonb,
  total_scanned int,
  signals_count int,
  buy_signals_summary text,
  sell_signals_summary text,
  regime_label text
);

create index if not exists scan_history_created_at_idx
  on public.scan_history (created_at desc);

create index if not exists scan_history_index_symbol_idx
  on public.scan_history (index_symbol, created_at desc);

alter table public.scan_history enable row level security;

drop policy if exists "anon read scan_history" on public.scan_history;
create policy "anon read scan_history"
  on public.scan_history for select to anon using (true);

drop policy if exists "anon insert scan_history" on public.scan_history;
create policy "anon insert scan_history"
  on public.scan_history for insert to anon with check (true);

comment on table public.scan_history is
  'Autonomous scan results persisted after each completed sweep.';
