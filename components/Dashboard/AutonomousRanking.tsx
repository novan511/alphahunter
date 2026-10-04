import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MultiTimeframeResult } from '../../lib/algorithms/multiTimeframe';
import { CATEGORIES, CategoryId, allCategoryIds } from '../../lib/assetCategory';
import { downloadCsv, csvTimestampedName } from '../../lib/csv';
import { useWatchlist } from '../../lib/watchlist';
import { SkeletonPanel } from './Skeleton';

interface AutonomousRankingProps {
  rankings: MultiTimeframeResult[];
  onSelectAsset: (symbol: string) => void;
  selectedAsset: string;
  /**
   * Sector to narrow to, driven by the narrative radar above. `undefined` means
   * the radar is not participating and this table keeps its own local filter;
   * `null` explicitly clears it.
   */
  focusCategory?: string | null;
  /** Called when the table's own category chips change, so the radar can follow. */
  onFocusCategoryChange?: (id: string | null) => void;
  /**
   * Signal filter + sort are lifted so the URL can carry them: a shared link
   * should reopen on the same view instead of resetting to "All / default".
   */
  filter: SignalFilter;
  onFilterChange: (f: SignalFilter) => void;
  sort: SortState;
  onSortChange: (s: SortState) => void;
  /** True while a sweep is in flight, so we can show a skeleton instead of an empty box. */
  loading?: boolean;
}

const SIGNAL_COLORS: Record<string, string> = {
  strong_buy: '#10b981',
  buy: '#34d399',
  strong_sell: '#ef4444',
  sell: '#f87171',
  neutral: '#6b7280',
};

const TF_COLORS: Record<string, string> = {
  bullish: '#10b981',
  bearish: '#ef4444',
  neutral: '#6b7280',
};

const SIGNAL_RANK: Record<MultiTimeframeResult['finalSignal'], number> = {
  strong_buy: 5,
  buy: 4,
  neutral: 3,
  sell: 2,
  strong_sell: 1,
};

type SortDir = 'asc' | 'desc';
export type SortKey =
  | 'signal' | 'conf' | 'rsz' | 'conviction' | 'agreement' | 'liquidity'
  | 'mcap' | 'rank' | 'category';
export type SortState = Partial<Record<SortKey, SortDir>>;

const SORT_PRIORITY: SortKey[] = [
  'signal', 'conf', 'conviction', 'agreement', 'category', 'rsz', 'liquidity', 'mcap', 'rank',
];

/** Rows painted before the user scrolls, and how many each additional page adds. */
const INITIAL_VISIBLE = 60;
const PAGE_SIZE = 120;

/** Which optional column groups the user wants visible. */
type ViewKey = 'metrics' | 'narrative' | 'cap';
const VIEW_OPTIONS: Array<{ key: ViewKey; label: string; hint: string }> = [
  { key: 'metrics', label: 'Metrics', hint: 'Conv / Agree / Liq / Score columns' },
  { key: 'narrative', label: 'Narrative', hint: 'Category (DeFi, L1, meme…) + plain-language read' },
  { key: 'cap', label: 'Market Cap', hint: 'Cap tier + size, sortable' },
];
type ViewState = Record<ViewKey, boolean>;

/** Cap tier ordering, largest first. */
const TIER_RANK: Record<string, number> = {
  mega: 0, large: 1, mid: 2, small: 3, micro: 4, unknown: 5,
};

/** Category ordering: core sectors first, "other" last. */
const CAT_ORDER: Record<string, number> = (() => {
  const m: Record<string, number> = {};
  allCategoryIds().forEach((id, i) => { m[id] = i; });
  return m;
})();

const TIER_LABEL: Record<string, string> = {
  mega: 'Mega', large: 'Large', mid: 'Mid', small: 'Small', micro: 'Micro', unknown: '—',
};

const TIER_COLOR: Record<string, string> = {
  mega: '#10b981', large: '#34d399', mid: '#f59e0b', small: '#fb923c', micro: '#ef4444', unknown: '#6b7280',
};

function formatCap(v?: number | null): string {
  if (v == null || !Number.isFinite(v) || v <= 0) return '—';
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  return `$${(v / 1e3).toFixed(0)}K`;
}

