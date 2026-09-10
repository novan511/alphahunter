import {
  Candle,
  BacktestTrade,
  BacktestResult,
  BacktestConfig,
  DecouplingSignal,
} from '../types';
import { atr, cumulativeReturn, maxDrawdown, sharpeRatio, sortinoRatio } from './indicators';
import { intervalToSeconds } from './signalFreshness';

function clampPositive(value: number | undefined, fallback: number): number {
  if (value === undefined || Number.isNaN(value) || value < 0) return fallback;
  return value;
}

export function runBacktest(
  assetCandles: Candle[],
  indexCandles: Candle[],
  signals: DecouplingSignal[],
  config: BacktestConfig
): BacktestResult {
  const {
    initialCapital,
    riskPerTrade,
    stopLossATR,
    takeProfitATR,
    maxHoldBars,
    useTrailingStop,
    trailingStopATR,
  } = config;

  const feeRate = clampPositive(config.feeRate, 0);
  const slippage = clampPositive(config.slippage, 0);
  const interval = config.interval || '4h';

  const atrValues = atr(assetCandles, 14);
  const trades: BacktestTrade[] = [];

  const signalMap = new Map<number, DecouplingSignal>();
  for (const sig of signals) {
    signalMap.set(sig.time, sig);
  }

  let capital = initialCapital;
  let positionSide: 'long' | 'short' | null = null;
  let entryPrice = 0;
  let entryATR = 0;
  let entryIndex = 0;
  let stopLoss = 0;
  let takeProfit = 0;
  let trailingStop = 0;

  const applySlippageLongEntry = (price: number) => price * (1 + slippage);
  const applySlippageLongExit = (price: number) => price * (1 - slippage);
  const applySlippageShortEntry = (price: number) => price * (1 - slippage);
  const applySlippageShortExit = (price: number) => price * (1 + slippage);

  const settleTrade = (
    side: 'long' | 'short',
    fillEntry: number,
    fillExit: number,
    entryIdx: number,
    exitTime: number,
    exitReason: BacktestTrade['exitReason'],
    riskATR: number
  ) => {
    const grossPnlPercent =
      side === 'long'
        ? (fillExit - fillEntry) / fillEntry
        : (fillEntry - fillExit) / fillEntry;

    // Approximate taker fees on both legs (fraction of entry notional each side).
    const feeDrag = 2 * feeRate;
    const netPnlPercent = grossPnlPercent - feeDrag;

    const rMultiple = riskATR > 0 ? riskATR / fillEntry : 0;
    const pnl =
      rMultiple > 0
        ? capital * riskPerTrade * (netPnlPercent / rMultiple)
        : 0;

    capital += pnl;

    trades.push({
      entryTime: assetCandles[entryIdx].time,
      exitTime,
      entryPrice: Math.round(fillEntry * 10000) / 10000,
      exitPrice: Math.round(fillExit * 10000) / 10000,
      side,
      pnl: Math.round(pnl * 100) / 100,
      pnlPercent: Math.round(netPnlPercent * 10000) / 100,
      exitReason,
    });

    positionSide = null;
    entryPrice = 0;
    entryATR = 0;
    entryIndex = 0;
    stopLoss = 0;
    takeProfit = 0;
    trailingStop = 0;
  };

  for (let i = 1; i < assetCandles.length; i++) {
    const candle = assetCandles[i];
    const currentATR = atrValues[i];
    if (isNaN(currentATR) || currentATR === 0) continue;

    if (positionSide !== null) {
      const barsHeld = i - entryIndex;
      const riskATR = stopLossATR * entryATR;

      let exitPrice = 0;
      let exitReason: BacktestTrade['exitReason'] = 'signal';

      if (positionSide === 'long') {
        if (useTrailingStop && candle.low <= trailingStop) {
          exitPrice = trailingStop;
          exitReason = 'stop_loss';
        } else if (candle.low <= stopLoss) {
          exitPrice = stopLoss;
          exitReason = 'stop_loss';
        } else if (candle.high >= takeProfit) {
          exitPrice = takeProfit;
          exitReason = 'take_profit';
        } else if (barsHeld >= maxHoldBars) {
          exitPrice = candle.close;
          exitReason = 'end_of_data';
        }

        if (useTrailingStop && exitPrice === 0) {
          const newTrailing = candle.high - trailingStopATR * currentATR;
          if (newTrailing > trailingStop) {
            trailingStop = newTrailing;
          }
        }
      } else {
        if (useTrailingStop && candle.high >= trailingStop) {
          exitPrice = trailingStop;
          exitReason = 'stop_loss';
        } else if (candle.high >= stopLoss) {
          exitPrice = stopLoss;
          exitReason = 'stop_loss';
        } else if (candle.low <= takeProfit) {
          exitPrice = takeProfit;
          exitReason = 'take_profit';
        } else if (barsHeld >= maxHoldBars) {
          exitPrice = candle.close;
          exitReason = 'end_of_data';
        }

        if (useTrailingStop && exitPrice === 0) {
          const newTrailing = candle.low + trailingStopATR * currentATR;
          if (newTrailing < trailingStop) {
            trailingStop = newTrailing;
          }
        }
      }

      if (exitPrice > 0) {
        const fillExit =
          positionSide === 'long'
            ? applySlippageLongExit(exitPrice)
            : applySlippageShortExit(exitPrice);

        settleTrade(positionSide, entryPrice, fillExit, entryIndex, candle.time, exitReason, riskATR);
      }
    }

    if (positionSide === null) {
      const signal = signalMap.get(candle.time);
      if (signal && entryATR === 0) {
        const rawClose = candle.close;

        if (signal.type === 'buy') {
          const fillEntry = applySlippageLongEntry(rawClose);
          positionSide = 'long';
          entryPrice = fillEntry;
          entryATR = currentATR;
          entryIndex = i;
          stopLoss = fillEntry - stopLossATR * currentATR;
          takeProfit = fillEntry + takeProfitATR * currentATR;
          trailingStop = useTrailingStop ? fillEntry - trailingStopATR * currentATR : 0;
        } else {
          const fillEntry = applySlippageShortEntry(rawClose);
          positionSide = 'short';
          entryPrice = fillEntry;
          entryATR = currentATR;
          entryIndex = i;
          stopLoss = fillEntry + stopLossATR * currentATR;
          takeProfit = fillEntry - takeProfitATR * currentATR;
          trailingStop = useTrailingStop ? fillEntry + trailingStopATR * currentATR : 0;
        }
      }
    }
  }

  if (positionSide !== null) {
    const lastCandle = assetCandles[assetCandles.length - 1];
    const fillExit =
      positionSide === 'long'
        ? applySlippageLongExit(lastCandle.close)
        : applySlippageShortExit(lastCandle.close);
    const riskATR = stopLossATR * entryATR;
    settleTrade(positionSide, entryPrice, fillExit, entryIndex, lastCandle.time, 'end_of_data', riskATR);
  }

  const winningTrades = trades.filter((t) => t.pnl > 0);
  const losingTrades = trades.filter((t) => t.pnl <= 0);
  const tradePnLs = trades.map((t) => t.pnlPercent / 100);
  const cumReturns = cumulativeReturn(tradePnLs);
  const { maxDD } = maxDrawdown(cumReturns.length > 0 ? cumReturns : [1]);

  const assetCloses = assetCandles.map((c) => c.close);
  const buyHoldReturn =
    (assetCloses[assetCloses.length - 1] - assetCloses[0]) / assetCloses[0];

  const avgWin =
    winningTrades.length > 0
      ? winningTrades.reduce((a, t) => a + t.pnlPercent, 0) / winningTrades.length
      : 0;
  const avgLoss =
    losingTrades.length > 0
      ? losingTrades.reduce((a, t) => a + t.pnlPercent, 0) / losingTrades.length
      : 0;

  const grossProfit = winningTrades.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losingTrades.reduce((a, t) => a + t.pnl, 0));
  const profitFactor = grossLoss === 0 ? (grossProfit > 0 ? Infinity : 0) : grossProfit / grossLoss;

  const barSec = intervalToSeconds(interval);
  const avgHoldBars =
    trades.length > 0
      ? trades.reduce((a, t) => {
          const bars = Math.max(1, Math.round((t.exitTime - t.entryTime) / barSec));
          return a + bars;
        }, 0) / trades.length
      : 0;

  return {
    trades,
    totalTrades: trades.length,
    winningTrades: winningTrades.length,
    losingTrades: losingTrades.length,
    winRate: trades.length > 0 ? Math.round((winningTrades.length / trades.length) * 10000) / 100 : 0,
    totalPnL: Math.round((capital - initialCapital) * 100) / 100,
    totalPnLPercent: Math.round(((capital - initialCapital) / initialCapital) * 10000) / 100,
    avgWin: Math.round(avgWin * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    profitFactor: Math.round(profitFactor * 100) / 100,
    maxDrawdown: Math.round(maxDD * 10000) / 100,
    maxDrawdownPercent: Math.round(maxDD * 10000) / 100,
    sharpeRatio: Math.round(sharpeRatio(tradePnLs) * 100) / 100,
    sortinoRatio: Math.round(sortinoRatio(tradePnLs) * 100) / 100,
    avgHoldBars: Math.round(avgHoldBars * 10) / 10,
    buyHoldReturn: Math.round(buyHoldReturn * 10000) / 100,
    alpha: Math.round(((capital - initialCapital) / initialCapital - buyHoldReturn) * 10000) / 100,
  };
}
