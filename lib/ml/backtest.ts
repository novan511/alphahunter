/**
 * ML Backtest Engine — Arena-inspired.
 * Long/Short, leverage, compounded R position sizing, exit ladder,
 * loss streak de-risking, circuit breaker, knockout, correlation guardrail,
 * per-symbol mistake ledger.
 * Used both in training (walk-forward gate) and API backtest endpoint.
 */

import { Candle } from '../types';
import { atr } from '../algorithms/indicators';
import { buildFeatures } from './features';
import { loadModelFromJSON, loadMetaFromJSON, predict, createGuardrailState, managePosition, calculatePositionSize, OpenPosition } from './inference';
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
  exitReason: 'tp' | 'sl' | 'time' | 'partial' | 'end';
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
  guardrailStats: {
    lossStreak: number;
    circuitBreakerTriggers: number;
    knockout: boolean;
    mistakeLedgerSymbols: Array<{ symbol: string; avgR: number; trades: number }>;
  };
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

// Arena guardrail constants (mirror Python)
const CIRCUIT_R = -3.0;
const KNOCKOUT_EQ = 500.0;
const RISK_PER_TRADE_MAX = 0.03;
const RISK_R_MAX = 0.06;
const POS_MAX = 4;
const TRAIL_R = 1.0;
const PARTIAL_R = 1.5;

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
  const highs = assetCandles.map((c) => c.high);
  const lows = assetCandles.map((c) => c.low);
  const opens = assetCandles.map((c) => c.open);
  const atrSeries = atr(assetCandles, 14);

  const trades: MLTrade[] = [];
  let account = config.initialCapital;
  let tradeId = 0;
  let i = 0;

  const equityCurve: Array<{ time: number; equity: number }> = [
    { time: fv[0].time, equity: account },
  ];

  // Guardrail state
  const gr = createGuardrailState(config.initialCapital);
  let circuitBreakerTriggers = 0;
  let knockout = false;

  // Per-symbol mistake ledger
  const symbolTradeRs: Record<string, number[]> = {};

  // Track last prediction result for closing remaining positions
  let lastResult: { probabilityUp: number; probabilityDown: number } = { probabilityUp: 0.5, probabilityDown: 0.5 };

  while (i < fv.length) {
    const f = fv[i];
    const assetIdx = assetCandles.length - fv.length + i;
    const candle = assetCandles[assetIdx];
    const close = candle.close;
    const high = candle.high;
    const low = candle.low;
    const openPx = candle.open;
    const currentATR = atrSeries[assetIdx];
    const atrAbs = Number.isFinite(currentATR) && currentATR > 0 ? currentATR : close * 0.02;

    // Predict signal
    const btcBullFeature = f.features.length > 7 ? f.features[7] : 1;
    const result = predict(model, meta, f.features, btcBullFeature);
    lastResult = { probabilityUp: result.probabilityUp, probabilityDown: result.probabilityDown };

    // Determine stop distance
    const stopDist = slAtr * atrAbs;
    const tpDist = stopDist * rrRatio;
    if (stopDist <= 0) {
      i++;
      continue;
    }

    // --- Manage open positions ---
    const newPositions: OpenPosition[] = [];

    for (const pos of gr.openPositions) {
      pos.barsHeld += 1;
      const dir = pos.side === 'long' ? 1 : -1;
      const liveR = (close - pos.entryPrice) * dir / Math.max(1e-9, pos.riskUnit);

      // Exit ladder: check stop loss first
      let exitReason: MLTrade['exitReason'] | null = null;
      let exitPx = 0;

      if (pos.side === 'long') {
        if (low <= pos.stopLoss) {
          exitReason = 'sl';
          exitPx = Math.min(pos.stopLoss, openPx);
        } else if (high >= pos.takeProfit) {
          exitReason = 'tp';
          exitPx = pos.takeProfit;
        }
      } else {
        if (high >= pos.stopLoss) {
          exitReason = 'sl';
          exitPx = Math.max(pos.stopLoss, openPx);
        } else if (low <= pos.takeProfit) {
          exitReason = 'tp';
          exitPx = pos.takeProfit;
        }
      }

      // Time stop
      if (!exitReason && pos.barsHeld >= maxHold) {
        exitReason = 'time';
        exitPx = close;
      }

      if (exitReason) {
        // Calculate PnL
        let grossPnl: number;
        if (pos.side === 'long') {
          grossPnl = pos.qty * (exitPx - pos.entryPrice);
        } else {
          grossPnl = pos.qty * (pos.entryPrice - exitPx);
        }
        const fees = pos.qty * pos.entryPrice * config.feeRate + pos.qty * exitPx * config.feeRate;
        const slipCost = pos.qty * pos.entryPrice * config.slippage + pos.qty * exitPx * config.slippage;
        const netPnl = grossPnl - fees - slipCost;
        const rMultiple = pos.riskDollar > 0 ? netPnl / pos.riskDollar : 0;

        account += netPnl;

        trades.push({
          id: ++tradeId,
          entryTime: pos.entryTime,
          exitTime: f.time,
          entryPrice: pos.entryPrice,
          exitPrice: exitPx,
          side: pos.side,
          qty: pos.qty,
          notional: pos.qty * pos.entryPrice,
          pnl: Math.round(netPnl * 100) / 100,
          pnlPercent: Math.round(((exitPx - pos.entryPrice) / pos.entryPrice) * (pos.side === 'long' ? 1 : -1) * 10000) / 100,
          rMultiple: Math.round(rMultiple * 1000) / 1000,
          exitReason,
          barsHeld: pos.barsHeld,
          probabilityUp: result.probabilityUp,
          probabilityDown: result.probabilityDown,
          regimePass: true,
        });

        // Track per-symbol R
        if (!symbolTradeRs[symbol]) symbolTradeRs[symbol] = [];
        symbolTradeRs[symbol].push(rMultiple);

        // Loss streak tracking
        if (netPnl <= 0) gr.lossStreak++;
        else gr.lossStreak = 0;

        // Track exit reason
        gr.exitReasonCounts[exitReason] = (gr.exitReasonCounts[exitReason] || 0) + 1;
      } else {
        // Apply exit ladder via managePosition
        const managed = managePosition(
          {
            side: pos.side,
            entryPrice: pos.entryPrice,
            stopLoss: pos.stopLoss,
            takeProfit: pos.takeProfit,
            riskUnit: pos.riskUnit,
            barsHeld: pos.barsHeld,
            tookPartial: pos.tookPartial,
            qty: pos.qty,
          },
          close,
          currentATR,
          maxHold,
        );

        pos.stopLoss = managed.pos.stopLoss;
        pos.qty = managed.pos.qty;
        pos.tookPartial = managed.pos.tookPartial;
        pos.barsHeld = managed.pos.barsHeld;

        if (managed.exitReason) {
          // Partial exit
          let grossPnl: number;
          if (pos.side === 'long') {
            grossPnl = pos.qty * (managed.exitPrice! - pos.entryPrice);
          } else {
            grossPnl = pos.qty * (pos.entryPrice - managed.exitPrice!);
          }
          const fees = pos.qty * pos.entryPrice * config.feeRate + pos.qty * managed.exitPrice! * config.feeRate;
          const slipCost = pos.qty * pos.entryPrice * config.slippage + pos.qty * managed.exitPrice! * config.slippage;
          const netPnl = grossPnl - fees - slipCost;
          const rMultiple = pos.riskDollar > 0 ? netPnl / pos.riskDollar : 0;

          account += netPnl;

          trades.push({
            id: ++tradeId,
            entryTime: pos.entryTime,
            exitTime: f.time,
            entryPrice: pos.entryPrice,
            exitPrice: managed.exitPrice!,
            side: pos.side,
            qty: pos.qty * 2, // half was closed, original was double
            notional: pos.qty * pos.entryPrice * 2,
            pnl: Math.round(netPnl * 100) / 100,
            pnlPercent: Math.round(((managed.exitPrice! - pos.entryPrice) / pos.entryPrice) * (pos.side === 'long' ? 1 : -1) * 10000) / 100,
            rMultiple: Math.round(rMultiple * 1000) / 1000,
            exitReason: managed.exitReason,
            barsHeld: pos.barsHeld,
            probabilityUp: result.probabilityUp,
            probabilityDown: result.probabilityDown,
            regimePass: true,
          });

          if (!symbolTradeRs[symbol]) symbolTradeRs[symbol] = [];
          symbolTradeRs[symbol].push(rMultiple);

          if (netPnl <= 0) gr.lossStreak++;
          else gr.lossStreak = 0;

          gr.exitReasonCounts[managed.exitReason] = (gr.exitReasonCounts[managed.exitReason] || 0) + 1;
        }

        newPositions.push(pos);
      }
    }

    gr.openPositions = newPositions;

    // --- Circuit breaker calculation ---
    let openUnrealizedR = 0;
    let openRisk = 0;
    for (const pos of gr.openPositions) {
      const dir = pos.side === 'long' ? 1 : -1;
      const liveR = (close - pos.entryPrice) * dir / Math.max(1e-9, pos.riskUnit);
      openUnrealizedR += liveR;
      openRisk += pos.riskDollar / account;
    }

    gr.circuitBlocked = openUnrealizedR <= CIRCUIT_R;
    if (gr.circuitBlocked) circuitBreakerTriggers++;

    gr.knockout = account <= KNOCKOUT_EQ;
    if (gr.knockout) knockout = true;

    // --- New entry (only if no open position and not blocked) ---
    const hasOpen = gr.openPositions.length > 0;
    if (!hasOpen && !gr.circuitBlocked && !gr.knockout) {
      const takeLong = result.signal === 'long' && result.regimePass;
      const takeShort = allowShort && result.signal === 'short' && result.regimePass;

      let side: 'long' | 'short' | null = null;
      if (takeLong && takeShort) {
        side = result.probabilityUp >= result.probabilityDown ? 'long' : 'short';
      } else if (takeLong) {
        side = 'long';
      } else if (takeShort) {
        side = 'short';
      }

      if (side) {
        // Mistake ledger check: symbol banned if avgR ≤ -0.5 from ≥3 trades
        const symRs = symbolTradeRs[symbol] || [];
        if (symRs.length >= 3) {
          const symAvgR = symRs.reduce((a, b) => a + b, 0) / symRs.length;
          if (symAvgR <= -0.5) {
            i++;
            continue;
          }
        }

        // Loss streak de-risking
        const streakCap = (
          gr.lossStreak >= 5 ? 0.005 :
          gr.lossStreak >= 4 ? 0.0075 :
          gr.lossStreak >= 3 ? 0.01 :
          gr.lossStreak >= 2 ? 0.015 :
          gr.lossStreak >= 1 ? 0.02 : RISK_PER_TRADE_MAX
        );
        const effRisk = Math.min(riskPerTrade, streakCap);

        // Check total open risk ≤ 6%
        if (openRisk + effRisk > RISK_R_MAX) {
          i++;
          continue;
        }

        const entryPrice = close * (1 + config.slippage); // approx entry with slippage
        const { qty, notional, riskDollar } = calculatePositionSize(account, effRisk, stopDist, entryPrice);
        if (qty <= 0 || notional <= 0) {
          i++;
          continue;
        }

        const stopPrice = side === 'long' ? entryPrice - stopDist : entryPrice + stopDist;
        const tpPrice = side === 'long' ? entryPrice + tpDist : entryPrice - tpDist;

        gr.openPositions.push({
          side,
          entryPrice,
          stopLoss: stopPrice,
          takeProfit: tpPrice,
          riskUnit: stopDist,
          barsHeld: 0,
          tookPartial: false,
          qty,
          entryTime: f.time,
          riskDollar,
        });

        i++;
        continue;
      }
    }

    i++;
  }

  // Close remaining open positions at last close
  const lastClose = closes[closes.length - 1];
  for (const pos of gr.openPositions) {
    let grossPnl: number;
    if (pos.side === 'long') {
      grossPnl = pos.qty * (lastClose - pos.entryPrice);
    } else {
      grossPnl = pos.qty * (pos.entryPrice - lastClose);
    }
    const fees = pos.qty * pos.entryPrice * config.feeRate + pos.qty * lastClose * config.feeRate;
    const slipCost = pos.qty * pos.entryPrice * config.slippage + pos.qty * lastClose * config.slippage;
    const netPnl = grossPnl - fees - slipCost;
    const rMultiple = pos.riskDollar > 0 ? netPnl / pos.riskDollar : 0;

    account += netPnl;

    trades.push({
      id: ++tradeId,
      entryTime: pos.entryTime,
      exitTime: fv[fv.length - 1].time,
      entryPrice: pos.entryPrice,
      exitPrice: lastClose,
      side: pos.side,
      qty: pos.qty,
      notional: pos.qty * pos.entryPrice,
      pnl: Math.round(netPnl * 100) / 100,
      pnlPercent: Math.round(((lastClose - pos.entryPrice) / pos.entryPrice) * (pos.side === 'long' ? 1 : -1) * 10000) / 100,
      rMultiple: Math.round(rMultiple * 1000) / 1000,
      exitReason: 'end',
      barsHeld: pos.barsHeld,
      probabilityUp: lastResult.probabilityUp,
      probabilityDown: lastResult.probabilityDown,
      regimePass: true,
    });

    if (!symbolTradeRs[symbol]) symbolTradeRs[symbol] = [];
    symbolTradeRs[symbol].push(rMultiple);

    if (netPnl <= 0) gr.lossStreak++;
    else gr.lossStreak = 0;
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
  const sharpe = stdR > 0 ? (meanR / stdR) * Math.sqrt(365 * 6) : 0;

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

  // Mistake ledger symbols
  const mistakeLedger = Object.entries(symbolTradeRs)
    .filter(([, rs]) => rs.length >= 3)
    .map(([sym, rs]) => ({
      symbol: sym,
      avgR: rs.reduce((a, b) => a + b, 0) / rs.length,
      trades: rs.length,
    }))
    .filter((m) => m.avgR <= -0.5);

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
    guardrailStats: {
      lossStreak: gr.lossStreak,
      circuitBreakerTriggers,
      knockout,
      mistakeLedgerSymbols: mistakeLedger,
    },
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
    guardrailStats: {
      lossStreak: 0,
      circuitBreakerTriggers: 0,
      knockout: false,
      mistakeLedgerSymbols: [],
    },
  };
}

export default runMLBacktest;
