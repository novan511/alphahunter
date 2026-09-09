import React from 'react';
import { AssetScanResult } from '../../lib/types';

interface SignalListProps {
  results: AssetScanResult[];
}

export default function SignalList({ results }: SignalListProps) {
  const withSignals = results.filter((r) => r.signal !== null);
  const buySignals = withSignals.filter((r) => r.signal?.type === 'buy');
  const sellSignals = withSignals.filter((r) => r.signal?.type === 'sell');

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
          Active Signals
        </h3>
        <div style={{ display: 'flex', gap: '12px', fontSize: '11px' }}>
          <span style={{ color: '#10b981' }}>{buySignals.length} BUY</span>
          <span style={{ color: '#ef4444' }}>{sellSignals.length} SELL</span>
        </div>
      </div>

      {withSignals.length === 0 ? (
        <div style={{ padding: '32px', textAlign: 'center', color: '#6b7280', fontSize: '13px' }}>
          No active signals. Run a scan to detect decoupling.
        </div>
      ) : (
        <div style={{ maxHeight: '400px', overflowY: 'auto' }}>
          {withSignals.map((result) => {
            const signal = result.signal!;
            const isBuy = signal.type === 'buy';
            return (
              <div
                key={result.symbol}
                style={{
                  padding: '12px 16px',
                  borderBottom: '1px solid #1f2937',
                  background: isBuy ? 'rgba(16, 185, 129, 0.05)' : 'rgba(239, 68, 68, 0.05)',
                  borderLeft: `3px solid ${isBuy ? '#10b981' : '#ef4444'}`,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{
                      padding: '2px 6px',
                      borderRadius: '4px',
                      fontSize: '10px',
                      fontWeight: '700',
                      background: isBuy ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)',
                      color: isBuy ? '#10b981' : '#ef4444',
                    }}>
                      {isBuy ? 'BUY' : 'SELL'}
                    </span>
                    <span style={{ fontWeight: '600', color: '#f9fafb', fontSize: '13px' }}>
                      {result.symbol.replace('USDT', '')}
                    </span>
                    <span style={{ fontSize: '11px', color: '#6b7280' }}>/USDT</span>
                  </div>
                  <span style={{ fontSize: '12px', color: '#9ca3af' }}>
                    ${signal.price.toFixed(4)}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: '16px', fontSize: '11px', color: '#9ca3af' }}>
                  <span>RS Z: <strong style={{ color: signal.rsZScore > 0 ? '#10b981' : '#ef4444' }}>{signal.rsZScore.toFixed(2)}</strong></span>
                  <span>Idx: <strong style={{ color: '#ef4444' }}>{signal.indexReturn.toFixed(2)}%</strong></span>
                  <span>Asset: <strong style={{ color: '#10b981' }}>{signal.assetReturn.toFixed(2)}%</strong></span>
                  <span>Vol: <strong style={{ color: '#f59e0b' }}>{signal.volumeRatio.toFixed(1)}x</strong></span>
                  <span>Str: <strong style={{ color: '#3b82f6' }}>{signal.strength.toFixed(1)}</strong></span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}