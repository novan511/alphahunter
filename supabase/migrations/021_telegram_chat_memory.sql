-- Telegram chat memory: bounded conversational context per chat.
--
-- Run once in the Supabase SQL Editor.
--
-- Why this exists
-- ---------------
-- Without memory every Telegram question is a fresh conversation: the model
-- cannot answer "berapa yakin kamu tadi?" or "bandingkan dengan yang BARU saja".
-- This table stores the last few turns per chat_id. It is intentionally NOT an
-- archive — the application caps it at 40 rows per chat and caps each message
-- at 1200 characters before it ever reaches the prompt.
--
-- Security note
-- -------------
-- Same pattern as the other lab tables in this project: the server uses the
-- anon key, so anon needs read/insert/delete here. The bot answers only one
-- configured TELEGRAM_CHAT_ID, so in practice only that chat writes rows.
-- If you open the bot to multiple users, move writes behind a service-role
-- endpoint and scope RLS by chat id.

create table if not exists public.telegram_chat_memory (
  id bigint generated always as identity primary key,
  chat_id text not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists telegram_chat_memory_chat_time_idx
  on public.telegram_chat_memory (chat_id, created_at desc);

alter table public.telegram_chat_memory enable row level security;

drop policy if exists "anon read telegram_chat_memory" on public.telegram_chat_memory;
create policy "anon read telegram_chat_memory"
  on public.telegram_chat_memory for select to anon using (true);

drop policy if exists "anon insert telegram_chat_memory" on public.telegram_chat_memory;
create policy "anon insert telegram_chat_memory"
  on public.telegram_chat_memory for insert to anon with check (true);

drop policy if exists "anon delete telegram_chat_memory" on public.telegram_chat_memory;
create policy "anon delete telegram_chat_memory"
  on public.telegram_chat_memory for delete to anon using (true);
