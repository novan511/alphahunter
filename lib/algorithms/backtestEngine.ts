import {
  Candle,
  BacktestTrade,
  BacktestResult,
  BacktestConfig,
  DecouplingSignal,
} from '../types';
import { atr, returns, cumulativeReturn, maxDrawdown, sharpeRatio, sortinoRatio } from './indicators';

export function runBacktest(
  assetCandles: Candle[],
  indexCandles: Candle[],
  signals: DecouplingSignal[],
  config: BacktestConfig
): BacktestResult {
  const { initialCapital, riskPerTrade, stopLossATR, takeProfitATR, maxHoldBars, useTrailingStop, trailingStopATR } = config;

  const atrValues = atr(assetCandles, 14);
  const trades: BacktestTrade[] = [];

  const signalMap = new Map<number, DecouplingSignal>();
  for (const sig of signals) {
    signalMap.set(sig.time, sig);
  }

  let capital = initialCapital;
  let positionSide: 'long' | 'short' | null = null;
  let entryPrice = 0;
  let entryIndex = 0;
  let stopLoss = 0;
  let takeProfit = 0;
  let trailingStop = 0;

  for (let i = 1; i < assetCandles.length; i++) {
    const candle = assetCandles[i];
    const currentATR = atrValues[i];
    if (isNaN(currentATR) || currentATR === 0) continue;

    if (positionSide !== null) {
      const barsHeld = i - entryIndex;

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
        let pnlPercent: number;
        if (positionSide === 'long') {
          pnlPercent = (exitPrice - entryPrice) / entryPrice;
        } else {
          pnlPercent = (entryPrice - exitPrice) / entryPrice;
        }

        const pnl = capital * riskPerTrade * (pnlPercent / (stopLossATR * currentATR / entryPrice));
        capital += pnl;

        trades.push({
          entryTime: assetCandles[entryIndex].time,
          exitTime: candle.time,
          entryPrice,
          exitPrice,
          side: positionSide,
          pnl: Math.round(pnl * 100) / 100,
          pnlPercent: Math.round(pnlPercent * 10000) / 100,
          exitReason,
        });

        positionSide = null;
        entryPrice = 0;
        entryIndex = 0;
        stopLoss = 0;
        takeProfit = 0;
        trailingStop = 0;
      }
    }

    if (positionSide === null) {
      const signal = signalMap.get(candle.time);
      if (signal) {
        const riskAmount = capital * riskPerTrade;
        const positionSize = riskAmount / (stopLossATR * currentATR);

        if (signal.type === 'buy') {
          positionSide = 'long';
          entryPrice = candle.close;
          entryIndex = i;
          stopLoss = entryPrice - stopLossATR * currentATR;
          takeProfit = entryPrice + takeProfitATR * currentATR;
          trailingStop = useTrailingStop ? entryPrice - trailingStopATR * currentATR : 0;
        } else {
          positionSide = 'short';
          entryPrice = candle.close;
          entryIndex = i;
          stopLoss = entryPrice + stopLossATR * currentATR;
          takeProfit = entryPrice - takeProfitATR * currentATR;
          trailingStop = useTrailingStop ? entryPrice + trailingStopATR * currentATR : 0;
        }
      }
    }
  }

  if (positionSide !== null) {
    const lastCandle = assetCandles[assetCandles.length - 1];
    let pnlPercent: number;
    if (positionSide === 'long') {
      pnlPercent = (lastCandle.close - entryPrice) / entryPrice;
    } else {
      pnlPercent = (entryPrice - lastCandle.close) / entryPrice;
    }
    const pnl = capital * riskPerTrade * (pnlPercent / (stopLossATR * atrValues[atrValues.length - 1] / entryPrice));
    capital += pnl;
    trades.push({
      entryTime: assetCandles[entryIndex].time,
      exitTime: lastCandle.time,
      entryPrice,
      exitPrice: lastCandle.close,
      side: positionSide,
      pnl: Math.round(pnl * 100) / 100,
      pnlPercent: Math.round(pnlPercent * 10000) / 100,
      exitReason: 'end_of_data',
    });
  }

  const winningTrades = trades.filter((t) => t.pnl > 0);
  const losingTrades = trades.filter((t) => t.pnl <= 0);
  const tradePnLs = trades.map((t) => t.pnlPercent / 100);
  const cumReturns = cumulativeReturn(tradePnLs);
  const { maxDD, maxDDIndex } = maxDrawdown(cumReturns.length > 0 ? cumReturns : [1]);

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
  const profitFactor = grossLoss === 0 ? grossProfit > 0 ? Infinity : 0 : grossProfit / grossLoss;

  const avgHoldBars =
    trades.length > 0
      ? trades.reduce((a, t) => {
          const bars = Math.round((t.exitTime - t.entryTime) / (4 * 3600));
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