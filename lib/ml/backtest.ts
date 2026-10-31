/**
 * ML Backtest Engine — Long/Short, leverage, compounded R position sizing.
 * Used both in training (walk-forward gate) and API backtest endpoint.
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
  side: 'long' | 'short';
  qty: number;
  notional: number;
  pnl: number;
  pnlPercent: number;
  rMultiple: number;
  exitReason: 'tp' | 'sl' | 'time' | 'end';
  barsHeld: number;
  probabilityUp: number;
  probabilityDown: number;
  regimePass: boolean;
}

interface MLBacktestResult {
  symbol: string;
  interval: string;
  leverage: number;
  allowShort: boolean;
  rrRatio: number;
  riskPerTrade: number;
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
  avgR: number;
  sharpe: number;
  avgBarsHeld: number;
  equityCurve: Array<{ time: number; equity: number }>;
  tradesByMonth: Array<{ month: string; pnl: number; trades: number }>;
  initialCapital: number;
  finalCapital: number;
}

interface BacktestConfig {
  initialCapital: number;
  riskPerTrade: number;
  stopLossATR: number;
  takeProfitATR: number;
  maxHoldBars: number;
  probThreshold: number;
  leverage: number;
  allowShort: boolean;
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
    // no model file — will use fallback
  }

  try {
    const metaRaw = fs.readFileSync(path.join(modelDir, `${fileName}.meta.json`), 'utf8');
    meta = loadMetaFromJSON(JSON.parse(metaRaw));
  } catch {
    // no meta
  }

  const probThreshold = meta?.prob_threshold ?? config.probThreshold;
  const regimeFilter = meta?.regime_filter ?? 'none';
  const allowShort = meta?.allow_short ?? config.allowShort;
  const leverage = meta?.leverage ?? config.leverage;
  const rrRatio = meta?.rr_ratio ?? (config.takeProfitATR / config.stopLossATR);
  const riskPerTrade = meta?.risk_per_trade ?? config.riskPerTrade;
  const slAtr = meta?.stop_loss_atr ?? config.stopLossATR;
  const tpAtr = meta?.take_profit_atr ?? config.takeProfitATR;
  const maxHold = meta?.max_hold_bars ?? config.maxHoldBars;

  // Build features
  const fv = buildFeatures(assetCandles, indexCandles);
  if (fv.length === 0) {
    return emptyResult(symbol, interval, config);
  }

  const closes = assetCandles.map((c) => c.close);
  const atrSeries = atr(assetCandles, 14);

  const trades: MLTrade[] = [];
  let account = config.initialCapital;
  let tradeId = 0;
  let i = 0;

  const equityCurve: Array<{ time: number; equity: number }> = [
    { time: fv[0].time, equity: account },
  ];

  while (i < fv.length) {
    const f = fv[i];
    const assetIdx = assetCandles.length - fv.length + i;
    const candle = assetCandles[assetIdx];
    const close = candle.close;
    const currentATR = atrSeries[assetIdx];
    const atrAbs = Number.isFinite(currentATR) && currentATR > 0 ? currentATR : close * 0.02;

    // Predict signal
    const btcBullFeature = f.features.length > 7 ? f.features[7] : 1;
    const result = predict(model, meta, f.features, btcBullFeature);

    // Determine stop distance
    const stopDist = slAtr * atrAbs;
    const tpDist = stopDist * rrRatio;
    if (stopDist <= 0) {
      i++;
      continue;
    }

    // Check if we have an open trade to manage
    const openTrade = trades.find((t) => t.exitTime === 0);
    if (openTrade) {
      const ot = openTrade;
      let exitPrice = 0;
      let exitReason: MLTrade['exitReason'] | null = null;
      const barsHeld = i - fv.findIndex((x) => x.time === ot.entryTime);

      // Check time stop
      if (barsHeld >= maxHold) {
        exitPrice = close;
        exitReason = 'time';
      } else if (ot.side === 'long') {
        if (candle.low <= ot.entryPrice - slAtr * atrAbs) {
          exitPrice = ot.entryPrice - slAtr * atrAbs;
          exitReason = 'sl';
        } else if (candle.high >= ot.entryPrice + tpAtr * atrAbs) {
          exitPrice = ot.entryPrice + tpAtr * atrAbs;
          exitReason = 'tp';
        }
      } else {
        // short
        if (candle.high >= ot.entryPrice + slAtr * atrAbs) {
          exitPrice = ot.entryPrice + slAtr * atrAbs;
          exitReason = 'sl';
        } else if (candle.low <= ot.entryPrice - tpAtr * atrAbs) {
          exitPrice = ot.entryPrice - tpAtr * atrAbs;
          exitReason = 'tp';
        }
      }

      if (exitReason && exitPrice > 0) {
        // Calculate PnL
        let grossPnl: number;
        if (ot.side === 'long') {
          grossPnl = ot.qty * (exitPrice - ot.entryPrice);
        } else {
          grossPnl = ot.qty * (ot.entryPrice - exitPrice);
        }

        // Fees + slippage on entry and exit
        const fees = ot.qty * ot.entryPrice * config.feeRate + ot.qty * exitPrice * config.feeRate;
        const slipCost = ot.qty * ot.entryPrice * config.slippage + ot.qty * exitPrice * config.slippage;
        const netPnl = grossPnl - fees - slipCost;

        // R multiple based on original risk
        const riskAmount = ot.notional * (slAtr * atrAbs / ot.entryPrice); // approx risk at entry
        const rMultiple = riskAmount > 0 ? netPnl / riskAmount : 0;

        // Update account (compounded)
        account += netPnl;

        ot.exitTime = f.time;
        ot.exitPrice = exitPrice;
        ot.pnl = Math.round(netPnl * 100) / 100;
        ot.pnlPercent = Math.round(((exitPrice - ot.entryPrice) / ot.entryPrice) * (ot.side === 'long' ? 1 : -1) * 10000) / 100;
        ot.rMultiple = Math.round(rMultiple * 1000) / 1000;
        ot.exitReason = exitReason;
        ot.barsHeld = barsHeld;

        equityCurve.push({ time: f.time, equity: Math.round(account * 100) / 100 });

        i++; // move past this bar after exit
        continue;
      }
    }

    // No open trade — look for new entry
    if (!trades.find((t) => t.exitTime === 0)) {
      const takeLong = result.signal === 'long' && result.regimePass;
      const takeShort = config.allowShort && result.signal === 'short' && result.regimePass;

      let side: 'long' | 'short' | null = null;
      if (takeLong && takeShort) {
        side = result.probabilityUp >= result.probabilityDown ? 'long' : 'short';
      } else if (takeLong) {
        side = 'long';
      } else if (takeShort) {
        side = 'short';
      }

      if (side) {
        const entryPrice = close * (1 + config.slippage); // approx entry with slippage
        const riskAmount = account * riskPerTrade;
        const qty = riskAmount / stopDist; // units of asset
        const notional = qty * entryPrice;

        if (qty > 0 && notional > 0) {
          trades.push({
            id: ++tradeId,
            entryTime: f.time,
            exitTime: 0,
            entryPrice,
            exitPrice: 0,
            side,
            qty,
            notional,
            pnl: 0,
            pnlPercent: 0,
            rMultiple: 0,
            exitReason: 'end',
            barsHeld: 0,
            probabilityUp: result.probabilityUp,
            probabilityDown: result.probabilityDown,
            regimePass: true,
          });
        }
      }
    }

    i++;
  }

  // Close remaining open trade at last close
  const openTrade = trades.find((t) => t.exitTime === 0);
  if (openTrade) {
    const ot = openTrade;
    const lastClose = closes[closes.length - 1];
    const lastATR = atrSeries[atrSeries.length - 1];
    const lastATRAbs = Number.isFinite(lastATR) && lastATR > 0 ? lastATR : lastClose * 0.02;
    let grossPnl: number;
    if (ot.side === 'long') {
      grossPnl = ot.qty * (lastClose - ot.entryPrice);
    } else {
      grossPnl = ot.qty * (ot.entryPrice - lastClose);
    }
    const fees = ot.qty * ot.entryPrice * config.feeRate + ot.qty * lastClose * config.feeRate;
    const slipCost = ot.qty * ot.entryPrice * config.slippage + ot.qty * lastClose * config.slippage;
    const netPnl = grossPnl - fees - slipCost;
    const riskAmount = ot.notional * (slAtr * lastATRAbs / ot.entryPrice);
    const rMultiple = riskAmount > 0 ? netPnl / riskAmount : 0;
    account += netPnl;

    ot.exitTime = fv[fv.length - 1].time;
    ot.exitPrice = lastClose;
    ot.pnl = Math.round(netPnl * 100) / 100;
    ot.pnlPercent = Math.round(((lastClose - ot.entryPrice) / ot.entryPrice) * (ot.side === 'long' ? 1 : -1) * 10000) / 100;
    ot.rMultiple = Math.round(rMultiple * 1000) / 1000;
    ot.exitReason = 'end';
    ot.barsHeld = fv.length - 1 - fv.findIndex((x) => x.time === ot.entryTime);

    equityCurve.push({ time: fv[fv.length - 1].time, equity: Math.round(account * 100) / 100 });
  }

  // Compute metrics
  const completedTrades = trades.filter((t) => t.exitTime > 0);
  const winningTrades = completedTrades.filter((t) => t.pnl > 0);
  const losingTrades = completedTrades.filter((t) => t.pnl <= 0);
  const grossProfit = winningTrades.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losingTrades.reduce((a, t) => a + t.pnl, 0));
  const profitFactor = grossLoss === 0 ? (grossProfit > 0 ? Infinity : 0) : grossProfit / grossLoss;
  const winRate = completedTrades.length > 0 ? (winningTrades.length / completedTrades.length) * 100 : 0;

  const totalPnL = completedTrades.reduce((a, t) => a + t.pnl, 0);
  const totalReturnPercent = (totalPnL / config.initialCapital) * 100;

  const expectancyR =
    completedTrades.length > 0
      ? completedTrades.reduce((a, t) => a + t.rMultiple, 0) / completedTrades.length
      : 0;

  const avgR = completedTrades.length > 0
    ? completedTrades.reduce((a, t) => a + Math.abs(t.rMultiple), 0) / completedTrades.length
    : 0;

  const avgBarsHeld =
    completedTrades.length > 0
      ? completedTrades.reduce((a, t) => a + t.barsHeld, 0) / completedTrades.length
      : 0;

  // Sharpe approximation from R multiples
  const rMultiples = completedTrades.map((t) => t.rMultiple);
  const meanR = rMultiples.length > 0 ? rMultiples.reduce((a, b) => a + b, 0) / rMultiples.length : 0;
  const stdR =
    rMultiples.length > 1
      ? Math.sqrt(
          rMultiples.reduce((a, b) => a + Math.pow(b - meanR, 2), 0) / (rMultiples.length - 1)
        )
    : 0;
  const sharpe = stdR > 0 ? (meanR / stdR) * Math.sqrt(365 * 6) : 0; // 4h bars/year approx

  // Max drawdown from equity curve
  let peak = config.initialCapital;
  let maxDD = 0;
  for (const p of equityCurve) {
    if (p.equity > peak) peak = p.equity;
    const dd = (peak - p.equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  // Trades by month
  const tradesByMonthMap = new Map<string, { pnl: number; trades: number }>();
  for (const t of completedTrades) {
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
    leverage,
    allowShort,
    rrRatio,
    riskPerTrade,
    trades: completedTrades,
    totalTrades: completedTrades.length,
    winningTrades: winningTrades.length,
    losingTrades: losingTrades.length,
    winRate,
    totalReturn: totalPnL,
    totalReturnPercent: Math.round(totalReturnPercent * 100) / 100,
    profitFactor: Number.isFinite(profitFactor) ? Math.round(profitFactor * 100) / 100 : 0,
    maxDrawdownPercent: Math.round(maxDD * 10000) / 100,
    expectancyR: Math.round(expectancyR * 1000) / 1000,
    avgR: Math.round(avgR * 1000) / 1000,
    sharpe: Math.round(sharpe * 100) / 100,
    avgBarsHeld: Math.round(avgBarsHeld * 10) / 10,
    equityCurve,
    tradesByMonth,
    initialCapital: config.initialCapital,
    finalCapital: Math.round(account * 100) / 100,
  };
}

function emptyResult(
  symbol: string,
  interval: string,
  config: BacktestConfig
): MLBacktestResult {
  return {
    symbol,
    interval,
    leverage: config.leverage,
    allowShort: config.allowShort,
    rrRatio: config.takeProfitATR / config.stopLossATR,
    riskPerTrade: config.riskPerTrade,
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
    avgR: 0,
    sharpe: 0,
    avgBarsHeld: 0,
    equityCurve: [{ time: Date.now() / 1000, equity: config.initialCapital }],
    tradesByMonth: [],
    initialCapital: config.initialCapital,
    finalCapital: config.initialCapital,
  };
}

export default runMLBacktest;
