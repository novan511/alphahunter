import React from 'react';
import { AssetScanResult } from '../../lib/types';

interface RankingTableProps {
  results: AssetScanResult[];
  onSelectAsset: (symbol: string) => void;
  selectedAsset: string;
}

export default function RankingTable({ results, onSelectAsset, selectedAsset }: RankingTableProps) {
  if (results.length === 0) {
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
        No scan results. Configure parameters and run a scan.
      </div>
    );
  }

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
      }}>
        <h3 style={{ fontSize: '14px', fontWeight: '600', color: '#f9fafb', margin: 0 }}>
          RS Ranking ({results.length} assets)
        </h3>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #374151' }}>
              <th style={thStyle}>#</th>
              <th style={thStyle}>Symbol</th>
              <th style={thStyle}>RS Z-Score</th>
              <th style={thStyle}>RS Mom</th>
              <th style={thStyle}>Asset Ret</th>
              <th style={thStyle}>Idx Ret</th>
              <th style={thStyle}>Vol Ratio</th>
              <th style={thStyle}>Signal</th>
            </tr>
          </thead>
          <tbody>
            {results.map((result) => {
              const isSelected = result.symbol === selectedAsset;
              return (
                <tr
                  key={result.symbol}
                  onClick={() => onSelectAsset(result.symbol)}
                  style={{
                    borderBottom: '1px solid #1f2937',
                    cursor: 'pointer',
                    background: isSelected ? 'rgba(59, 130, 246, 0.1)' : 'transparent',
                    transition: 'background 0.15s',
                  }}
                  onMouseEnter={(e) => {
                    if (!isSelected) e.currentTarget.style.background = 'rgba(59, 130, 246, 0.05)';
                  }}
                  onMouseLeave={(e) => {
                    if (!isSelected) e.currentTarget.style.background = 'transparent';
                  }}
                >
                  <td style={tdStyle}>{result.rank}</td>
                  <td style={{ ...tdStyle, fontWeight: '600', color: '#f9fafb' }}>
                    {result.symbol.replace('USDT', '')}
                  </td>
                  <td style={{ ...tdStyle, color: getZScoreColor(result.currentRSZScore) }}>
                    {result.currentRSZScore.toFixed(2)}
                  </td>
                  <td style={{ ...tdStyle, color: result.rsMomentum > 0 ? '#10b981' : '#ef4444' }}>
                    {result.rsMomentum > 0 ? '+' : ''}{result.rsMomentum.toFixed(4)}
                  </td>
                  <td style={{ ...tdStyle, color: result.assetReturn > 0 ? '#10b981' : '#ef4444' }}>
                    {result.assetReturn > 0 ? '+' : ''}{result.assetReturn.toFixed(2)}%
                  </td>
                  <td style={{ ...tdStyle, color: result.indexReturn > 0 ? '#10b981' : '#ef4444' }}>
                    {result.indexReturn > 0 ? '+' : ''}{result.indexReturn.toFixed(2)}%
                  </td>
                  <td style={{ ...tdStyle, color: '#f59e0b' }}>
                    {result.volumeRatio.toFixed(2)}x
                  </td>
                  <td style={tdStyle}>
                    {result.signal ? (
                      <span style={{
                        padding: '2px 6px',
                        borderRadius: '4px',
                        fontSize: '10px',
                        fontWeight: '700',
                        background: result.signal.type === 'buy' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)',
                        color: result.signal.type === 'buy' ? '#10b981' : '#ef4444',
                      }}>
                        {result.signal.type.toUpperCase()}
                      </span>
                    ) : (
                      <span style={{ color: '#6b7280' }}>—</span>
                    )}
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

function getZScoreColor(z: number): string {
  if (z > 1.5) return '#10b981';
  if (z > 0.5) return '#34d399';
  if (z > -0.5) return '#9ca3af';
  if (z > -1.5) return '#f87171';
  return '#ef4444';
}

const thStyle: React.CSSProperties = {
  padding: '10px 12px',
  textAlign: 'left',
  fontSize: '10px',
  fontWeight: '700',
  color: '#6b7280',
  textTransform: 'uppercase',
  letterSpacing: '0.5px',
};

const tdStyle: React.CSSProperties = {
  padding: '10px 12px',
  color: '#9ca3af',
  fontSize: '12px',
};