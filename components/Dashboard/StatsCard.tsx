import React from 'react';

interface StatsCardProps {
  label: string;
  value: string | number;
  subtext?: string;
  color?: string;
  icon?: string;
}

export default function StatsCard({ label, value, subtext, color = '#f9fafb', icon }: StatsCardProps) {
  return (
    <div className="stat-card" style={{
      background: '#111827',
      borderRadius: '12px',
      border: '1px solid #374151',
      padding: '16px',
      minWidth: '140px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
        {icon && <span style={{ fontSize: '14px' }}>{icon}</span>}
        <span style={{ fontSize: '11px', color: '#6b7280', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          {label}
        </span>
      </div>
      <div style={{ fontSize: '22px', fontWeight: '700', color, lineHeight: '1.2' }}>
        {value}
      </div>
      {subtext && (
        <div style={{ fontSize: '11px', color: '#6b7280', marginTop: '4px' }}>
          {subtext}
        </div>
      )}
    </div>
  );
}