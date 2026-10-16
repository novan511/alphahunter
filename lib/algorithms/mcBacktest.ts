import { Candle, ScanConfig } from '../types';
import { fetchKlinesRouted } from '../universe';
import { maxDrawdown } from './indicators';
import {
  analyzeMultiTimeframe,
  defaultScoringParams,
  ScoringParams,
} from './multiTimeframe';

/**
 * Permintaan Monte Carlo: uji efektivitas setiap kemungkinan parameter
 * rumus konfluensi terhadap data historis.
 *
 * Cara kerja: untuk setiap kombinasi parameter, mundur ke belakang hingga
 * `bars` candle pada interval yang dipilih. Di setiap bar, skor dihitung
 * hanya dari data hingga bar itu (tanpa lookahead). Jika sinyal buy/sell
 * nyala, return ke depan `forwardBars` dicatat. Hasilnya dirank menurun
 * menurut `edge` (win rate × return rata-rata per sinyal) — parameter
 * yang konsisten menghasilkan return positif ke depan = paling efektif.
 */
export interface MonteCarloRequest {
  assetSymbol: string;
  indexSymbol?: string;
  interval?: '1h' | '4h' | '1d';
  bars?: number;        // candle ke belakang (default 300, maks 600)
  forwardBars?: number; // return diukur ke depan berapa bar (default 5)
  grid?: ScoringParams[]; // parameter yang diuji; default = sensitivity sweep
}

export interface MonteCarloSignal {
  time: number;
  side: 'buy' | 'sell';
  entryPrice: number;
  exitPrice: number;
  fwdReturn: number;   // return ke depan (short = terbalik)
  confluenceScore: number;
}

export interface MonteCarloCombo {
  params: ScoringParams;
  label: string;
  signals: MonteCarloSignal[];
  signalCount: number;
  winRate: number;
  avgFwdReturn: number;
  medianFwdReturn: number;
  profitFactor: number;
  expectancy: number;
  edge: number;
  maxDD: number;
  equity: Array<{ time: number; equity: number }>;
}

export interface MonteCarloResult {
  combos: MonteCarloCombo[];
  best: MonteCarloCombo | null;
}

/** Sensitivity sweep default: satu parameter diubah sekeliling nilai default. */
function defaultGrid(): ScoringParams[] {
  const base = defaultScoringParams;
  const grid: ScoringParams[] = [base];
  const vary = (partial: Partial<ScoringParams>): ScoringParams => ({ ...base, ...partial });
  grid.push(vary({ zFloor: 0.6 }));
  grid.push(vary({ zFloor: 1.0 }));
  grid.push(vary({ zCeiling: 1.4 }));
  grid.push(vary({ zCeiling: 1.8 }));
  grid.push(vary({ wRS: 0.3, wTrend: 0.35, wSignal: 0.35 }));
  grid.push(vary({ wRS: 0.5, wTrend: 0.3, wSignal: 0.2 }));
  grid.push(vary({ strongScore: 60 }));
  grid.push(vary({ strongScore: 84 }));
  grid.push(vary({ buyScore: 40 }));
  grid.push(vary({ buyScore: 56 }));
  grid.push(vary({ minConviction: 0.3 }));
  grid.push(vary({ minConviction: 0.4 }));
  grid.push(vary({ strongConviction: 0.5 }));
  grid.push(vary({ strongConviction: 0.6 }));
  grid.push(vary({ strongAgreement: 0.5 }));
  grid.push(vary({ strongAgreement: 0.7 }));
  grid.push(vary({ convictionExponent: 0.7 }));
  grid.push(vary({ convictionExponent: 1.0 }));
  grid.push(vary({ trendSaturation: 0.2 }));
  grid.push(vary({ trendSaturation: 0.35 }));
  return grid;
}

function labelFor(params: ScoringParams): string {
  const base = defaultScoringParams;
  const keys: (keyof ScoringParams)[] = [
    'zFloor', 'zCeiling', 'wRS', 'wTrend', 'wSignal',
    'strongScore', 'buyScore', 'minConviction', 'strongConviction',
    'strongAgreement', 'buyAgreement', 'convictionExponent', 'trendSaturation',
  ];
  const changes = keys.filter((k) => params[k] !== base[k]);
  return changes.length ? changes.map((k) => `${k}=${params[k]}`).join(', ') : 'default (nilai Ranking)';
}

