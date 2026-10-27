import React from 'react';

/** sparkline SVG ringan (tanpa dependency) — ala alpha arena equity curve */
export default function Sparkline({
  points,
  width = 160,
  height = 36,
  color,
}: {
  points: number[];
  width?: number;
  height?: number;
  color?: string;
}) {
  if (!points || points.length < 2) {
    return <div style={{ width, height, display: 'flex', alignItems: 'center', color: '#374151', fontSize: 9 }}>Belum ada data</div>;
  }
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = width / (points.length - 1);
  const y = (v: number) => height - 3 - ((v - min) / span) * (height - 6);
  const path = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const up = points[points.length - 1] >= points[0];
  const stroke = color || (up ? '#10b981' : '#ef4444');
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <path d={path} fill="none" stroke={stroke} strokeWidth={1.6} strokeLinejoin="round" />
      <circle cx={(points.length - 1) * step} cy={y(points[points.length - 1])} r={2} fill={stroke} />
    </svg>
  );
}
