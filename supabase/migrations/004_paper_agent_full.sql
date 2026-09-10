-- ============================================================
-- ALTHUNTER PAPER AGENT — run this once in Supabase SQL Editor
-- ============================================================

-- 1) Live paper agent state (already may exist — keep)
create table if not exists public.paper_trading_state (
  id text primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

-- 2) Closed paper trades history (append-only)
create table if not exists public.paper_trades (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  agent_id text not null default 'default',
  entry_time timestamptz not null,
  exit_time timestamptz not null,
  symbol text not null,
  side text not null check (side in ('long','short')),
  entry_price double precision not null,
  exit_price double precision not null,
  qty double precision not null,
  pnl double precision not null,
  pnl_percent double precision not null,
  exit_reason text,
  signal_reason text,
  interval text,
  equity_after double precision
);

create index if not exists paper_trades_agent_exit_idx
  on public.paper_trades (agent_id, exit_time desc);

-- 3) Parameter auto-tune audit log
create table if not exists public.paper_param_history (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  agent_id text not null default 'default',
  reason text not null,
  kpi jsonb,
  old_params jsonb not null,
  new_params jsonb not null
);

create index if not exists paper_param_history_agent_idx
  on public.paper_param_history (agent_id, created_at desc);

-- 4) Daily / rolling KPI snapshot
create table if not exists public.paper_kpi_snapshots (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  agent_id text not null default 'default',
  capital_start double precision not null,
  equity double precision not null,
  pnl_percent double precision not null,
  monthly_target_low double precision not null,
  monthly_target_high double precision not null,
  days_elapsed double precision not null,
  pace_monthly_percent double precision not null,
  status text not null,
  open_positions int not null default 0,
  total_trades int not null default 0,
  win_rate double precision not null default 0
);

create index if not exists paper_kpi_agent_idx
  on public.paper_kpi_snapshots (agent_id, created_at desc);

-- RLS — anon can read/write for this local research app
alter table public.paper_trading_state enable row level security;
alter table public.paper_trades enable row level security;
alter table public.paper_param_history enable row level security;
alter table public.paper_kpi_snapshots enable row level security;

drop policy if exists "anon rw paper_trading_state" on public.paper_trading_state;
create policy "anon rw paper_trading_state"
  on public.paper_trading_state for all to anon using (true) with check (true);

drop policy if exists "anon rw paper_trades" on public.paper_trades;
create policy "anon rw paper_trades"
  on public.paper_trades for all to anon using (true) with check (true);

drop policy if exists "anon rw paper_param_history" on public.paper_param_history;
create policy "anon rw paper_param_history"
  on public.paper_param_history for all to anon using (true) with check (true);

drop policy if exists "anon rw paper_kpi_snapshots" on public.paper_kpi_snapshots;
create policy "anon rw paper_kpi_snapshots"
  on public.paper_kpi_snapshots for all to anon using (true) with check (true);

-- Optional: wipe paper history for a clean restart
-- delete from public.paper_trades where agent_id='default';
-- delete from public.paper_param_history where agent_id='default';
-- delete from public.paper_kpi_snapshots where agent_id='default';
-- delete from public.paper_trading_state where id='default';
