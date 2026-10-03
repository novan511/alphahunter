import {
  Candle,
  BacktestTrade,
  BacktestResult,
  BacktestConfig,
  DecouplingSignal,
} from '../types';
import { atr, maxDrawdown, sharpeRatio, sortinoRatio } from './indicators';
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

  // Signals are keyed by the bar that PRODUCED them. A signal computed from
  // bar T's close cannot be filled at bar T's close — by the time that close is
  // known the bar is over. We therefore queue the signal and fill at the NEXT
  // bar's open, which is the earliest price a live trader could actually get.
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
  /** Bar index whose signal is waiting to be filled at the next open. */
  let pendingSignalIndex: number | null = null;
  let pendingSignal: DecouplingSignal | null = null;

  /** Mark-to-market equity, needed for honest drawdown/Sharpe. */
  let equityCurve: Array<{ time: number; equity: number }> = [];

  const markEquity = (i: number): number => {
    if (positionSide === null) return capital;
    const close = assetCandles[i].close;
    // Same risk-parity sizing used at settlement: qty = capital*risk / stopDist
    const riskUnit = stopLossATR * entryATR;
    if (riskUnit <= 0) return capital;
    const qty = (capital * riskPerTrade) / riskUnit;
    const unrealized =
      positionSide === 'long' ? qty * (close - entryPrice) : qty * (entryPrice - close);
    return capital + unrealized;
  };

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

    // riskFraction = stop distance as a fraction of entry price.
    const riskFraction = riskATR > 0 ? riskATR / fillEntry : 0;
    const pnl =
      riskFraction > 0
        ? capital * riskPerTrade * (netPnlPercent / riskFraction)
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
    const prevATR = atrValues[i - 1];
    const usableATR = !isNaN(currentATR) && currentATR > 0 ? currentATR : prevATR;
    if (isNaN(usableATR) || usableATR === 0) continue;

    // ---- 1) Fill any signal queued on the previous bar, at THIS bar's open ----
    if (positionSide === null && pendingSignal && pendingSignalIndex === i - 1) {
      const sig = pendingSignal;
      const openPx = candle.open || candle.close;
      if (sig.type === 'buy') {
        const fillEntry = applySlippageLongEntry(openPx);
        positionSide = 'long';
        entryPrice = fillEntry;
        entryATR = usableATR;
        entryIndex = i;
        stopLoss = fillEntry - stopLossATR * usableATR;
        takeProfit = fillEntry + takeProfitATR * usableATR;
        trailingStop = useTrailingStop ? fillEntry - trailingStopATR * usableATR : 0;
      } else {
        const fillEntry = applySlippageShortEntry(openPx);
        positionSide = 'short';
        entryPrice = fillEntry;
        entryATR = usableATR;
        entryIndex = i;
        stopLoss = fillEntry + stopLossATR * usableATR;
        takeProfit = fillEntry - takeProfitATR * usableATR;
        trailingStop = useTrailingStop ? fillEntry + trailingStopATR * usableATR : 0;
      }
      pendingSignal = null;
      pendingSignalIndex = null;
    }

    // ---- 2) Manage the open position on this bar ----
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
          const newTrailing = candle.high - trailingStopATR * usableATR;
          if (newTrailing > stopLoss) trailingStop = newTrailing;
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
          const newTrailing = candle.low + trailingStopATR * usableATR;
          if (newTrailing < stopLoss) trailingStop = newTrailing;
        }
      }

      if (exitPrice > 0) {
        const fillExit =
          positionSide === 'long'
            ? applySlippageLongExit(exitPrice)
            : applySlippageShortExit(exitPrice);

        settleTrade(positionSide, entryPrice, fillExit, entryIndex, candle.time, exitReason, riskATR);
        equityCurve.push({ time: candle.time, equity: capital });
      } else {
        equityCurve.push({ time: candle.time, equity: markEquity(i) });
      }
    } else {
      equityCurve.push({ time: candle.time, equity: capital });
    }

    // ---- 3) Queue today's signal for tomorrow's open ----
    if (positionSide === null) {
      const sig = signalMap.get(candle.time);
      if (sig && pendingSignalIndex === null) {
        pendingSignal = sig;
        pendingSignalIndex = i;
      }
    }
  }

  if (positionSide !== null) {
    const lastIdx = assetCandles.length - 1;
    const lastCandle = assetCandles[lastIdx];
    const fillExit =
      positionSide === 'long'
        ? applySlippageLongExit(lastCandle.close)
        : applySlippageShortExit(lastCandle.close);
    const riskATR = stopLossATR * entryATR;
    settleTrade(positionSide, entryPrice, fillExit, entryIndex, lastCandle.time, 'end_of_data', riskATR);
    equityCurve.push({ time: lastCandle.time, equity: capital });
  }

  const winningTrades = trades.filter((t) => t.pnl > 0);
  const losingTrades = trades.filter((t) => t.pnl <= 0);

  // ---- Sharpe / Sortino / MaxDD from the EQUITY curve, not the trade vector ----
  //
  // Computing these over per-trade returns treats every trade as equally spaced
  // in time and ignores every flat bar spent in cash. That makes drawdown and
  // risk ratios materially wrong (and flattering) for a strategy that is idle
  // most of the time. These are now per-bar returns of the marked-to-market
  // equity curve, annualised by bars-per-year.
  const barsPerYear = (() => {
    const sec = intervalToSeconds(interval);
    if (sec <= 0) return 365;
    return (365 * 24 * 3600) / sec;
  })();

  const barReturns: number[] = [];
  for (let k = 1; k < equityCurve.length; k++) {
    const prev = equityCurve[k - 1].equity;
    if (prev > 0) barReturns.push((equityCurve[k].equity - prev) / prev);
  }

  const annFactor = Math.sqrt(barsPerYear);
  const sharpe = barReturns.length > 1 ? sharpeRatio(barReturns) * annFactor : 0;
  const sortino = barReturns.length > 1 ? sortinoRatio(barReturns) * annFactor : 0;

  const equitySeries = equityCurve.length > 0 ? equityCurve.map((p) => p.equity) : [initialCapital];
  const { maxDD } = maxDrawdown(equitySeries);
  const maxDrawdownPercent = maxDD * 100;

  const assetCloses = assetCandles.map((c) => c.close);
  const buyHoldReturn =
    assetCloses.length > 1 && assetCloses[0] > 0
      ? (assetCloses[assetCloses.length - 1] - assetCloses[0]) / assetCloses[0]
      : 0;

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

  const totalPnLPercent =
    initialCapital > 0 ? ((capital - initialCapital) / initialCapital) * 100 : 0;

  return {
    trades,
    totalTrades: trades.length,
    winningTrades: winningTrades.length,
    losingTrades: losingTrades.length,
    winRate: trades.length > 0 ? Math.round((winningTrades.length / trades.length) * 10000) / 100 : 0,
    totalPnL: Math.round((capital - initialCapital) * 100) / 100,
    totalPnLPercent: Math.round(totalPnLPercent * 100) / 100,
    avgWin: Math.round(avgWin * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    profitFactor: Number.isFinite(profitFactor) ? Math.round(profitFactor * 100) / 100 : 99.99,
    maxDrawdown: Math.round(maxDrawdownPercent * 100) / 100,
    maxDrawdownPercent: Math.round(maxDrawdownPercent * 100) / 100,
    sharpeRatio: Math.round(sharpe * 100) / 100,
    sortinoRatio: Math.round(sortino * 100) / 100,
    avgHoldBars: Math.round(avgHoldBars * 10) / 10,
    buyHoldReturn: Math.round(buyHoldReturn * 10000) / 100,
    // Excess return vs buy & hold. This is NOT Jensen's alpha — it is not
    // beta- or volatility-adjusted. Relabelled in the UI accordingly.
    alpha: Math.round((totalPnLPercent - buyHoldReturn * 100) * 100) / 100,
  };
}
