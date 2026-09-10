import React, { useMemo, useState } from 'react';
import { MultiTimeframeResult } from '../../lib/algorithms/multiTimeframe';

interface AutonomousRankingProps {
  rankings: MultiTimeframeResult[];
  onSelectAsset: (symbol: string) => void;
  selectedAsset: string;
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
type SortKey = 'signal' | 'conf' | 'rsz';
type SortState = Partial<Record<SortKey, SortDir>>;

const SORT_PRIORITY: SortKey[] = ['signal', 'conf', 'rsz'];

function nextSortDir(prev: SortDir | undefined): SortDir | undefined {
  if (prev === undefined) return 'desc';
  if (prev === 'desc') return 'asc';
  return undefined;
}

export default function AutonomousRanking({ rankings, onSelectAsset, selectedAsset }: AutonomousRankingProps) {
  const [sort, setSort] = useState<SortState>({});

  const sortedRankings = useMemo(() => {
    const active = SORT_PRIORITY.filter((key) => sort[key]).map((key) => ({ key, dir: sort[key]! }));
    if (active.length === 0) return rankings;

    const getSignal = (r: MultiTimeframeResult) => SIGNAL_RANK[r.finalSignal] ?? 0;
    const getConf = (r: MultiTimeframeResult) => r.confluenceScore;
    const getRsz = (r: MultiTimeframeResult) => r.timeframes[1]?.rsZScore ?? 0;

    return [...rankings].sort((a, b) => {
      for (const { key, dir } of active) {
        const mul = dir === 'desc' ? 1 : -1;
        let diff = 0;
        if (key === 'signal') diff = (getSignal(a) - getSignal(b)) * mul;
        if (key === 'conf') diff = (getConf(a) - getConf(b)) * mul;
        if (key === 'rsz') diff = (getRsz(a) - getRsz(b)) * mul;
        if (diff !== 0) return diff;
      }
      return getSignal(b) - getSignal(a);
    });
  }, [rankings, sort]);

  if (rankings.length === 0) {
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

  const signalsFound = rankings.filter((r) => r.finalSignal !== 'neutral').length;

  const toggleSort = (key: SortKey) => {
    setSort((prev) => {
      const next: SortState = { ...prev };
      const dir = nextSortDir(prev[key]);
      if (dir) next[key] = dir;
      else delete next[key];
      return next;
    });
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
      title={`Click to sort by ${label} (best → worst → reverse → default). Multiple columns combine.`}
    >
      {label}{sortLabel(key)}
    </th>
  );

  return (
    <div style={{
      background: '#111827',
      borderRadius: '12px',
      border: '1px solid #374151',
      overflow: 'hidden',
    }}>
      <div style={{
        padding: '12px 16px',
        borderBottom: '1px solid #374151',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}>
        <h3 style={{ fontSize: '14px', fontWeight: '600', color: '#f9fafb', margin: 0 }}>
          Autonomous Rankings ({rankings.length} assets)
        </h3>
        <div style={{ fontSize: '11px', color: '#6b7280' }}>
          <span style={{ color: '#10b981', fontWeight: '600' }}>{signalsFound}</span> signals
        </div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #374151' }}>
              <th style={thStyle}>#</th>
              <th style={thStyle}>Asset</th>
              <th style={thStyle}>1h</th>
              <th style={thStyle}>4h</th>
              <th style={thStyle}>1d</th>
              {sortableTh('rsz', 'RS Z')}
              {sortableTh('conf', 'Conf%')}
              {sortableTh('signal', 'Signal')}
            </tr>
          </thead>
          <tbody>
            {sortedRankings.map((result) => {
              const originalIndex = rankings.findIndex((r) => r.asset === result.asset);
              const isSelected = result.asset === selectedAsset;
              const signalColor = SIGNAL_COLORS[result.finalSignal] || '#6b7280';
              return (
                <tr
                  key={result.asset}
                  onClick={() => onSelectAsset(result.asset)}
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
                  <td style={tdStyle}>{originalIndex >= 0 ? originalIndex + 1 : '—'}</td>
                  <td style={{ ...tdStyle, fontWeight: '600', color: '#f9fafb' }}>
                    {result.asset.replace('USDT', '')}
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
                  <td style={{ ...tdStyle, color: result.timeframes[1]?.rsZScore > 0 ? '#10b981' : '#ef4444' }}>
                    {result.timeframes[1]?.rsZScore.toFixed(2) || '—'}
                  </td>
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
                      <span>{result.confluenceScore}%</span>
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
                    }}>
                      {result.finalSignal.replace('_', ' ').toUpperCase()}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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
