import React from 'react';
import Layout from '../components/Layout/Layout';
import McLabPanel from '../components/Dashboard/McLabPanel';

export default function BacktestPage() {
  return (
    <Layout>
      <div style={{ padding: '0 24px 40px', maxWidth: '1400px', margin: '0 auto' }}>
        <h2 style={{ fontSize: '18px', fontWeight: '700', color: '#f9fafb', marginBottom: '8px' }}>
          🧪 Backtest Monte Carlo — Otonom Multi-Aset
        </h2>
        <p style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '20px' }}>
          Dijalankan AI secara otonom: satu eksperimen tiap 10 menit, mulai dari aset big cap (crypto,
          komoditas, saham, index), lalu melebar. AI hanya mengusulkan hipotesis; hasil dihitung
          deterministik oleh engine dan dinilai lewat walk-forward out-of-sample + Monte Carlo.
        </p>

        <McLabPanel />
      </div>
    </Layout>
  );
}
