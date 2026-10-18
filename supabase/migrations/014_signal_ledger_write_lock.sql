-- Close the ledger's write path to the anon key.
--
-- 012 shipped with "anon insert" / "anon update" policies, copying the pattern
-- every other table here uses. That pattern is fine for a table whose worst case
-- is a corrupted dashboard. It is not fine for the table whose entire purpose is
-- proving a number was not written by someone else: the anon key is public, so
-- with those policies anyone could insert a fabricated signal and fill in its
-- result. The BEFORE UPDATE trigger from 012 only constrains changes, not who
-- may insert.
--
-- Writes now go through the service-role client (lib/supabaseAdmin.ts). Reads
-- stay public. Run manually in the Supabase SQL Editor, after 012.

drop policy if exists "anon insert signal_ledger" on public.signal_ledger;
drop policy if exists "anon update signal_ledger" on public.signal_ledger;

comment on table public.signal_ledger is
  'Forward-only record of confident signals. Public select; writes require the service role.';
