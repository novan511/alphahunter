/**
 * ML Backtest Engine
 * Menjalankan model XGBoost yang sudah dilatih pada data historis,
 * menghasilkan sinyal buy/sell berdasarkan prediksi model + threshold,
 * lalu backtest hasilnya.
 */

import { Candle } from '../types';
import { atr } from '../algorithms/indicators';
import { buildFeatures } from './features';
import { loadModelFromJSON, loadMetaFromJSON, predict } from './inference';
import fs from 'fs';
import path from 'path';

interface MLTrade {
  id: number;
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  side: 'long';
  qty: number;
  pnl: number;
  pnlPercent: number;
  rMultiple: number;
  exitReason: 'tp' | 'sl' | 'time' | 'end';
  barsHeld: number;
  probabilityUp: number;
  regimePass: boolean;
}

interface MLBacktestResult {
  symbol: string;
  interval: string;
  trades: MLTrade[];
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalReturn: number;
  totalReturnPercent: number;
  profitFactor: number;
  maxDrawdownPercent: number;
  expectancyR: number;
  avgBarsHeld: number;
  equityCurve: Array<{ time: number; equity: number }>;
  tradesByMonth: Array<{ month: string; pnl: number; trades: number }>;
}

interface BacktestConfig {
  initialCapital: number;
  riskPerTrade: number;
  stopLossATR: number;
  takeProfitATR: number;
  maxHoldBars: number;
  probThreshold: number;
  regimeFilter: string;
  feeRate: number;
  slippage: number;
}

