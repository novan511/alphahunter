import React from 'react';
import { ScanConfig, Interval } from '../../lib/types';
import { AVAILABLE_INTERVALS, TOP_CRYPTO_SYMBOLS } from '../../lib/config';

interface ParameterPanelProps {
  config: ScanConfig;
  onChange: (config: ScanConfig) => void;
  onScan: () => void;
  loading: boolean;
}

export default function ParameterPanel({ config, onChange, onScan, loading }: ParameterPanelProps) {
  const updateConfig = (key: keyof ScanConfig, value: any) => {
    onChange({ ...config, [key]: value });
  };

  const toggleAsset = (symbol: string) => {
    const current = config.assetSymbols;
    if (current.includes(symbol)) {
      updateConfig('assetSymbols', current.filter((s) => s !== symbol));
    } else {
      updateConfig('assetSymbols', [...current, symbol]);
    }
  };

  const selectAll = () => updateConfig('assetSymbols', [...TOP_CRYPTO_SYMBOLS]);
  const selectNone = () => updateConfig('assetSymbols', []);

  return (
    <div style={{
      background: '#111827',
      borderRadius: '12px',
      border: '1px solid #374151',
      padding: '16px',
    }}>
      <h3 style={{ fontSize: '14px', fontWeight: '600', color: '#f9fafb', marginBottom: '16px' }}>
        Scan Parameters
      </h3>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '12px', marginBottom: '16px' }}>
        <div>
          <label style={{ display: 'block', fontSize: '11px', color: '#9ca3af', marginBottom: '4px', fontWeight: '600' }}>
            Index Symbol
          </label>
          <input
            type="text"
            value={config.indexSymbol}
            onChange={(e) => updateConfig('indexSymbol', e.target.value.toUpperCase())}
            style={{
              width: '100%',
              padding: '8px 10px',
              background: '#1f2937',
              border: '1px solid #374151',
              borderRadius: '6px',
              color: '#f9fafb',
              fontSize: '13px',
              outline: 'none',
            }}
          />
        </div>

        <div>
          <label style={{ display: 'block', fontSize: '11px', color: '#9ca3af', marginBottom: '4px', fontWeight: '600' }}>
            Timeframe
          </label>
          <select
            value={config.interval}
            onChange={(e) => updateConfig('interval', e.target.value)}
            style={{
              width: '100%',
              padding: '8px 10px',
              background: '#1f2937',
              border: '1px solid #374151',
              borderRadius: '6px',
              color: '#f9fafb',
              fontSize: '13px',
              outline: 'none',
            }}
          >
            {AVAILABLE_INTERVALS.map((iv) => (
              <option key={iv.value} value={iv.value}>{iv.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label style={{ display: 'block', fontSize: '11px', color: '#9ca3af', marginBottom: '4px', fontWeight: '600' }}>
            Return Lookback
          </label>
          <input
            type="number"
            value={config.lookback}
            onChange={(e) => updateConfig('lookback', parseInt(e.target.value) || 6)}
            min={1}
            max={24}
            style={{
              width: '100%',
              padding: '8px 10px',
              background: '#1f2937',
              border: '1px solid #374151',
              borderRadius: '6px',
              color: '#f9fafb',
              fontSize: '13px',
              outline: 'none',
            }}
          />
        </div>

        <div>
          <label style={{ display: 'block', fontSize: '11px', color: '#9ca3af', marginBottom: '4px', fontWeight: '600' }}>
            RS Period
          </label>
          <input
            type="number"
            value={config.rsPeriod}
            onChange={(e) => updateConfig('rsPeriod', parseInt(e.target.value) || 20)}
            min={5}
            max={100}
            style={{
              width: '100%',
              padding: '8px 10px',
              background: '#1f2937',
              border: '1px solid #374151',
              borderRadius: '6px',
              color: '#f9fafb',
              fontSize: '13px',
              outline: 'none',
            }}
          />
        </div>

        <div>
          <label style={{ display: 'block', fontSize: '11px', color: '#9ca3af', marginBottom: '4px', fontWeight: '600' }}>
            Index Threshold (%)
          </label>
          <input
            type="number"
            value={(config.indexThreshold * 100).toFixed(1)}
            onChange={(e) => updateConfig('indexThreshold', parseFloat(e.target.value) / 100 || 0.02)}
            step={0.5}
            min={0.5}
            max={10}
            style={{
              width: '100%',
              padding: '8px 10px',
              background: '#1f2937',
              border: '1px solid #374151',
              borderRadius: '6px',
              color: '#f9fafb',
              fontSize: '13px',
              outline: 'none',
            }}
          />
        </div>

        <div>
          <label style={{ display: 'block', fontSize: '11px', color: '#9ca3af', marginBottom: '4px', fontWeight: '600' }}>
            Volume Multiplier
          </label>
          <input
            type="number"
            value={config.volumeMultiplier}
            onChange={(e) => updateConfig('volumeMultiplier', parseFloat(e.target.value) || 1.5)}
            step={0.1}
            min={1}
            max={5}
            style={{
              width: '100%',
              padding: '8px 10px',
              background: '#1f2937',
              border: '1px solid #374151',
              borderRadius: '6px',
              color: '#f9fafb',
              fontSize: '13px',
              outline: 'none',
            }}
          />
        </div>

        <div>
          <label style={{ display: 'block', fontSize: '11px', color: '#9ca3af', marginBottom: '4px', fontWeight: '600' }}>
            Volume Period
          </label>
          <input
            type="number"
            value={config.volumePeriod}
            onChange={(e) => updateConfig('volumePeriod', parseInt(e.target.value) || 20)}
            min={5}
            max={100}
            style={{
              width: '100%',
              padding: '8px 10px',
              background: '#1f2937',
              border: '1px solid #374151',
              borderRadius: '6px',
              color: '#f9fafb',
              fontSize: '13px',
              outline: 'none',
            }}
          />
        </div>
      </div>

      <div style={{ marginBottom: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
          <label style={{ fontSize: '11px', color: '#9ca3af', fontWeight: '600' }}>
            Assets to Scan ({config.assetSymbols.length} selected)
          </label>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={selectAll} style={{
              padding: '2px 8px', background: '#374151', border: 'none', borderRadius: '4px',
              color: '#9ca3af', fontSize: '10px', cursor: 'pointer',
            }}>All</button>
            <button onClick={selectNone} style={{
              padding: '2px 8px', background: '#374151', border: 'none', borderRadius: '4px',
              color: '#9ca3af', fontSize: '10px', cursor: 'pointer',
            }}>None</button>
          </div>
        </div>
        <div style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '6px',
          maxHeight: '120px',
          overflowY: 'auto',
          padding: '8px',
          background: '#0a0e17',
          borderRadius: '8px',
          border: '1px solid #374151',
        }}>
          {TOP_CRYPTO_SYMBOLS.map((symbol) => {
            const isSelected = config.assetSymbols.includes(symbol);
            return (
              <button
                key={symbol}
                onClick={() => toggleAsset(symbol)}
                style={{
                  padding: '4px 8px',
                  background: isSelected ? 'rgba(59, 130, 246, 0.2)' : '#1f2937',
                  border: `1px solid ${isSelected ? '#3b82f6' : '#374151'}`,
                  borderRadius: '4px',
                  color: isSelected ? '#3b82f6' : '#6b7280',
                  fontSize: '10px',
                  cursor: 'pointer',
                  fontWeight: isSelected ? '600' : '400',
                }}
              >
                {symbol.replace('USDT', '')}
              </button>
            );
          })}
        </div>
      </div>

      <button
        onClick={onScan}
        disabled={loading || config.assetSymbols.length === 0}
        style={{
          width: '100%',
          padding: '10px',
          background: loading ? '#374151' : 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
          border: 'none',
          borderRadius: '8px',
          color: 'white',
          fontSize: '13px',
          fontWeight: '600',
          cursor: loading ? 'not-allowed' : 'pointer',
          opacity: loading || config.assetSymbols.length === 0 ? 0.6 : 1,
          transition: 'opacity 0.2s',
        }}
      >
        {loading ? 'Scanning...' : `Scan ${config.assetSymbols.length} Assets`}
      </button>
    </div>
  );
}