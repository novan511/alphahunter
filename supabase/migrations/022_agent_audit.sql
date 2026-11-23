-- Agent audit + konfirmasi yang durable (Fase 2).
--
-- Run once in the Supabase SQL Editor.
--
-- Kenapa WAJIB service role
-- -------------------------
-- anon key ikut terkemas di browser bundle, jadi siapa pun bisa membacanya.
-- Kalau anon diizinkan menulis di sini, orang luar bisa:
--   1. menyuntik baris audit "executed" dengan idempotency_key palsu supaya
--      tool tulis tidak pernah benar-benar jalan (atau sebaliknya), dan
--   2. memasukkan / mengambil token konfirmasi untuk chat lain.
-- Karena itu kedua tabel memakai RLS TANPA policy anon/authenticated sama
-- sekali. Hanya service-role (yang dipakai server, bukan browser) yang lewat.
--
-- Idempotency juga hanya diakui untuk baris yang statusnya benar 'executed'.
-- Baris needs_confirmation / failed / dry_run tidak boleh mengunci key.

create table if not exists public.agent_audit (
  id text primary key,
  ts timestamptz not null default now(),
  correlation_id text not null,
  chat_id text not null,
  tool_name text,
  args jsonb,
  status text not null,
  idempotency_key text,
  detail text not null,
  duration_ms integer not null default 0,
  result jsonb
);

-- Partial unique index: satu idempotency_key hanya boleh punya SATU baris
-- executed. Webhook yang di-retry akan kena constraint ini dan sink tetap
-- menganggap append sebagai best-effort.
create unique index if not exists agent_audit_executed_key_uidx
  on public.agent_audit (idempotency_key)
  where idempotency_key is not null and status = 'executed';

create index if not exists agent_audit_correlation_idx
  on public.agent_audit (correlation_id);
create index if not exists agent_audit_chat_ts_idx
  on public.agent_audit (chat_id, ts desc);
create index if not exists agent_audit_status_idx
  on public.agent_audit (status);

create table if not exists public.agent_confirmation (
  token text primary key,
  chat_id text not null,
  question text not null,
  tool_name text not null,
  arguments text not null,
  created_at timestamptz default now(),
  expires_at timestamptz not null
);

create index if not exists agent_confirmation_chat_idx
  on public.agent_confirmation (chat_id, expires_at desc);
create index if not exists agent_confirmation_expires_idx
  on public.agent_confirmation (expires_at);

alter table public.agent_audit enable row level security;
alter table public.agent_confirmation enable row level security;

-- Tidak ada `create policy ... to anon` di bawah ini — itu disengaja.
revoke all on table public.agent_audit from anon, authenticated;
revoke all on table public.agent_confirmation from anon, authenticated;
grant all on table public.agent_audit to service_role;
grant all on table public.agent_confirmation to service_role;
