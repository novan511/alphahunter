-- Structure/pattern context recorded next to each ledger row, so the public
-- record shows what the engine saw at emit time (not just the score).
--
-- Deliberately a separate migration from 012: the ledger ships on its own, and
-- this column is useless until the structure module is wired into scan-cron.
-- See docs/superpowers/specs/2026-10-18-market-structure-patterns-design.md.
--
-- Run manually in the Supabase SQL Editor, like the other migrations here.

alter table public.signal_ledger
  add column if not exists context jsonb;

comment on column public.signal_ledger.context is
  'Structure/pattern read at emit time (per timeframe). Immutable once written.';

-- A second, self-contained guard so 013 does not depend on the exact body of the
-- immutability trigger created in 012.
create or replace function public.signal_ledger_freeze_context()
returns trigger
language plpgsql
as $$
begin
  if new.context is distinct from old.context then
    raise exception 'signal_ledger.context is immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists signal_ledger_freeze_context on public.signal_ledger;

create trigger signal_ledger_freeze_context
  before update on public.signal_ledger
  for each row
  execute function public.signal_ledger_freeze_context();
