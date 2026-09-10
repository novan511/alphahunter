import React, { useCallback, useEffect, useState } from 'react';
import Layout from '../Layout/Layout';
import { QuantRiskConfig } from '../../lib/quant/types';
import { MarketId, getMarketProfile } from '../../lib/quant/marketProfiles';
import PaperTradingAgent from './PaperTradingAgent';

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  background: '#1f2937',
  border: '1px solid #374151',
  borderRadius: '6px',
  color: '#f9fafb',
  fontSize: '13px',
  outline: 'none',
};

interface RunningParams {
  risk: Partial<QuantRiskConfig>;
  updatedAt: number | null;
  activity?: string;
  running?: boolean;
}

export default function QuantMarketPage({ marketId }: { marketId: MarketId }) {
  const profile = getMarketProfile(marketId);
  const [runningParams, setRunningParams] = useState<RunningParams | null>(null);
  const [loading, setLoading] = useState(false);

  const loadRunning = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/paper?action=status&agentId=${marketId}`);
      const data = await res.json();
      const s = data.state;
      if (s?.risk) {
        setRunningParams({
          risk: s.risk,
          updatedAt: s.updatedAt ?? null,
          activity: s.activity,
          running: Boolean(s.running),
        });
      } else {
        setRunningParams(null);
      }
    } catch {
      setRunningParams(null);
    } finally {
      setLoading(false);
    }
  }, [marketId]);

  useEffect(() => {
    void loadRunning();
  }, [loadRunning]);

  const risk = runningParams?.risk ?? profile.baseRisk;

  return (
    <Layout>
      <div className="qm-page">
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: profile.accent, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>
            Live Desk · {marketId}
          </div>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: '#f9fafb', margin: 0 }}>{profile.title}</h2>
          <p style={{ fontSize: 12, color: '#9ca3af', margin: '6px 0 0' }}>{profile.subtitle}</p>
          <ul style={{ margin: '8px 0 0 18px', padding: 0, fontSize: '11px', color: '#6b7280' }}>
            {profile.behavior.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </div>

        {/* Running params only — discovery lives in Quant Lab */}
        <div style={{
          background: '#111827',
          border: `1px solid ${profile.accent}44`,
          borderRadius: 12,
          padding: 16,
          marginBottom: 16,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: profile.accent, textTransform: 'uppercase' }}>
                Running Parameters
              </div>
              <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                {runningParams?.running
                  ? 'Live paper agent is using these values (updated by meta / lab apply / auto-tune).'
                  : 'Defaults until agent starts. Edit discovery in Quant Lab.'}
                {runningParams?.updatedAt
                  ? ` · updated ${new Date(runningParams.updatedAt).toLocaleTimeString()}`
                  : ''}
              </div>
              {runningParams?.activity && (
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>{runningParams.activity}</div>
              )}
            </div>
            <a
              href="/quant-lab"
              style={{
                padding: '8px 14px',
                borderRadius: 8,
                background: 'rgba(139,92,246,0.15)',
                border: '1px solid rgba(139,92,246,0.4)',
                color: '#c4b5fd',
                fontSize: 12,
                fontWeight: 700,
                textDecoration: 'none',
                alignSelf: 'flex-start',
              }}
            >
              Open Quant Lab →
            </a>
          </div>

          <div className="qm-grid-params">
            {(
              [
                ['riskPerTrade', 'Risk / trade'],
                ['maxConcurrentPositions', 'Max positions'],
                ['maxExposurePct', 'Max exposure'],
                ['maxPortfolioDrawdownPct', 'DD halt'],
                ['minSignalStrength', 'Min signal'],
                ['stopLossATR', 'SL ATR'],
                ['takeProfitATR', 'TP ATR'],
                ['maxHoldBars', 'Max hold'],
                ['interval', 'Interval'],
              ] as const
            ).map(([key, label]) => (
              <div key={key} style={{ background: '#0a0e17', borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase' }}>{label}</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#f9fafb', marginTop: 2 }}>
                  {String(risk[key] ?? '—')}
                </div>
              </div>
            ))}
            <div style={{ background: '#0a0e17', borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase' }}>Allow short</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: risk.allowShort ? '#10b981' : '#f59e0b', marginTop: 2 }}>
                {risk.allowShort ? 'yes' : 'no'}
              </div>
            </div>
            <div style={{ background: '#0a0e17', borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ fontSize: 10, color: '#6b7280', textTransform: 'uppercase' }}>Agent status</div>
              <div style={{ fontSize: 15, fontWeight: 700, color: runningParams?.running ? '#10b981' : '#6b7280', marginTop: 2 }}>
                {loading ? '…' : runningParams?.running ? 'RUNNING' : 'STOPPED'}
              </div>
            </div>
          </div>

          <div style={{ marginTop: 12, fontSize: 11, color: '#6b7280', lineHeight: 1.5 }}>
            Parameter discovery (sweep multi-combo, OOS ranking, promote best) lives in{' '}
            <strong style={{ color: '#c4b5fd' }}>/quant-lab</strong>.
            This desk only shows live paper params + agent controls.
          </div>
        </div>

        <PaperTradingAgent
          risk={profile.baseRisk}
          presetId={profile.defaultPresetId}
          customSymbols=""
          agentId={marketId}
        />
      </div>
    </Layout>
  );
}