export async function runMLBacktest(
  symbol: string,
  interval: string,
  assetCandles: Candle[],
  indexCandles: Candle[],
  config: BacktestConfig
): Promise<MLBacktestResult> {
  const modelDir = path.join(process.cwd(), 'public', 'ml', 'models');
  const fileName = `${symbol}_${interval}`;

  let model: any = null;
  let meta: any = null;

  try {
    const modelRaw = fs.readFileSync(path.join(modelDir, `${fileName}.json`), 'utf8');
    model = loadModelFromJSON(JSON.parse(modelRaw));
  } catch {
    // no model file
  }

  try {
    const metaRaw = fs.readFileSync(path.join(modelDir, `${fileName}.meta.json`), 'utf8');
    meta = loadMetaFromJSON(JSON.parse(metaRaw));
  } catch {
    // no meta
  }

  const probThreshold = meta?.prob_threshold ?? config.probThreshold;
  const regimeFilter = meta?.regime_filter ?? config.regimeFilter;

  // Build features
  const fv = buildFeatures(assetCandles, indexCandles);
  if (fv.length === 0) {
    return emptyResult(symbol, interval);
  }

  // ATR series for SL/TP calculation
  const atrSeries = atr(assetCandles, 14);
  const closes = assetCandles.map((c) => c.close);

  const trades: MLTrade[] = [];
  let cash = config.initialCapital;
  let openTrade: MLTrade | null = null;
  let tradeId = 0;

  for (let i = 0; i < fv.length; i++) {
    const f = fv[i];
    const candle = assetCandles[assetCandles.length - fv.length + i];
    const close = candle.close;
    const currentATR = atrSeries[assetCandles.length - fv.length + i];
    const atrAbs = Number.isFinite(currentATR) && currentATR > 0 ? currentATR : close * 0.02;

    // Predict signal
    const btcBullFeature = f.features.length > 7 ? f.features[7] : 1;
    const result = predict(model, meta, f.features, btcBullFeature);

    // Manage open trade
    if (openTrade) {
      const ot = openTrade;
      let exitPrice = 0;
      let exitReason: MLTrade['exitReason'] | null = null;

      if (close >= ot.exitPrice) {
        // TP hit
        exitPrice = ot.exitPrice;
        exitReason = 'tp';
      } else if (close <= ot.entryPrice - config.stopLossATR * atrAbs) {
        // SL hit
        exitPrice = ot.entryPrice - config.stopLossATR * atrAbs;
        exitReason = 'sl';
      } else if (i - fv.findIndex((x) => x.time === ot.entryTime) >= config.maxHoldBars) {
        // Time stop
        exitPrice = close;
        exitReason = 'time';
      }

      if (exitReason && exitPrice > 0) {
        const gross = (exitPrice - ot.entryPrice) / ot.entryPrice;
        const net = gross - 2 * config.feeRate - 2 * config.slippage;
        const cashPnl = ot.qty * (exitPrice - ot.entryPrice);
        const fees = ot.qty * ot.entryPrice * config.feeRate + ot.qty * exitPrice * config.feeRate;
        const finalPnl = cashPnl - fees;
        cash += finalPnl;

        const rMultiple = config.stopLossATR * atrAbs > 0 ? (finalPnl / (config.initialCapital * config.riskPerTrade)) : 0;

        trades.push({
          ...ot,
          exitTime: f.time,
          exitPrice,
          pnl: Math.round(finalPnl * 100) / 100,
          pnlPercent: Math.round(net * 10000) / 100,
          rMultiple: Math.round(rMultiple * 1000) / 1000,
          exitReason,
          barsHeld: i - fv.findIndex((x) => x.time === ot.entryTime),
        });
        openTrade = null;
      }
    }

    // Enter new trade if no open position
    if (!openTrade && result.signal === 'long' && result.regimePass && cash > 0) {
      const riskCash = cash * config.riskPerTrade;
      const riskPerUnit = config.stopLossATR * atrAbs;
      if (riskPerUnit <= 0) continue;

      const qty = riskCash / riskPerUnit;
      const entryPrice = close * (1 + config.slippage);
      const stopLoss = entryPrice - config.stopLossATR * atrAbs;
      const takeProfit = entryPrice + config.takeProfitATR * atrAbs;

      openTrade = {
        id: ++tradeId,
        entryTime: f.time,
        exitTime: 0,
        entryPrice,
        exitPrice: 0,
        side: 'long',
        qty,
        pnl: 0,
        pnlPercent: 0,
        rMultiple: 0,
        exitReason: 'end',
        barsHeld: 0,
        probabilityUp: result.probabilityUp,
        regimePass: true,
      };
    }
  }

  // Close remaining open trade at last close
  if (openTrade) {
    const ot = openTrade;
    const lastClose = closes[closes.length - 1];
    const lastATR = atrSeries[atrSeries.length - 1];
    const lastATRAbs = Number.isFinite(lastATR) && lastATR > 0 ? lastATR : lastClose * 0.02;
    const gross = (lastClose - ot.entryPrice) / ot.entryPrice;
    const net = gross - 2 * config.feeRate - 2 * config.slippage;
    const cashPnl = ot.qty * (lastClose - ot.entryPrice);
    const fees = ot.qty * ot.entryPrice * config.feeRate + ot.qty * lastClose * config.feeRate;
    const finalPnl = cashPnl - fees;
    cash += finalPnl;

    const rMultiple = config.stopLossATR * lastATRAbs > 0 ? (finalPnl / (config.initialCapital * config.riskPerTrade)) : 0;

    trades.push({
      ...ot,
      exitTime: fv[fv.length - 1].time,
      exitPrice: lastClose,
      pnl: Math.round(finalPnl * 100) / 100,
      pnlPercent: Math.round(net * 10000) / 100,
      rMultiple: Math.round(rMultiple * 1000) / 1000,
      exitReason: 'end',
      barsHeld: fv.length - 1 - fv.findIndex((x) => x.time === ot.entryTime),
    });
  }

  // Compute metrics
  const winningTrades = trades.filter((t) => t.pnl > 0);
  const losingTrades = trades.filter((t) => t.pnl <= 0);
  const grossProfit = winningTrades.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losingTrades.reduce((a, t) => a + t.pnl, 0));
  const profitFactor = grossLoss === 0 ? (grossProfit > 0 ? Infinity : 0) : grossProfit / grossLoss;
  const winRate = trades.length > 0 ? (winningTrades.length / trades.length) * 100 : 0;

  const totalPnL = trades.reduce((a, t) => a + t.pnl, 0);
  const totalReturnPercent = (totalPnL / config.initialCapital) * 100;

  const expectancyR =
    trades.length > 0
      ? trades.reduce((a, t) => a + t.rMultiple, 0) / trades.length
      : 0;

  // Equity curve
  const equityCurve: Array<{ time: number; equity: number }> = [];
  let runningEquity = config.initialCapital;
  for (const t of trades) {
    runningEquity += t.pnl;
    equityCurve.push({ time: t.exitTime, equity: Math.round(runningEquity * 100) / 100 });
  }

  // Max drawdown
  let peak = config.initialCapital;
  let maxDD = 0;
  for (const p of equityCurve) {
    if (p.equity > peak) peak = p.equity;
    const dd = (peak - p.equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  // Avg bars held
  const avgBarsHeld =
    trades.length > 0 ? trades.reduce((a, t) => a + t.barsHeld, 0) / trades.length : 0;

  // Trades by month
  const tradesByMonthMap = new Map<string, { pnl: number; trades: number }>();
  for (const t of trades) {
    const month = new Date(t.exitTime * 1000).toISOString().slice(0, 7);
    const cur = tradesByMonthMap.get(month) || { pnl: 0, trades: 0 };
    cur.pnl += t.pnl;
    cur.trades += 1;
    tradesByMonthMap.set(month, cur);
  }
  const tradesByMonth = Array.from(tradesByMonthMap.entries())
    .map(([month, v]) => ({ month, pnl: v.pnl, trades: v.trades }))
    .sort((a, b) => a.month.localeCompare(b.month));

  return {
    symbol,
    interval,
    trades,
    totalTrades: trades.length,
    winningTrades: winningTrades.length,
    losingTrades: losingTrades.length,
    winRate,
    totalReturn: totalPnL,
    totalReturnPercent: Math.round(totalReturnPercent * 100) / 100,
    profitFactor: Number.isFinite(profitFactor) ? Math.round(profitFactor * 100) / 100 : 0,
    maxDrawdownPercent: Math.round(maxDD * 10000) / 100,
    expectancyR: Math.round(expectancyR * 1000) / 1000,
    avgBarsHeld: Math.round(avgBarsHeld * 10) / 10,
    equityCurve,
    tradesByMonth,
  };
}

function emptyResult(symbol: string, interval: string): MLBacktestResult {
  return {
    symbol,
    interval,
    trades: [],
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    winRate: 0,
    totalReturn: 0,
    totalReturnPercent: 0,
    profitFactor: 0,
    maxDrawdownPercent: 0,
    expectancyR: 0,
    avgBarsHeld: 0,
    equityCurve: [],
    tradesByMonth: [],
  };
}

export default runMLBacktest;