function summarize(params: ScoringParams, signals: MonteCarloSignal[]): MonteCarloCombo {
  const signalCount = signals.length;
  const wins = signals.filter((s) => s.fwdReturn > 0);
  const losses = signals.filter((s) => s.fwdReturn <= 0);
  const winRate = signalCount ? wins.length / signalCount : 0;
  const avgFwdReturn =
    signalCount ? signals.reduce((a, s) => a + s.fwdReturn, 0) / signalCount : 0;
  const sorted = [...signals].map((s) => s.fwdReturn).sort((a, b) => a - b);
  const medianFwdReturn = sorted.length
    ? sorted.length % 2
      ? sorted[sorted.length >> 1]
      : (sorted[(sorted.length >> 1) - 1] + sorted[sorted.length >> 1]) / 2
    : 0;
  const grossProfit = wins.reduce((a, s) => a + s.fwdReturn, 0);
  const grossLoss = Math.abs(losses.reduce((a, s) => a + s.fwdReturn, 0));
  const profitFactor =
    grossLoss === 0 ? (grossProfit > 0 ? Infinity : 0) : grossProfit / grossLoss;
  const equity = equityCurve(signals);
  const { maxDD } = maxDrawdown(equity.map((e) => e.equity));
  const edge = winRate * avgFwdReturn;

  return {
    params,
    label: labelFor(params),
    signals,
    signalCount,
    winRate: Math.round(winRate * 10000) / 100,
    avgFwdReturn: Math.round(avgFwdReturn * 10000) / 100,
    medianFwdReturn: Math.round(medianFwdReturn * 10000) / 100,
    profitFactor: Number.isFinite(profitFactor) ? Math.round(profitFactor * 100) / 100 : 0,
    expectancy: Math.round(avgFwdReturn * 10000) / 100,
    edge: Math.round(edge * 10000) / 100,
    maxDD: Math.round(maxDD * 100) / 100,
    equity,
  };
}

function equityCurve(signals: MonteCarloSignal[]): Array<{ time: number; equity: number }> {
  let eq = 1;
  const out: Array<{ time: number; equity: number }> = [];
  for (const s of signals) {
    eq *= 1 + s.fwdReturn;
    out.push({ time: s.time, equity: eq });
  }
  return out;
}

export async function runMonteCarlo(
  req: MonteCarloRequest
): Promise<MonteCarloResult> {
  const assetSymbol = (req.assetSymbol || '').toUpperCase();
  const indexSymbol = (req.indexSymbol || 'BTCUSDT').toUpperCase();
  const interval = req.interval || '1d';
  const bars = Math.min(Math.max(req.bars || 300, 100), 600);
  const forwardBars = Math.max(req.forwardBars || 5, 1);
  const grid = req.grid?.length ? req.grid : defaultGrid();

  const fetchLimit = bars + forwardBars + 80;
  const [assetCandles, indexCandles] = await Promise.all([
    fetchKlinesRouted(assetSymbol, interval, fetchLimit),
    fetchKlinesRouted(indexSymbol, interval, fetchLimit),
  ]);

  const minLen = Math.min(assetCandles.length, indexCandles.length);
  const asset = assetCandles.slice(-minLen);
  const index = indexCandles.slice(-minLen);
  const n = asset.length;

  const warmup = 80; // cukup data untuk indicator (RS z-score, EMA, ATR, sinyal)
  const scanConfig: ScanConfig = {
    indexSymbol,
    assetSymbols: [assetSymbol],
    interval,
    lookback: 6,
    rsPeriod: 20,
    indexThreshold: 0.02,
    volumeMultiplier: 1.5,
    volumePeriod: 20,
  };

  const combos: MonteCarloCombo[] = [];
  for (const params of grid) {
    const signals: MonteCarloSignal[] = [];
    for (let i = warmup; i < n - forwardBars; i++) {
      const timeframeData = {
        [interval]: {
          asset: asset.slice(0, i + 1),
          index: index.slice(0, i + 1),
        },
      };
      const result = analyzeMultiTimeframe(assetSymbol, timeframeData, scanConfig, {
        params,
      });
      const sig = result.finalSignal;
      if (sig === 'neutral') continue;
      const side = sig.includes('buy') ? 'buy' : 'sell';
      const entry = asset[i].close;
      const exit = asset[i + forwardBars].close;
      // Buy = long, Sell = short (return dibalik agar kedua arah comparable)
      const fwdReturn = side === 'buy' ? (exit - entry) / entry : (entry - exit) / entry;
      signals.push({
        time: asset[i].time,
        side,
        entryPrice: entry,
        exitPrice: exit,
        fwdReturn,
        confluenceScore: result.confluenceScore,
      });
    }
    combos.push(summarize(params, signals));
  }

  combos.sort((a, b) => b.edge - a.edge);
  return { combos, best: combos[0] ?? null };
}
