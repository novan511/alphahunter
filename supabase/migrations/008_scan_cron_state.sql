-- Server-side scan cron state.
--
-- Run once in the Supabase SQL Editor.
--
-- Why this exists
-- ---------------
-- The browser sweep only runs while a tab is open, and only persists when it
-- reaches `done`. A scheduled worker needs to survive between invocations, so
-- the cursor and the partial results live here instead of in memory.
--
-- Two tables:
--   scan_cron_state  — one row per (index_symbol, depth): where the sweep is
--                      and whether it finished. This is the resume cursor.
--   scan_cron_rows   — per-chunk results keyed by (sweep_id, asset). Chunks
--                      arrive in pieces; the final scan is assembled from here.
--
-- `sweep_id` identifies one full pass. It is regenerated when the universe
-- membership or ordering changes, because resuming across a reorder would
-- splice results from two different sequences into one ranking.

-- One row per sweep target. Upserted by the worker.
create table if not exists public.scan_cron_state (
  id text primary key,
  index_symbol text not null,
  depth text not null,
  universe text not null default 'curated',
  order_by text not null default 'cap',

  -- Resume protocol. universe_id must match the chunk response or the worker
  -- restarts rather than splicing mismatched positions.
  sweep_id text not null default '',
  universe_id text,
  next_offset int not null default 0,
  total int,
  -- Compressed set of completed positions (see lib/ranges.ts).
  done_ranges text not null default '',

  -- Lifecycle.
  status text not null default 'idle',   -- idle | running | done | error
  started_at timestamptz,
  completed_at timestamptz,
  last_tick_at timestamptz,
  ticks int not null default 0,
  error text,

  regime jsonb,
  autonomous_params jsonb,
  sources jsonb,
  scanned_count int not null default 0,
  failed_count int not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Partial results, merged into the final scan when the sweep completes.
create table if not exists public.scan_cron_rows (
  sweep_id text not null,
  asset text not null,
  position int,
  result jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (sweep_id, asset)
);

create index if not exists scan_cron_rows_sweep_idx
  on public.scan_cron_rows (sweep_id);

-- The worker polls this to find work; the browser reads it for status.
create index if not exists scan_cron_state_status_idx
  on public.scan_cron_state (status, updated_at desc);

alter table public.scan_cron_state enable row level security;
alter table public.scan_cron_rows enable row level security;

-- The worker runs in-process on the server using the anon key, so policies
-- mirror the rest of this schema. If you later add a service-role key for the
-- worker, tighten these to anon read-only for scan_cron_state.
drop policy if exists "anon rw scan_cron_state" on public.scan_cron_state;
create policy "anon rw scan_cron_state"
  on public.scan_cron_state for all to anon using (true) with check (true);

drop policy if exists "anon rw scan_cron_rows" on public.scan_cron_rows;
create policy "anon rw scan_cron_rows"
  on public.scan_cron_rows for all to anon using (true) with check (true);

-- Rolling view: the newest completed cron sweep per symbol.
create or replace view public.scan_cron_latest as
select
  r.symbol,
  r.result->>'finalSignal' as final_signal,
  (r.result->>'confluenceScore')::double precision as confluence_score,
  s.index_symbol,
  s.depth,
  s.regime->>'regime' as regime,
  s.completed_at
from public.scan_cron_rows r
join public.scan_cron_state s on s.sweep_id = r.sweep_id
where s.status = 'done';

comment on table public.scan_cron_state is
  'Resume cursor for the server-side scan cron. One row per index_symbol+depth.';
comment on table public.scan_cron_rows is
  'Per-asset chunk results for an in-progress sweep, keyed by sweep_id+asset.';
comment on column public.scan_cron_state.done_ranges is
  'Compressed completed-position set, e.g. "0-172,175". See lib/ranges.ts.';