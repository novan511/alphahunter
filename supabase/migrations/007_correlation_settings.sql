-- Correlation basket settings: which coins the matrix panel compares.
--
-- Run once in the Supabase SQL Editor.
--
-- Why a table and not localStorage
-- --------------------------------
-- localStorage ties the basket to one browser. This singleton row makes the
-- basket follow the operator across devices, and lets the Telegram bot read
-- the same basket the web panel shows (future: /matrix with no args uses it).
--
-- There is no auth in this app, so the basket is shared, not per-user. One
-- row with a fixed id; every save overwrites it. Last write wins.

create table if not exists public.correlation_settings (
  id text primary key,
  symbols text[] not null,
  updated_at timestamptz not null default now()
);

alter table public.correlation_settings enable row level security;

-- Anon needs read + insert + update for upsert to work. The symbols column
-- is validated server-side (2..16 bare symbols), so an open write policy
-- here cannot do more damage than saving a weird basket.
drop policy if exists "anon read correlation_settings" on public.correlation_settings;
create policy "anon read correlation_settings"
  on public.correlation_settings for select to anon using (true);

drop policy if exists "anon write correlation_settings" on public.correlation_settings;
create policy "anon write correlation_settings"
  on public.correlation_settings for insert to anon with check (true);

drop policy if exists "anon update correlation_settings" on public.correlation_settings;
create policy "anon update correlation_settings"
  on public.correlation_settings for update to anon using (true) with check (true);

-- Seed the default basket so a fresh install shows the same 6 coins as the
-- web default instead of an empty panel. Overwritten on first save.
insert into public.correlation_settings (id, symbols)
values ('default', array['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'SUIUSDT', 'HYPE'])
on conflict (id) do nothing;

comment on table public.correlation_settings is
  'Singleton (id=default) basket for the pairwise strength matrix.';
