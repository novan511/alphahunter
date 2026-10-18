-- Signal ledger: a forward-only, tamper-evident record of confident signals.
--
-- Run once in the Supabase SQL Editor.
--
-- Why this exists
-- ---------------
-- Althunter can emit signals but cannot prove them. A record written at emit
-- and scored later is the only thing that turns a claim into a track record.
-- This table is append-only: every signal that clears the confident gate gets
-- one row at the moment it is emitted, and each horizon is filled in exactly
-- once. The BEFORE UPDATE trigger is what makes that guarantee real — it
-- belongs in the database, not in the application, because the whole point is
-- that the number cannot be edited afterwards.
--
-- One row per (asset, direction, emit day): re-emitting the same signal later
-- the same day adds nothing, mirroring the existing 24h Telegram dedup.

create table if not exists public.signal_ledger (
  id bigint generated always as identity primary key,
  emitted_at timestamptz not null,
  -- Derived, so the dedup key cannot be set wrong by the caller.
  emit_day date generated always as ((emitted_at at time zone 'UTC')::date) stored,

  -- Fact columns: written once at emit, never changed (enforced below).
  asset text not null,
  direction text not null check (direction in ('long', 'short')),
  index_symbol text not null,
  benchmark_symbol text not null,
  benchmark_price numeric,
  price numeric,
  price_at timestamptz,
  price_tf text,
  signal text not null,
  confluence_score numeric,
  conviction numeric,
  agreement numeric,
  regime text,
  pushed boolean not null default false,
  deduped boolean not null default false,

  -- Horizons, each filled independently and only ever null -> value.
  ret_1d numeric,
  scored_1d_at timestamptz,
  ret_3d numeric,
  scored_3d_at timestamptz,
  ret_7d numeric,
  scored_7d_at timestamptz,

  created_at timestamptz not null default now()
);

-- One row per (asset, direction, emit day).
create unique index if not exists signal_ledger_emit_uniq
  on public.signal_ledger (asset, direction, emit_day);

create index if not exists signal_ledger_emitted_at_idx
  on public.signal_ledger (emitted_at desc);

create index if not exists signal_ledger_asset_idx
  on public.signal_ledger (asset, emitted_at desc);

alter table public.signal_ledger enable row level security;

drop policy if exists "anon read signal_ledger" on public.signal_ledger;
create policy "anon read signal_ledger"
  on public.signal_ledger for select to anon using (true);

-- scan-cron writes with the anon key (same as every other table here); the
-- trigger below is what keeps the record honest, not the policy.
drop policy if exists "anon insert signal_ledger" on public.signal_ledger;
create policy "anon insert signal_ledger"
  on public.signal_ledger for insert to anon with check (true);

drop policy if exists "anon update signal_ledger" on public.signal_ledger;
create policy "anon update signal_ledger"
  on public.signal_ledger for update to anon using (true) with check (true);

/**
 * Keep the ledger append-only.
 *
 * 1. Fact columns cannot change at all — a signal's asset, direction, time,
 *    prices and flags describe what happened and are not editable.
 * 2. A horizon column is write-once: null -> value is allowed (that is how
 *    scoring lands), but once non-null it can never change, including back to
 *    null. A lost score is always recoverable by re-scoring; a rewritten one
 *    is not.
 */
create or replace function public.signal_ledger_guard()
returns trigger
language plpgsql
as $$
begin
  if new.asset is distinct from old.asset
     or new.direction is distinct from old.direction
     or new.emitted_at is distinct from old.emitted_at
     or new.price is distinct from old.price
     or new.price_at is distinct from old.price_at
     or new.price_tf is distinct from old.price_tf
     or new.benchmark_symbol is distinct from old.benchmark_symbol
     or new.benchmark_price is distinct from old.benchmark_price
     or new.pushed is distinct from old.pushed
     or new.deduped is distinct from old.deduped
  then
    raise exception 'signal_ledger fact columns are immutable';
  end if;

  if (old.ret_1d is not null and new.ret_1d is distinct from old.ret_1d)
     or (old.scored_1d_at is not null and new.scored_1d_at is distinct from old.scored_1d_at)
     or (old.ret_3d is not null and new.ret_3d is distinct from old.ret_3d)
     or (old.scored_3d_at is not null and new.scored_3d_at is distinct from old.scored_3d_at)
     or (old.ret_7d is not null and new.ret_7d is distinct from old.ret_7d)
     or (old.scored_7d_at is not null and new.scored_7d_at is distinct from old.scored_7d_at)
  then
    raise exception 'signal_ledger horizons are write-once';
  end if;

  return new;
end;
$$;

drop trigger if exists signal_ledger_guard on public.signal_ledger;
create trigger signal_ledger_guard
  before update on public.signal_ledger
  for each row execute function public.signal_ledger_guard();

comment on table public.signal_ledger is
  'Forward-only record of confident signals, written at emit and scored later against a stored benchmark.';
