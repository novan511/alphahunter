import React from 'react';
import { BacktestResult } from '../../lib/types';
import StatsCard from './StatsCard';

interface BacktestResultsProps {
  result: BacktestResult | null;
  loading: boolean;
}

export default function BacktestResults({ result, loading }: BacktestResultsProps) {
  if (loading) {
    return (
      <div style={{
        background: '#111827',
        borderRadius: '12px',
        border: '1px solid #374151',
        padding: '32px',
        textAlign: 'center',
        color: '#6b7280',
      }}>
        Running backtest...
      </div>
    );
  }

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
        Select an asset and run backtest to see results.
      </div>
    );
  }

  const isProfitable = result.totalPnL > 0;

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
          Backtest Results
        </h3>
        <span style={{
          padding: '3px 8px',
          borderRadius: '4px',
          fontSize: '11px',
          fontWeight: '700',
          background: isProfitable ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)',
          color: isProfitable ? '#10b981' : '#ef4444',
        }}>
          {isProfitable ? 'PROFITABLE' : 'LOSING'}
        </span>
      </div>

      <div style={{ padding: '16px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '10px', marginBottom: '16px' }}>
          <StatsCard
            label="Total P&L"
            value={`${result.totalPnLPercent >= 0 ? '+' : ''}${result.totalPnLPercent}%`}
            color={isProfitable ? '#10b981' : '#ef4444'}
          />
          <StatsCard
            label="Win Rate"
            value={`${result.winRate}%`}
            subtext={`${result.winningTrades}W / ${result.losingTrades}L`}
            color={result.winRate >= 50 ? '#10b981' : '#ef4444'}
          />
          <StatsCard
            label="Profit Factor"
            value={result.profitFactor === Infinity ? '∞' : result.profitFactor.toFixed(2)}
            color={result.profitFactor >= 1.5 ? '#10b981' : result.profitFactor >= 1 ? '#f59e0b' : '#ef4444'}
          />
          <StatsCard
            label="Sharpe Ratio"
            value={result.sharpeRatio.toFixed(2)}
            color={result.sharpeRatio >= 1 ? '#10b981' : result.sharpeRatio >= 0 ? '#f59e0b' : '#ef4444'}
          />
          <StatsCard
            label="Max Drawdown"
            value={`${result.maxDrawdownPercent}%`}
            color="#ef4444"
          />
          <StatsCard
            label="Sortino Ratio"
            value={result.sortinoRatio.toFixed(2)}
            color={result.sortinoRatio >= 1 ? '#10b981' : '#f59e0b'}
          />
          <StatsCard
            label="Avg Win"
            value={`${result.avgWin >= 0 ? '+' : ''}${result.avgWin}%`}
            color="#10b981"
          />
          <StatsCard
            label="Avg Loss"
            value={`${result.avgLoss}%`}
            color="#ef4444"
          />
          <StatsCard
            label="Total Trades"
            value={result.totalTrades}
            subtext={`Avg hold: ${result.avgHoldBars} bars`}
          />
          <StatsCard
            label="Buy & Hold"
            value={`${result.buyHoldReturn >= 0 ? '+' : ''}${result.buyHoldReturn}%`}
            color={result.buyHoldReturn >= 0 ? '#10b981' : '#ef4444'}
          />
          <StatsCard
            label="Alpha"
            value={`${result.alpha >= 0 ? '+' : ''}${result.alpha}%`}
            color={result.alpha >= 0 ? '#10b981' : '#ef4444'}
          />
        </div>

        {result.trades.length > 0 && (
          <div>
            <h4 style={{ fontSize: '12px', fontWeight: '600', color: '#9ca3af', marginBottom: '8px' }}>
              Recent Trades
            </h4>
            <div style={{ maxHeight: '250px', overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #374151' }}>
                    <th style={thStyle}>Side</th>
                    <th style={thStyle}>Entry</th>
                    <th style={thStyle}>Exit</th>
                    <th style={thStyle}>Entry $</th>
                    <th style={thStyle}>Exit $</th>
                    <th style={thStyle}>P&L %</th>
                    <th style={thStyle}>Exit Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {result.trades.slice(-20).reverse().map((trade, idx) => (
                    <tr key={idx} style={{ borderBottom: '1px solid #1f2937' }}>
                      <td style={{ ...tdStyle, color: trade.side === 'long' ? '#10b981' : '#ef4444', fontWeight: '600' }}>
                        {trade.side.toUpperCase()}
                      </td>
                      <td style={tdStyle}>{formatTime(trade.entryTime)}</td>
                      <td style={tdStyle}>{formatTime(trade.exitTime)}</td>
                      <td style={tdStyle}>${trade.entryPrice.toFixed(4)}</td>
                      <td style={tdStyle}>${trade.exitPrice.toFixed(4)}</td>
                      <td style={{ ...tdStyle, color: trade.pnlPercent > 0 ? '#10b981' : '#ef4444', fontWeight: '600' }}>
                        {trade.pnlPercent > 0 ? '+' : ''}{trade.pnlPercent.toFixed(2)}%
                      </td>
                      <td style={{ ...tdStyle, color: '#6b7280' }}>
                        {trade.exitReason.replace('_', ' ').toUpperCase()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const thStyle: React.CSSProperties = {
  padding: '8px 10px',
  textAlign: 'left',
  fontSize: '10px',
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