/** Quick filters so the trader can isolate conviction calls. */
export type SignalFilter = 'all' | 'strong_buy' | 'buy' | 'strong_sell' | 'sell' | 'non_neutral';

export const SIGNAL_FILTERS: Array<{ key: SignalFilter; label: string; color: string }> = [
  { key: 'all', label: 'All', color: '#9ca3af' },
  { key: 'non_neutral', label: 'Any Signal', color: '#3b82f6' },
  { key: 'strong_buy', label: 'Strong Buy', color: '#10b981' },
  { key: 'buy', label: 'Buy', color: '#34d399' },
  { key: 'strong_sell', label: 'Strong Sell', color: '#ef4444' },
  { key: 'sell', label: 'Sell', color: '#f87171' },
];

const FILTERS = SIGNAL_FILTERS;

const SIGNAL_STRENGTH: Record<MultiTimeframeResult['finalSignal'], number> = {
  strong_buy: 4,
  buy: 3,
  neutral: 2,
  sell: 1,
  strong_sell: 0,
};

function matchesFilter(r: MultiTimeframeResult, filter: SignalFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'non_neutral') return r.finalSignal !== 'neutral';
  return r.finalSignal === filter;
}

function nextSortDir(prev: SortDir | undefined): SortDir | undefined {
  if (prev === undefined) return 'desc';
  if (prev === 'desc') return 'asc';
  return undefined;
}

