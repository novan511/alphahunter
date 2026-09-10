-- Run once in Supabase SQL Editor
create table if not exists public.paper_trading_state (
  id text primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.paper_trading_state enable row level security;

create policy "anon read paper_trading_state"
  on public.paper_trading_state for select to anon using (true);

create policy "anon write paper_trading_state"
  on public.paper_trading_state for insert to anon with check (true);

create policy "anon update paper_trading_state"
  on public.paper_trading_state for update to anon using (true);

create policy "anon delete paper_trading_state"
  on public.paper_trading_state for delete to anon using (true);
