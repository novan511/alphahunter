-- R-multiple outcome per ledger row: levels placed at emit, then scored by first
-- touch. Turns the forward record from "alpha at fixed horizons" into
-- "win rate and expectancy in R", which is what a decision needs.
--
-- See docs/superpowers/specs/2026-10-18-signal-calibration-design.md.
-- Run manually in the Supabase SQL Editor, like the other migrations here.

alter table public.signal_ledger
  add column if not exists atr numeric,
  add column if not exists stop numeric,
  add column if not exists target numeric,
  add column if not exists level_convention text,
  add column if not exists r numeric,
  add column if not exists outcome text,
  add column if not exists scored_r_at timestamptz;

comment on column public.signal_ledger.level_convention is
  'Risk convention used to place stop/target. Versioned: rows placed under different rules must never be pooled into one statistic.';

comment on column public.signal_ledger.r is
  'Realised R-multiple, filled exactly once. Null while undecided, and for a lost path where no honest R exists.';

comment on column public.signal_ledger.outcome is
  'target | stop | open (time exit) | lost (path no longer retrievable). Write-once.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'signal_ledger_outcome_chk'
      and conrelid = 'public.signal_ledger'::regclass
  ) then
    alter table public.signal_ledger
      add constraint signal_ledger_outcome_chk
      check (outcome is null or outcome in ('target', 'stop', 'open', 'lost'));
  end if;
end $$;

-- Rows created before this migration have no stop/target and stay excluded from
-- calibration forever. Deliberately not backfilled: filling in a level after the
-- outcome is known is a back door to a fabricated track record.
--
-- `is distinct from` (not `=`) is what enforces that: it counts NULL vs a value
-- as a change, so writing levels onto a pre-015 row raises rather than passing.
create or replace function public.signal_ledger_guard_r()
returns trigger
language plpgsql
as $$
begin
  if new.atr is distinct from old.atr
     or new.stop is distinct from old.stop
     or new.target is distinct from old.target
     or new.level_convention is distinct from old.level_convention then
    raise exception 'signal_ledger levels are immutable';
  end if;

  if old.outcome is not null
     and (new.outcome is distinct from old.outcome
          or new.r is distinct from old.r
          or new.scored_r_at is distinct from old.scored_r_at) then
    raise exception 'signal_ledger outcome is write-once';
  end if;

  -- Independent of outcome: the application happens to write r and outcome in
  -- one statement, and the invariant must not rest on that.
  if old.r is not null and new.r is distinct from old.r then
    raise exception 'signal_ledger.r is write-once';
  end if;

  return new;
end;
$$;

drop trigger if exists signal_ledger_guard_r on public.signal_ledger;

create trigger signal_ledger_guard_r
  before update on public.signal_ledger
  for each row
  execute function public.signal_ledger_guard_r();
