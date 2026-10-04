import React from 'react';

interface SkeletonProps {
  /** CSS width, e.g. '60%' or '120px'. */
  width?: string;
  height?: string;
  radius?: string;
}

/**
 * A single shimmering placeholder block. `role="presentation"` because it is
 * purely decorative — the surrounding region carries the aria-busy state.
 */
export function Skeleton({ width = '100%', height = '12px', radius = '6px' }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className="ah-skel"
      style={{ display: 'block', width, height, borderRadius: radius }}
    />
  );
}

/**
 * Placeholder that mirrors the shape of the panel it replaces, so content
 * does not jump when the real data lands.
 */
export function SkeletonPanel({ rows = 6 }: { rows?: number }) {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      style={{
        background: '#111827',
        borderRadius: '12px',
        border: '1px solid #374151',
        padding: '16px',
      }}
    >
      <Skeleton width="180px" height="14px" />
      <div style={{ marginTop: '14px', display: 'grid', gap: '10px' }}>
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            <Skeleton width="34px" height="11px" />
            <Skeleton width={`${58 + ((i * 13) % 30)}%`} height="11px" />
            <Skeleton width="52px" height="11px" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Compact stats-row placeholder matching the 4-up StatsCard grid. */
export function SkeletonStats({ count = 5 }: { count?: number }) {
  return (
    <div
      aria-busy="true"
      className="ah-stats"
      style={{ marginBottom: '20px' }}
    >
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          style={{
            background: '#111827',
            borderRadius: '12px',
            border: '1px solid #374151',
            padding: '14px 16px',
            minHeight: '74px',
          }}
        >
          <Skeleton width="72px" height="9px" />
          <div style={{ height: '8px' }} />
          <Skeleton width="96px" height="20px" />
        </div>
      ))}
    </div>
  );
}
