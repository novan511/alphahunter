-- AI Arena: satu baris per model peserta (state jsonb penuh: cash, positions, trades, R stats, iter log)
create table if not exists public.ai_arena_agents (
  id text primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.ai_arena_agents enable row level security;

create policy "anon read ai_arena_agents"
  on public.ai_arena_agents for select to anon using (true);

create policy "anon write ai_arena_agents"
  on public.ai_arena_agents for insert to anon with check (true);

create policy "anon update ai_arena_agents"
  on public.ai_arena_agents for update to anon using (true);

create policy "anon delete ai_arena_agents"
  on public.ai_arena_agents for delete to anon using (true);
