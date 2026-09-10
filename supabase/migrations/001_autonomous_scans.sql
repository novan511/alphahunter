-- Run this in Supabase SQL Editor once
create table if not exists public.autonomous_scans (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  index_symbol text not null,
  payload jsonb not null
);

create index if not exists autonomous_scans_lookup_idx
  on public.autonomous_scans (index_symbol, created_at desc);

-- Optional: restrict RLS and allow anon read/write for this app
alter table public.autonomous_scans enable row level security;

create policy "anon read autonomous_scans"
  on public.autonomous_scans
  for select
  to anon
  using (true);

create policy "anon insert autonomous_scans"
  on public.autonomous_scans
  for insert
  to anon
  with check (true);
