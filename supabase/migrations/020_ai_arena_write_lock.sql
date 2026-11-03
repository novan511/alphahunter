-- Arena state is public-read, never public-write. Server mutations use the
-- Supabase service-role key; it must never be sent to the browser.
drop policy if exists "anon write ai_arena_agents" on public.ai_arena_agents;
drop policy if exists "anon update ai_arena_agents" on public.ai_arena_agents;
drop policy if exists "anon delete ai_arena_agents" on public.ai_arena_agents;
drop policy if exists "anon read ai_arena_agents" on public.ai_arena_agents;
drop policy if exists "public read ai_arena_agents" on public.ai_arena_agents;

revoke insert, update, delete on table public.ai_arena_agents from anon, authenticated;
grant select on table public.ai_arena_agents to anon, authenticated;
grant select, insert, update, delete on table public.ai_arena_agents to service_role;
create policy "public read ai_arena_agents"
  on public.ai_arena_agents for select to anon, authenticated using (true);

-- A process-local boolean is not a lock on serverless deployments. Use a
-- database lease so concurrent Vercel instances cannot run two arena steps.
create table if not exists public.ai_arena_locks (
  lock_name text primary key,
  owner_token uuid not null,
  expires_at timestamptz not null
);

alter table public.ai_arena_locks enable row level security;
revoke all on table public.ai_arena_locks from anon, authenticated;
grant all on table public.ai_arena_locks to service_role;

create or replace function public.claim_ai_arena_step_lock(
  p_owner_token uuid,
  p_lease_seconds integer default 90
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.ai_arena_locks (lock_name, owner_token, expires_at)
  values ('step', p_owner_token, now() + make_interval(secs => greatest(30, least(p_lease_seconds, 180))))
  on conflict (lock_name) do update
    set owner_token = excluded.owner_token,
        expires_at = excluded.expires_at
    where public.ai_arena_locks.expires_at <= now();
  return found;
end;
$$;

create or replace function public.release_ai_arena_step_lock(p_owner_token uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.ai_arena_locks
     set expires_at = now()
   where lock_name = 'step' and owner_token = p_owner_token;
  return found;
end;
$$;

revoke all on function public.claim_ai_arena_step_lock(uuid, integer) from public, anon, authenticated;
revoke all on function public.release_ai_arena_step_lock(uuid) from public, anon, authenticated;
grant execute on function public.claim_ai_arena_step_lock(uuid, integer) to service_role;
grant execute on function public.release_ai_arena_step_lock(uuid) to service_role;
