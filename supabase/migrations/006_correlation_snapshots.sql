-- Pairwise strength matrix snapshots.
--
-- Run once in the Supabase SQL Editor.
--
-- Why this exists
-- ---------------
-- The matrix panel answers "who is stronger than whom right now" from live
-- candles. Persisting each snapshot turns that into a time series, which is
-- the only way to answer the questions that actually drive money:
--
--   * is a coin newly weak, or has it been weak for a week?
--   * is dominance accelerating or decelerating?
--   * did yesterday's leader rotate out of the basket?
--   * how often does this ranking flip? (flip rate == noise level)
--
-- A snapshot with no history is a photo. With history it is a trend.

-- One row per computed matrix.
create table if not exists public.correlation_snapshots (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  -- Basket identity and measurement settings. Unique together so a repeated
  -- scan at the same interval/window overwrites nothing but never duplicates
  -- either: same basket + same params = same measurement.
  symbols text[] not null,
  interval text not null,
  window_bars int not null,

  -- Mean of all off-diagonal pairwise correlations. High means the basket
  -- moves as one, which caps how much rotation is even possible.
  basket_corr double precision,

  -- Full matrices, kept as jsonb. At 6 symbols this is ~1.3 KB; at 12
  -- symbols with 3 matrices it is still well under 10 KB.
  rs jsonb not null,
  corr jsonb not null,
  beta jsonb not null,

  -- Per-coin profile array, same order as `symbols`.
  -- Each entry: symbol, vol, totalReturn, dominance, dominanceRank,
  --            avgCorr, extensionZ, basketBeta
  coins jsonb not null,

  -- Symbols requested but not resolvable this run. Kept so a basket that
  -- silently shrinks is visible instead of looking like a real result.
  missing text[],

  -- Symbols that produced no usable data at the requested window.
  bars_used int,

  -- Regime at capture time, so dominance can be conditioned on market state.
  -- A +8% dominance means something different in a bull than in a chop.
  regime_label text,
  regime_confidence double precision
);

-- Primary read path: latest snapshots for a given basket shape.
create index if not exists correlation_snapshots_created_idx
  on public.correlation_snapshots (created_at desc);

create index if not exists correlation_snapshots_basket_idx
  on public.correlation_snapshots (interval, window_bars, created_at desc);

-- GIN so a basket can be matched by exact membership, e.g. "every snapshot
-- whose basket contains SOL".
create index if not exists correlation_snapshots_symbols_idx
  on public.correlation_snapshots using gin (symbols);

-- Exact-duplicate guard. Note this only catches rows written within the same
-- microsecond, so it protects against a double-insert from a retried request,
-- not against repeated scans of the same basket over time. Time-series
-- repetition is intentional and is what the history view is for. GIN over
-- array_agg equality is not unique-capable, so dedupe is enforced here rather
-- than on basket membership.
create unique index if not exists correlation_snapshots_uniq
  on public.correlation_snapshots (symbols, interval, window_bars, created_at);

alter table public.correlation_snapshots enable row level security;

drop policy if exists "anon read correlation_snapshots" on public.correlation_snapshots;
create policy "anon read correlation_snapshots"
  on public.correlation_snapshots for select to anon using (true);

drop policy if exists "anon insert correlation_snapshots" on public.correlation_snapshots;
create policy "anon insert correlation_snapshots"
  on public.correlation_snapshots for insert to anon with check (true);


-- ---------------------------------------------------------------------------
-- Rolling view: latest profile per coin across recent snapshots.
-- ---------------------------------------------------------------------------
-- The panel needs "how has this coin's dominance been moving", which means
-- reading the newest entry per symbol rather than scanning every row. This
-- view does that so the client does not have to.
create or replace view public.correlation_latest_coins as
with newest as (
  select
    (c->>'symbol')::text as symbol,
    created_at,
    interval,
    window_bars,
    basket_corr,
    (c->>'dominance')::double precision as dominance,
    (c->>'dominanceRank')::int as dominance_rank,
    (c->>'totalReturn')::double precision as total_return,
    (c->>'vol')::double precision as vol,
    (c->>'avgCorr')::double precision as avg_corr,
    (c->>'extensionZ')::double precision as extension_z,
    (c->>'basketBeta')::double precision as basket_beta,
    regime_label
  from public.correlation_snapshots s,
       lateral jsonb_array_elements(s.coins) as c
  where c ? 'symbol'
)
select distinct on (symbol, interval, window_bars)
  symbol, created_at, interval, window_bars, basket_corr,
  dominance, dominance_rank, total_return, vol, avg_corr,
  extension_z, basket_beta, regime_label
from newest
order by symbol, interval, window_bars, created_at desc;


-- ---------------------------------------------------------------------------
-- Dominance history per coin — the trend query the panel will use.
-- ---------------------------------------------------------------------------
create or replace view public.correlation_dominance_history as
select
  (c->>'symbol')::text as symbol,
  s.created_at,
  s.interval,
  s.window_bars,
  (c->>'dominance')::double precision as dominance,
  (c->>'dominanceRank')::int as dominance_rank,
  (c->>'extensionZ')::double precision as extension_z,
  s.regime_label
from public.correlation_snapshots s,
     lateral jsonb_array_elements(s.coins) as c
where c ? 'symbol' and c ? 'dominance';

create index if not exists correlation_dominance_history_idx
  on public.correlation_dominance_history (symbol, interval, created_at desc);


-- ---------------------------------------------------------------------------
-- Retention.
-- ---------------------------------------------------------------------------
-- Snapshots are append-only and grow without bound. 4000 rows is roughly
-- months of history at a sane scan cadence and is still trivial to query.
-- If the table exists from an earlier run without these, they are no-ops.
create or replace function public.prune_correlation_snapshots(
  keep_rows int default 4000
) returns void
language sql
as $$
  delete from public.correlation_snapshots
  where id in (
    select id from public.correlation_snapshots
    order by created_at desc
    offset greatest(keep_rows, 0)
  );
$$;

comment on table public.correlation_snapshots is
  'Pairwise relative-strength matrix snapshots. Query correlation_dominance_history for per-coin trends.';
comment on column public.correlation_snapshots.rs is
  'rs[i][j] = log-strength of symbols[i] over symbols[j], percent. Antisymmetric: rs[j][i] = -rs[i][j].';
comment on column public.correlation_snapshots.basket_corr is
  'Mean off-diagonal pairwise correlation. Above ~0.85 the basket is one trade, not six.';
comment on column public.correlation_snapshots.coins is
  'Per-coin profiles in the same order as symbols.';
comment on column public.correlation_snapshots.missing is
  'Requested symbols that could not be resolved this run.';