-- Dedup cursor for Telegram sector-flip pushes.
--
-- Run once in the Supabase SQL Editor.
--
-- Why this exists
-- ---------------
-- pushCompletedScan in pages/api/scan-cron.ts sends a "SEKTOR BERGERAK"
-- message every time a sweep completes. Without a cursor, the same sector
-- flip is re-pushed every completed sweep while conditions hold — spam that
-- trains the trader to mute the bot.
--
-- `last_notify` stores { sectors: { [sectorId]: isoTimestamp } } per
-- scan_cron_state row. A sector is only re-pushed after 24h, mirroring the
-- existing 24h dedup on confident signals (top_signals.sent_to_telegram).

alter table public.scan_cron_state
  add column if not exists last_notify jsonb not null default '{}';

comment on column public.scan_cron_state.last_notify is
  'Dedup cursor for Telegram pushes: { sectors: { [sectorId]: isoTimestamp } }';
