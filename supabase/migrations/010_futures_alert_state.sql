-- Futures alert dedupe state.
--
-- Run once in the Supabase SQL Editor.
--
-- Why this exists
-- ---------------
-- /api/futures-cron runs every 30 minutes and pushes ONLY what changed since
-- the last push. Without a persisted "what did we last send", every tick would
-- either re-send the whole book (noise the trader mutes) or forget what it
-- sent (the same flip alerted forever). So each timeframe keeps one row here:
-- the last verdict per symbol plus the bar time it was scored on.
--
-- The write rule is load-bearing: state advances only when the push succeeded
-- (or there was nothing to push). A failed Telegram send leaves the old row
-- in place, so the next tick still sees the alert as new. Losing an alert is
-- the one miss this table exists to prevent.

create table if not exists public.futures_alert_state (
  id text primary key,              -- e.g. 'futures:1h'
  state jsonb not null default '{}'::jsonb,
  last_sent_count int not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.futures_alert_state enable row level security;

drop policy if exists "anon rw futures_alert_state" on public.futures_alert_state;
create policy "anon rw futures_alert_state"
  on public.futures_alert_state for all to anon using (true) with check (true);

comment on table public.futures_alert_state is
  'Dedupe cursor for the futures Telegram cron. One row per timeframe; advances only on successful push.';