export default function AutonomousRanking({
  rankings,
  onSelectAsset,
  selectedAsset,
  focusCategory,
  onFocusCategoryChange,
  filter,
  onFilterChange,
  sort,
  onSortChange,
  loading,
}: AutonomousRankingProps) {
  const [catFilter, setCatFilterState] = useState<string>('all');
  /**
   * Rows rendered so far. Starts small — a full sweep is ~700 rows and painting
   * all of them at once is what made mid-range phones stutter on first paint.
   * IntersectionObserver below grows it as the user scrolls.
   */
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
  const [view, setView] = useState<ViewState>({ metrics: true, narrative: false, cap: false });
  const [starredOnly, setStarredOnly] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const { isWatched, toggle: toggleWatch, ready: watchReady, items: watchItems } = useWatchlist();
  const watchlistCount = watchItems.length;

  const applyFilter = useCallback(
    (next: SignalFilter) => {
      onFilterChange?.(next);
      setVisibleCount(INITIAL_VISIBLE);
    },
    [onFilterChange]
  );

  const applySort = useCallback(
    (next: SortState) => {
      onSortChange?.(next);
      setVisibleCount(INITIAL_VISIBLE);
    },
    [onSortChange]
  );

  // Auto-load the next page when the sentinel scrolls into view. Kept as an
  // enhancement over the button — the button stays for keyboard/AT users.
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    if (visibleCount >= rankings.length) return;

    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisibleCount((c) => (c === visibleCount ? c + PAGE_SIZE : c));
        }
      },
      { rootMargin: '400px 0px' }
    );
    io.observe(node);
    return () => io.disconnect();
  }, [visibleCount, rankings.length]);

  // Sector picked in the narrative radar becomes this table's filter. The
  // narrative column group is force-enabled, otherwise the selected category
  // would be invisible — the user filtered by something they cannot see.
  useEffect(() => {
    if (focusCategory === undefined) return;
    setCatFilterState(focusCategory ?? 'all');
    if (focusCategory) setView((prev) => ({ ...prev, narrative: true }));
  }, [focusCategory]);

  /**
   * Category filter. When the radar is driving, `notify` pushes the change back
   * up so the radar's highlight and this table never disagree about which
   * sector is focused.
   */
  const setCatFilter = (next: string, notify = false) => {
    setCatFilterState(next);
    setVisibleCount(INITIAL_VISIBLE);
    if (notify) onFocusCategoryChange?.(next === 'all' ? null : next);
  };

  const toggleView = (key: ViewKey) => {
    setView((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      // Never allow every column group off — an empty table is a dead end.
      if (!next.metrics && !next.narrative && !next.cap) return prev;
      return next;
    });
  };

  /**
   * Asset → position in the full (unfiltered) ranking, for the "#" column.
   * A Map instead of `findIndex` per row: that was O(n²) over ~700 rows on
   * every render, which is exactly the kind of thing that janks a phone.
   */
  const rankIndex = useMemo(() => {
    const m = new Map<string, number>();
    rankings.forEach((r, i) => m.set(r.asset, i));
    return m;
  }, [rankings]);

  const capTierCounts = useMemo(() => {
    const c: Record<string, number> = { mega: 0, large: 0, mid: 0, small: 0, micro: 0, unknown: 0 };
    for (const r of rankings) {
      const t = r.capTier ?? 'unknown';
      if (t in c) c[t]++;
    }
    return c;
  }, [rankings]);

  const catCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rankings) {
      const id = r.category ?? 'other';
      c[id] = (c[id] ?? 0) + 1;
    }
    return c;
  }, [rankings]);

  /** Only render category chips that actually occur, in taxonomy order. */
  const activeCats = useMemo(
    () => allCategoryIds().filter((id) => (catCounts[id] ?? 0) > 0),
    [catCounts]
  );

  const filterCounts = useMemo(() => {
    const c: Record<SignalFilter, number> = {
      all: rankings.length,
      non_neutral: 0,
      strong_buy: 0,
      buy: 0,
      strong_sell: 0,
      sell: 0,
    };
    for (const r of rankings) {
      if (r.finalSignal !== 'neutral') c.non_neutral++;
      if (r.finalSignal in c) {
        c[r.finalSignal as Exclude<SignalFilter, 'all' | 'non_neutral'>]++;
      }
    }
    return c;
  }, [rankings]);

  const sortedRankings = useMemo(() => {
    const filtered = rankings.filter(
      (r) =>
        matchesFilter(r, filter) &&
        (catFilter === 'all' || (r.category ?? 'other') === catFilter) &&
        // Starred-only is a conjunction with the other filters, not a replacement:
        // "my picks, within this sector" is the query people actually want.
        (!starredOnly || watchItems.includes(r.asset))
    );
    const active = SORT_PRIORITY.filter((key) => sort[key]).map((key) => ({ key, dir: sort[key]! }));
    if (active.length === 0) return filtered;

    const getSignal = (r: MultiTimeframeResult) => SIGNAL_STRENGTH[r.finalSignal] ?? 0;
    const getConf = (r: MultiTimeframeResult) => r.confluenceScore;
    const getRsz = (r: MultiTimeframeResult) => r.timeframes[1]?.rsZScore ?? 0;
    const getConviction = (r: MultiTimeframeResult) => r.conviction ?? 0;
    const getAgreement = (r: MultiTimeframeResult) => r.agreement ?? 0;
    const getLiq = (r: MultiTimeframeResult) => r.liquidityFactor ?? 0;
    const getMcap = (r: MultiTimeframeResult) =>
      Number.isFinite(r.marketCap as number) ? (r.marketCap as number) : -1;
    const getTier = (r: MultiTimeframeResult) => TIER_RANK[r.capTier ?? 'unknown'] ?? 5;
    const getCat = (r: MultiTimeframeResult) => CAT_ORDER[r.category ?? 'other'] ?? 99;

    return [...filtered].sort((a, b) => {
      for (const { key, dir } of active) {
        const mul = dir === 'desc' ? 1 : -1;
        let diff = 0;
        if (key === 'signal') diff = (getSignal(a) - getSignal(b)) * mul;
        if (key === 'conf') diff = (getConf(a) - getConf(b)) * mul;
        if (key === 'conviction') diff = (getConviction(a) - getConviction(b)) * mul;
        if (key === 'agreement') diff = (getAgreement(a) - getAgreement(b)) * mul;
        if (key === 'rsz') diff = (getRsz(a) - getRsz(b)) * mul;
        if (key === 'liquidity') diff = (getLiq(a) - getLiq(b)) * mul;
        if (key === 'mcap') diff = (getMcap(a) - getMcap(b)) * mul;
        // "Rank" sorts by tier (mega first on desc), then by cap within tier.
        if (key === 'rank') {
          const t = getTier(a) - getTier(b);
          diff = (t !== 0 ? t : getMcap(a) - getMcap(b)) * mul;
        }
        if (key === 'category') diff = (getCat(a) - getCat(b)) * mul;
        if (diff !== 0) return diff;
      }
      return getSignal(b) - getSignal(a);
    });
  }, [rankings, sort, filter, catFilter, starredOnly, watchItems]);

  if (rankings.length === 0) {
    // During the first sweep there is nothing to show yet — a skeleton keeps
    // the layout from collapsing and reads as "working" rather than "broken".
    if (loading) return <SkeletonPanel rows={8} />;
    return (
      <div style={{
        background: '#111827',
        borderRadius: '12px',
        border: '1px solid #374151',
        padding: '32px',
        textAlign: 'center',
        color: '#6b7280',
        fontSize: '13px',
      }}>
        Waiting for scan… Previous results will restore automatically after first load.
      </div>
    );
  }

  const toggleSort = (key: SortKey) => {
    const next: SortState = { ...sort };
    const dir = nextSortDir(sort[key]);
    if (dir) next[key] = dir;
    else delete next[key];
    applySort(next);
  };

  const sortLabel = (key: SortKey) =>
    sort[key] === 'desc' ? ' ▼' : sort[key] === 'asc' ? ' ▲' : '';

  const sortableTh = (key: SortKey, label: string) => (
    <th
      style={{
        ...thStyle,
        cursor: 'pointer',
        userSelect: 'none',
        color: sort[key] ? '#3b82f6' : '#6b7280',
      }}
      onClick={() => toggleSort(key)}
      // Keyboard parity: a clickable header that cannot be reached by Tab is
      // unusable for anyone not holding a mouse.
      tabIndex={0}
      role="columnheader"
      aria-sort={
        sort[key] === 'desc' ? 'descending' : sort[key] === 'asc' ? 'ascending' : 'none'
      }
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleSort(key);
        }
      }}
      title={`Click to sort by ${label} (best → worst → reverse → default). Multiple columns combine.`}
    >
      {label}{sortLabel(key)}
    </th>
  );

  /** Export the current view — same rows the user is looking at, not the raw set. */
  const exportCsv = () => {
    const header: (string | number)[] = ['#', 'Asset', 'Signal', 'Score', 'Conviction', 'Agreement', 'Liquidity', 'RS Z (4h)'];
    if (view.metrics) header.push('Conv', 'Agree', 'Liq');
    if (view.cap) header.push('Cap Tier', 'Market Cap');
    if (view.narrative) header.push('Category', 'Read');

    const body = sortedRankings.slice(0, visibleCount).map((r, i) => {
      const row: (string | number)[] = [
        i + 1,
        r.asset,
        r.finalSignal,
        r.confluenceScore,
        Math.round((r.conviction ?? 0) * 100),
        Math.round((r.agreement ?? 0) * 100),
        Math.round((r.liquidityFactor ?? 0) * 100),
        (r.timeframes[1]?.rsZScore ?? 0).toFixed(2),
      ];
      if (view.metrics) {
        row.push(
          `${Math.round((r.conviction ?? 0) * 100)}%`,
          `${Math.round((r.agreement ?? 0) * 100)}%`,
          `${Math.round((r.liquidityFactor ?? 0) * 100)}%`
        );
      }
      if (view.cap) {
        row.push(TIER_LABEL[r.capTier ?? 'unknown'] ?? '—', formatCap(r.marketCap));
      }
      if (view.narrative) {
        row.push(r.categoryLabel ?? 'Other', r.narrative || '');
      }
      return row;
    });

    downloadCsv(csvTimestampedName('althunter-ranking'), [header, ...body]);
  };

  return (
    <div style={{
      background: '#111827',
      borderRadius: '12px',
      border: '1px solid #374151',
      overflow: 'hidden',
    }}>
      <div className="ah-panel-head" style={{
        padding: '12px 16px',
        borderBottom: '1px solid #374151',
      }}>
        <h3 style={{ fontSize: '14px', fontWeight: '600', color: '#f9fafb', margin: 0 }}>
          Autonomous Rankings ({rankings.length} assets)
        </h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <div style={{ fontSize: '11px', color: '#6b7280' }}>
            <span style={{ color: '#10b981', fontWeight: '600' }}>{filterCounts.non_neutral}</span> signals
            {filter !== 'all' && filter !== 'non_neutral' && (
              <span> · showing {sortedRankings.length}</span>
            )}
          </div>
          <button
            onClick={exportCsv}
            title="Unduh baris yang sedang tampil sebagai CSV"
            className="ah-action"
            style={{
              padding: '5px 11px',
              background: 'transparent',
              border: '1px solid #374151',
              borderRadius: '6px',
              color: '#9ca3af',
              fontSize: '11px',
              fontWeight: 600,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            ⬇ CSV
          </button>
        </div>
      </div>

      {/* Column group toggles + signal filter in one toolbar */}
      <div style={{
        padding: '10px 16px',
        borderBottom: '1px solid #374151',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        flexWrap: 'wrap',
      }}>
        {/* Column group toggles */}
        <span style={{
          fontSize: '9px', fontWeight: '700', color: '#6b7280',
          textTransform: 'uppercase', letterSpacing: '0.5px',
          marginRight: '2px',
        }}>
          Columns
        </span>
        {VIEW_OPTIONS.map((v) => {
          const on = view[v.key];
          return (
            <button
              key={v.key}
              onClick={() => toggleView(v.key)}
              title={v.hint}
              style={{
                padding: '4px 10px',
                borderRadius: '6px',
                border: `1px solid ${on ? '#8b5cf666' : '#374151'}`,
                background: on ? 'rgba(139, 92, 246, 0.14)' : 'transparent',
                color: on ? '#a78bfa' : '#9ca3af',
                fontSize: '10px',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {on ? '✓ ' : ''}{v.label}
            </button>
          );
        })}
        {view.cap && (
          <span style={{ fontSize: '10px', color: '#6b7280', marginLeft: '4px' }}>
            {capTierCounts.mega}m · {capTierCounts.large}l · {capTierCounts.mid}d · {capTierCounts.small}s
            {capTierCounts.micro > 0 ? ` · ${capTierCounts.micro}µ` : ''}
          </span>
        )}
      </div>

      {/* Category filter — narrow to one sector */}
      {view.narrative && activeCats.length > 0 && (
        <div style={{
          padding: '8px 16px',
          borderBottom: '1px solid #374151',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          flexWrap: 'wrap',
        }}>
          <span style={{
            fontSize: '9px', fontWeight: '700', color: '#6b7280',
            textTransform: 'uppercase', letterSpacing: '0.5px', marginRight: '2px',
          }}>
            Category
          </span>
          <button
            onClick={() => setCatFilter('all', true)}
            style={{
              padding: '3px 9px', borderRadius: '6px', fontSize: '10px', fontWeight: 600,
              border: `1px solid ${catFilter === 'all' ? '#8b5cf666' : '#374151'}`,
              background: catFilter === 'all' ? 'rgba(139,92,246,0.14)' : 'transparent',
              color: catFilter === 'all' ? '#a78bfa' : '#9ca3af',
              cursor: 'pointer',
            }}
          >
            All {rankings.length}
          </button>
          {activeCats.map((id) => {
            const meta = CATEGORIES[id];
            const on = catFilter === id;
            return (
              <button
                key={id}
                onClick={() => setCatFilter(on ? 'all' : id, true)}
                title={meta?.blurb}
                style={{
                  padding: '3px 9px', borderRadius: '6px', fontSize: '10px', fontWeight: 600,
                  border: `1px solid ${on ? meta.color + '66' : '#374151'}`,
                  background: on ? `${meta.color}22` : 'transparent',
                  color: on ? meta.color : '#9ca3af',
                  cursor: 'pointer',
                }}
              >
                {meta.icon} {meta.label}
                <span style={{ opacity: 0.65, marginLeft: '4px' }}>{catCounts[id]}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Signal filter */}
      <div style={{
        padding: '10px 16px',
        borderBottom: '1px solid #374151',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        flexWrap: 'wrap',
      }}>
        <span style={{ fontSize: '9px', fontWeight: '700', color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.5px', marginRight: '2px' }}>
          Signal
        </span>
        {FILTERS.map((f) => {
          const activeFilter = filter === f.key;
          const count = filterCounts[f.key];
          const disabled = count === 0 && !activeFilter;
          return (
            <button
              key={f.key}
              onClick={() => applyFilter(f.key)}
              disabled={disabled}
              aria-pressed={activeFilter}
              style={{
                padding: '4px 10px',
                borderRadius: '6px',
                border: `1px solid ${activeFilter ? f.color + '66' : '#374151'}`,
                background: activeFilter ? `${f.color}22` : 'transparent',
                color: disabled ? '#4b5563' : activeFilter ? f.color : '#9ca3af',
                fontSize: '10px',
                fontWeight: 600,
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.5 : 1,
              }}
            >
              {f.label}
              <span style={{ opacity: 0.65, marginLeft: '4px' }}>{count.toLocaleString()}</span>
            </button>
          );
        })}
        {/* User's own pinned assets — separate from the computed signal filters. */}
        <span style={{
          fontSize: '9px', fontWeight: '700', color: '#6b7280',
          textTransform: 'uppercase', letterSpacing: '0.5px',
          marginLeft: '6px', paddingLeft: '10px', borderLeft: '1px solid #374151',
        }}>
          Starred
        </span>
        <button
          onClick={() => setStarredOnly((v) => !v)}
          disabled={watchReady && !starredOnly && watchlistCount === 0}
          aria-pressed={starredOnly}
          title="Tampilkan hanya aset yang Anda tandai ⭐"
          style={{
            padding: '4px 10px',
            borderRadius: '6px',
            border: `1px solid ${starredOnly ? '#f59e0b66' : '#374151'}`,
            background: starredOnly ? '#f59e0b22' : 'transparent',
            color: starredOnly ? '#f59e0b' : '#9ca3af',
            fontSize: '10px',
            fontWeight: 600,
            cursor: watchReady && !starredOnly && watchlistCount === 0 ? 'not-allowed' : 'pointer',
            opacity: watchReady && !starredOnly && watchlistCount === 0 ? 0.5 : 1,
          }}
        >
          ⭐ {starredOnly ? 'Menampilkan' : 'Saja'}
          <span style={{ opacity: 0.65, marginLeft: '4px' }}>{watchlistCount}</span>
        </button>
      </div>

      {sortedRankings.length === 0 ? (
        <div style={{ padding: '32px', textAlign: 'center', color: '#6b7280', fontSize: '12px' }}>
          No assets match this filter. Try “All” or run a wider scan.
        </div>
      ) : (
      <div className="ah-scroll">
        <table style={{ width: '100%', minWidth: '790px', borderCollapse: 'collapse', fontSize: '11px' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #374151' }}>
              <th style={{ ...thStyle, width: '26px' }} aria-label="Watchlist" />
              <th style={thStyle}>#</th>
              <th style={thStyle}>Asset</th>
              <th style={thStyle}>1h</th>
              <th style={thStyle}>4h</th>
              <th style={thStyle}>1d</th>
              {sortableTh('rsz', 'RS Z')}
              {view.metrics && sortableTh('conviction', 'Conv')}
              {view.metrics && sortableTh('agreement', 'Agree')}
              {view.metrics && sortableTh('liquidity', 'Liq')}
              {view.cap && sortableTh('rank', 'Cap Tier')}
              {view.cap && sortableTh('mcap', 'Market Cap')}
              {view.narrative && sortableTh('category', 'Category')}
              {view.narrative && <th style={{ ...thStyle, minWidth: '420px' }}>Read</th>}
              {sortableTh('conf', 'Score')}
              {sortableTh('signal', 'Signal')}
            </tr>
          </thead>
          <tbody>
            {sortedRankings.slice(0, visibleCount).map((result) => {
              const originalIndex = rankIndex.get(result.asset) ?? -1;
              const isSelected = result.asset === selectedAsset;
              const signalColor = SIGNAL_COLORS[result.finalSignal] || '#6b7280';
              const watched = isWatched(result.asset);
              const ticker = result.asset.replace('USDT', '');
              return (
                <tr
                  key={result.asset}
                  onClick={() => onSelectAsset(result.asset)}
                  // A row that only responds to click is unreachable without a mouse.
                  tabIndex={0}
                  role="button"
                  aria-pressed={isSelected}
                  aria-label={`${ticker}, signal ${result.finalSignal.replace('_', ' ')}, skor ${result.confluenceScore}`}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelectAsset(result.asset);
                    }
                  }}
                  className="ah-row"
                  style={{
                    borderBottom: '1px solid #1f2937',
                    cursor: 'pointer',
                    background: isSelected ? 'rgba(59, 130, 246, 0.1)' : 'transparent',
                  }}
                  onMouseEnter={(e) => {
                    if (!isSelected) e.currentTarget.style.background = 'rgba(59, 130, 246, 0.05)';
                  }}
                  onMouseLeave={(e) => {
                    if (!isSelected) e.currentTarget.style.background = 'transparent';
                  }}
                >
                  <td style={{ ...tdStyle, padding: '8px 4px' }}>
                    <button
                      type="button"
                      className="ah-star"
                      aria-pressed={watched}
                      aria-label={watched ? `Hapus ${ticker} dari watchlist` : `Tambah ${ticker} ke watchlist`}
                      title={watched ? 'Hapus dari watchlist' : 'Tandai ⭐'}
                      onClick={(e) => {
                        // Row also has onClick — without this the star would toggle
                        // and then immediately re-select the asset.
                        e.stopPropagation();
                        toggleWatch(result.asset);
                      }}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      {watched ? '★' : '☆'}
                    </button>
                  </td>
                  <td style={tdStyle}>{originalIndex >= 0 ? originalIndex + 1 : '—'}</td>
                  <td style={{ ...tdStyle, fontWeight: '600', color: '#f9fafb' }}>
                    {ticker}
                  </td>
                  {result.timeframes.map((tf) => (
                    <td key={tf.timeframe} style={{ ...tdStyle, textAlign: 'center' }}>
                      <div style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px',
                      }}>
                        <div style={{
                          width: '6px',
                          height: '6px',
                          borderRadius: '50%',
                          background: TF_COLORS[tf.trendDirection],
                        }} />
                        <span style={{ color: TF_COLORS[tf.trendDirection], fontSize: '10px' }}>
                          {tf.trendDirection === 'bullish' ? '↑' : tf.trendDirection === 'bearish' ? '↓' : '—'}
                        </span>
                        {tf.signal && (
                          <span
                            title={tf.signalAgeBars != null ? `Signal age: ${tf.signalAgeBars} bars` : 'Fresh signal'}
                            style={{
                              fontSize: '8px',
                              fontWeight: '700',
                              color: tf.signal.type === 'buy' ? '#10b981' : '#ef4444',
                              marginLeft: '2px',
                            }}
                          >
                            {tf.signalAgeBars != null && tf.signalAgeBars > 5 ? '◐' : '●'}
                          </span>
                        )}
                      </div>
                    </td>
                  ))}
                  <td style={{
                    ...tdStyle,
                    color: (result.timeframes[1]?.rsZScore ?? 0) > 0 ? '#10b981' : '#ef4444',
                    fontWeight: Math.abs(result.timeframes[1]?.rsZScore ?? 0) >= 2 ? '700' : '400',
                  }}
                      title={result.timeframes[1]?.rsPValue != null
                        ? `p-value ${result.timeframes[1].rsPValue} — ${result.timeframes[1].rsPValue < 0.05 ? 'statistically significant' : 'not significant'}`
                        : undefined}
                  >
                    {result.timeframes[1]?.rsZScore.toFixed(2) || '—'}
                  </td>
                  {view.metrics && (
                    <td style={{ ...tdStyle, color: (result.conviction ?? 0) >= 0.6 ? '#10b981' : '#9ca3af' }}>
                      {((result.conviction ?? 0) * 100).toFixed(0)}%
                    </td>
                  )}
                  {view.metrics && (
                    <td style={{
                      ...tdStyle,
                      color: (result.agreement ?? 0) >= 0.8 ? '#10b981' : (result.agreement ?? 0) >= 0.5 ? '#f59e0b' : '#6b7280',
                    }}
                        title="Share of the timeframe stack agreeing with the signal direction"
                    >
                      {((result.agreement ?? 0) * 100).toFixed(0)}%
                    </td>
                  )}
                  {view.metrics && (
                    <td style={{
                      ...tdStyle,
                      color: (result.liquidityFactor ?? 0) >= 0.85 ? '#10b981' : (result.liquidityFactor ?? 0) >= 0.45 ? '#f59e0b' : '#ef4444',
                    }}
                        title="24h volume quality — thin books produce wicks, not signals"
                    >
                      {((result.liquidityFactor ?? 0) * 100).toFixed(0)}%
                    </td>
                  )}
                  {view.cap && (
                    <td style={{ ...tdStyle }}>
                      <span style={{
                        padding: '2px 6px',
                        borderRadius: '4px',
                        fontSize: '9px',
                        fontWeight: 700,
                        background: `${TIER_COLOR[result.capTier ?? 'unknown']}20`,
                        color: TIER_COLOR[result.capTier ?? 'unknown'],
                      }}>
                        {TIER_LABEL[result.capTier ?? 'unknown']}
                      </span>
                    </td>
                  )}
                  {view.cap && (
                    <td style={{ ...tdStyle, color: '#9ca3af', whiteSpace: 'nowrap' }}>
                      {formatCap(result.marketCap)}
                    </td>
                  )}
                  {view.narrative && (
                    <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                      <span
                        title={CATEGORIES[(result.category ?? 'other') as CategoryId]?.blurb}
                        style={{
                          padding: '2px 6px',
                          borderRadius: '4px',
                          fontSize: '9px',
                          fontWeight: 700,
                          background: `${CATEGORIES[(result.category ?? 'other') as CategoryId]?.color ?? '#6b7280'}20`,
                          color: CATEGORIES[(result.category ?? 'other') as CategoryId]?.color ?? '#6b7280',
                        }}
                      >
                        {CATEGORIES[(result.category ?? 'other') as CategoryId]?.icon}{' '}
                        {result.categoryLabel ?? 'Other'}
                      </span>
                    </td>
                  )}
                  {view.narrative && (
                    <td style={{
                      ...tdStyle,
                      color: '#9ca3af',
                      lineHeight: 1.5,
                      minWidth: '420px',
                      fontSize: '10px',
                    }}>
                      {result.narrative || '—'}
                    </td>
                  )}
                  <td style={{ ...tdStyle, color: result.confluenceScore >= 70 ? '#10b981' : result.confluenceScore >= 40 ? '#f59e0b' : '#6b7280' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <div style={{
                        width: '40px',
                        height: '4px',
                        background: '#1f2937',
                        borderRadius: '2px',
                        overflow: 'hidden',
                      }}>
                        <div style={{
                          width: `${result.confluenceScore}%`,
                          height: '100%',
                          background: result.confluenceScore >= 70 ? '#10b981' : result.confluenceScore >= 40 ? '#f59e0b' : '#6b7280',
                          borderRadius: '2px',
                        }} />
                      </div>
                      <span>{result.confluenceScore}</span>
                    </div>
                  </td>
                  <td style={tdStyle}>
                    <span style={{
                      padding: '2px 6px',
                      borderRadius: '4px',
                      fontSize: '9px',
                      fontWeight: '700',
                      background: `${signalColor}20`,
                      color: signalColor,
                      whiteSpace: 'nowrap',
                    }}>
                      {result.finalSignal.replace('_', ' ').toUpperCase()}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {/* Sentinel: IntersectionObserver grows visibleCount as it approaches. */}
        <div ref={sentinelRef} className="ah-sentinel" aria-hidden="true" />
        {sortedRankings.length > visibleCount && (
          <div style={{ padding: '10px 16px', borderTop: '1px solid #374151', textAlign: 'center' }}>
            <button
              onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
              style={{
                padding: '7px 18px',
                background: '#1f2937',
                border: '1px solid #374151',
                borderRadius: '6px',
                color: '#9ca3af',
                fontSize: '12px',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Show more ({(sortedRankings.length - visibleCount).toLocaleString()} remaining)
            </button>
          </div>
        )}
        {sortedRankings.length > visibleCount && (
          <div
            aria-live="polite"
            style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}
          >
            Menampilkan {visibleCount} dari {sortedRankings.length} aset
          </div>
        )}
      </div>
      )}
    </div>
  );
}

const thStyle: React.CSSProperties = {
  padding: '8px 10px',
  textAlign: 'left',
  fontSize: '9px',
  fontWeight: '700',
  color: '#6b7280',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
};

const tdStyle: React.CSSProperties = {
  padding: '8px 10px',
  color: '#9ca3af',
  fontSize: '11px',
};
