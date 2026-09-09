import React from 'react';
import { RegimeResult } from '../../lib/algorithms/marketRegime';
import { AutonomousParams } from '../../lib/algorithms/autonomousParams';
import StatsCard from './StatsCard';

interface RegimeIndicatorProps {
  regime: RegimeResult;
  params: AutonomousParams;
}

const REGIME_COLORS: Record<string, string> = {
  strong_trend_up: '#10b981',
  weak_trend_up: '#34d399',
  ranging: '#f59e0b',
  weak_trend_down: '#f87171',
  strong_trend_down: '#ef4444',
  volatile: '#8b5cf6',
};

const REGIME_LABELS: Record<string, string> = {
  strong_trend_up: 'Strong Uptrend',
  weak_trend_up: 'Weak Uptrend',
  ranging: 'Ranging Market',
  weak_trend_down: 'Weak Downtrend',
  strong_trend_down: 'Strong Downtrend',
  volatile: 'High Volatility',
};

export default function RegimeIndicator({ regime, params }: RegimeIndicatorProps) {
  const color = REGIME_COLORS[regime.regime] || '#9ca3af';
  const label = REGIME_LABELS[regime.regime] || regime.regime;

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
          Market Regime
        </h3>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}>
          <div style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            background: color,
            boxShadow: `0 0 8px ${color}`,
          }} />
          <span style={{ fontSize: '11px', color: '#6b7280', fontWeight: '600' }}>
            AUTO PARAMS
          </span>
        </div>
      </div>

      <div style={{ padding: '16px' }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          marginBottom: '16px',
          padding: '12px',
          background: `${color}10`,
          borderRadius: '8px',
          border: `1px solid ${color}30`,
        }}>
          <div style={{
            width: '48px',
            height: '48px',
            borderRadius: '10px',
            background: `${color}20`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '20px',
            fontWeight: '700',
            color: color,
          }}>
            {regime.adxValue.toFixed(0)}
          </div>
          <div>
            <div style={{ fontSize: '16px', fontWeight: '700', color }}>
              {label}
            </div>
            <div style={{ fontSize: '11px', color: '#9ca3af' }}>
              ADX: {regime.adxValue} | Confidence: {regime.confidence}%
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', marginBottom: '12px' }}>
          <StatsCard label="Vol Percentile" value={`${regime.volatilityPercentile}%`} color={
            regime.volatilityPercentile > 75 ? '#ef4444' : regime.volatilityPercentile < 25 ? '#10b981' : '#f59e0b'
          } />
          <StatsCard label="ATR %" value={`${regime.atrPercent}%`} />
          <StatsCard label="Trend Str" value={`${regime.trendStrength.toFixed(1)}`} color={
            regime.trendStrength > 3 ? '#10b981' : '#9ca3af'
          } />
          <StatsCard label="Confidence" value={`${regime.confidence}%`} color={color} />
        </div>

        <div style={{
          padding: '10px 12px',
          background: '#0a0e17',
          borderRadius: '8px',
          border: '1px solid #374151',
        }}>
          <div style={{ fontSize: '10px', color: '#6b7280', fontWeight: '600', textTransform: 'uppercase', marginBottom: '8px' }}>
            Autonomous Parameters
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', fontSize: '12px' }}>
            <div>
              <span style={{ color: '#6b7280' }}>Threshold: </span>
              <span style={{ color: '#f9fafb', fontWeight: '600' }}>{(params.indexThreshold * 100).toFixed(1)}%</span>
            </div>
            <div>
              <span style={{ color: '#6b7280' }}>Volume ×: </span>
              <span style={{ color: '#f9fafb', fontWeight: '600' }}>{params.volumeMultiplier}x</span>
            </div>
            <div>
              <span style={{ color: '#6b7280' }}>Lookback: </span>
              <span style={{ color: '#f9fafb', fontWeight: '600' }}>{params.lookback}</span>
            </div>
            <div>
              <span style={{ color: '#6b7280' }}>RS Period: </span>
              <span style={{ color: '#f9fafb', fontWeight: '600' }}>{params.rsPeriod}</span>
            </div>
            <div>
              <span style={{ color: '#6b7280' }}>Vol Period: </span>
              <span style={{ color: '#f9fafb', fontWeight: '600' }}>{params.volumePeriod}</span>
            </div>
            <div>
              <span style={{ color: '#6b7280' }}>Score: </span>
              <span style={{ color: '#3b82f6', fontWeight: '600' }}>{params.confidence}</span>
            </div>
          </div>
        </div>

        <div style={{
          marginTop: '8px',
          fontSize: '10px',
          color: '#6b7280',
          fontStyle: 'italic',
        }}>
          {params.reason}
        </div>
      </div>
    </div>
  );
}