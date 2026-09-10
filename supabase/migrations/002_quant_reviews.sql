-- Run once in Supabase SQL Editor
create table if not exists public.quant_reviews (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  interval text,
  asset_count int,
  benchmark text,
  credibility text,
  source text,
  review text,
  payload jsonb
);

create index if not exists quant_reviews_created_idx
  on public.quant_reviews (created_at desc);

alter table public.quant_reviews enable row level security;

create policy "anon read quant_reviews"
  on public.quant_reviews for select to anon using (true);

create policy "anon insert quant_reviews"
  on public.quant_reviews for insert to anon with check (true);
