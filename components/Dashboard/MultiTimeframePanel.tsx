import React, { useEffect } from 'react';
import { MultiTimeframeResult } from '../../lib/algorithms/multiTimeframe';
import { useAIExplanation } from '../../lib/useAIExplanation';
import { RegimeResult } from '../../lib/algorithms/marketRegime';

interface MultiTimeframePanelProps {
  result: MultiTimeframeResult | null;
  regime?: RegimeResult | null;
}

const TF_LABELS: Record<string, string> = {
  '1h': '1 Hour',
  '4h': '4 Hour',
  '1d': '1 Day',
};

const SIGNAL_COLORS: Record<string, string> = {
  strong_buy: '#10b981',
  buy: '#34d399',
  strong_sell: '#ef4444',
  sell: '#f87171',
  neutral: '#6b7280',
};

export default function MultiTimeframePanel({ result, regime }: MultiTimeframePanelProps) {
  const { explanation, loading, fetchExplanation } = useAIExplanation();

  useEffect(() => {
    if (result && result.finalSignal !== 'neutral') {
      fetchExplanation(result, regime);
    }
  }, [result, regime, fetchExplanation]);

  if (!result) {
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
        Select an asset to view multi-timeframe analysis.
      </div>
    );
  }

  const signalColor = SIGNAL_COLORS[result.finalSignal] || '#6b7280';

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
          {result.asset.replace('USDT', '')} — Multi-Timeframe
        </h3>
        <span style={{
          padding: '3px 10px',
          borderRadius: '6px',
          fontSize: '11px',
          fontWeight: '700',
          background: `${signalColor}20`,
          color: signalColor,
          border: `1px solid ${signalColor}40`,
        }}>
          {result.finalSignal.replace('_', ' ').toUpperCase()}
        </span>
      </div>

      <div style={{ padding: '16px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px', marginBottom: '16px' }}>
          {result.timeframes.map((tf) => {
            const trendColor = tf.trendDirection === 'bullish' ? '#10b981' : tf.trendDirection === 'bearish' ? '#ef4444' : '#6b7280';
            return (
              <div key={tf.timeframe} style={{
                background: '#0a0e17',
                borderRadius: '8px',
                border: `1px solid ${tf.signal ? trendColor + '30' : '#374151'}`,
                padding: '12px',
              }}>
                <div style={{ fontSize: '10px', color: '#6b7280', fontWeight: '600', textTransform: 'uppercase', marginBottom: '8px' }}>
                  {TF_LABELS[tf.timeframe]}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                  <div style={{
                    width: '24px',
                    height: '24px',
                    borderRadius: '6px',
                    background: `${trendColor}20`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '14px',
                    color: trendColor,
                  }}>
                    {tf.trendDirection === 'bullish' ? '↑' : tf.trendDirection === 'bearish' ? '↓' : '—'}
                  </div>
                  <div>
                    <div style={{ fontSize: '12px', fontWeight: '600', color: trendColor, textTransform: 'capitalize' }}>
                      {tf.trendDirection}
                    </div>
                    <div style={{ fontSize: '10px', color: '#6b7280' }}>
                      RS Z: {tf.rsZScore.toFixed(2)}
                    </div>
                  </div>
                </div>
                {tf.signal ? (
                  <div style={{
                    padding: '6px 8px',
                    background: tf.signal.type === 'buy' ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                    borderRadius: '4px',
                    fontSize: '10px',
                  }}>
                    <div style={{ fontWeight: '700', color: tf.signal.type === 'buy' ? '#10b981' : '#ef4444' }}>
                      {tf.signal.type.toUpperCase()} @ ${tf.signal.price.toFixed(2)}
                    </div>
                    <div style={{ color: '#6b7280', marginTop: '2px' }}>
                      Str: {tf.signal.strength.toFixed(1)} | Vol: {tf.signal.volumeRatio.toFixed(1)}x
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: '10px', color: '#6b7280', padding: '6px 8px' }}>
                    No signal on this TF
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div style={{
          padding: '12px',
          background: `${signalColor}10`,
          borderRadius: '8px',
          border: `1px solid ${signalColor}30`,
          marginBottom: explanation || loading ? '12px' : '0',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: '12px', fontWeight: '600', color: signalColor }}>
                Confluence Score: {result.confluenceScore}%
              </div>
              <div style={{ fontSize: '10px', color: '#6b7280', marginTop: '2px' }}>
                {result.confluenceDirection === 'bullish' ? 'Bullish alignment across timeframes' :
                 result.confluenceDirection === 'bearish' ? 'Bearish alignment across timeframes' :
                 'No clear multi-timeframe alignment'}
              </div>
            </div>
            <div style={{
              width: '48px',
              height: '48px',
              borderRadius: '50%',
              background: `conic-gradient(${signalColor} ${result.confluenceScore * 3.6}deg, #1f2937 0deg)`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <div style={{
                width: '36px',
                height: '36px',
                borderRadius: '50%',
                background: '#111827',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '12px',
                fontWeight: '700',
                color: signalColor,
              }}>
                {result.confluenceScore}
              </div>
            </div>
          </div>
        </div>

        {(explanation || loading) && (
          <div style={{
            padding: '12px 14px',
            background: 'rgba(59, 130, 246, 0.06)',
            borderRadius: '8px',
            border: '1px solid rgba(59, 130, 246, 0.15)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
              <span style={{ fontSize: '12px' }}>✨</span>
              <span style={{ fontSize: '10px', fontWeight: '600', color: '#3b82f6', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                AI Explanation
              </span>
            </div>
            {loading ? (
              <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#3b82f6', animation: 'pulse 1s infinite' }} />
                <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#3b82f6', animation: 'pulse 1s infinite 0.2s' }} />
                <div style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#3b82f6', animation: 'pulse 1s infinite 0.4s' }} />
                <span style={{ fontSize: '11px', color: '#6b7280', marginLeft: '6px' }}>Analysing...</span>
              </div>
            ) : (
              <div style={{ fontSize: '12px', color: '#d1d5db', lineHeight: '1.6' }}>
                {explanation}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}