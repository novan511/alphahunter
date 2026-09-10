import { Candle } from '../types';
import { atr, sharpeRatio, sortinoRatio, maxDrawdown } from '../algorithms/indicators';
import { intervalToSeconds } from '../algorithms/signalFreshness';
import {
  PortfolioBacktestResult,
  PortfolioPosition,
  PortfolioTrade,
  QuantAssetData,
  QuantRiskConfig,
  QuantSignalEvent,
  EquityPoint,
} from './types';

function clampPositive(n: number | undefined, fallback: number): number {
  if (n === undefined || Number.isNaN(n) || n < 0) return fallback;
  return n;
}

function barsPerYear(interval: string): number {
  const sec = intervalToSeconds(interval);
  if (sec <= 0) return 365;
  return (365 * 24 * 3600) / sec;
}

function buildSignalMap(
  assets: QuantAssetData[],
  risk: QuantRiskConfig
): Map<number, QuantSignalEvent[]> {
  const map = new Map<number, QuantSignalEvent[]>();
  for (const asset of assets) {
    for (const sig of asset.signals) {
      if (sig.strength < risk.minSignalStrength) continue;
      if (!risk.allowShort && sig.type === 'sell') continue;
      const list = map.get(sig.time) || [];
      list.push({
        time: sig.time,
        symbol: asset.symbol,
        type: sig.type,
        price: sig.price,
        strength: sig.strength,
        reason: sig.reason,
      });
      map.set(sig.time, list);
    }
  }
  return map;
}

function markToMarket(
  openPositions: PortfolioPosition[],
  assetMap: Map<string, QuantAssetData>,
  timeIndexMap: Map<string, Map<number, number>>,
  time: number
): { unrealized: number; exposure: number } {
  let unrealized = 0;
  let exposure = 0;
  for (const pos of openPositions) {
    const data = assetMap.get(pos.symbol);
    const tMap = timeIndexMap.get(pos.symbol);
    if (!data || !tMap) continue;
    const ci = tMap.get(time);
    if (ci === undefined) continue;
    const px = data.candles[ci].close;
    exposure += pos.qty * px;
    unrealized +=
      pos.side === 'long' ? pos.qty * (px - pos.entryPrice) : pos.qty * (pos.entryPrice - px);
  }
  return { unrealized, exposure };
}

export function runPortfolioBacktest(
  assets: QuantAssetData[],
  riskConfig: QuantRiskConfig,
  options: { startIdx?: number; endIdx?: number } = {}
): PortfolioBacktestResult {
  const risk: QuantRiskConfig = {
    ...riskConfig,
    feeRate: clampPositive(riskConfig.feeRate, 0),
    slippage: clampPositive(riskConfig.slippage, 0),
    maxConcurrentPositions: Math.max(1, riskConfig.maxConcurrentPositions || 3),
    maxExposurePct: clampPositive(riskConfig.maxExposurePct, 0.4),
    maxPortfolioDrawdownPct: clampPositive(riskConfig.maxPortfolioDrawdownPct, 0.1),
    minSignalStrength: clampPositive(riskConfig.minSignalStrength, 0),
    interval: riskConfig.interval || '4h',
  };

  const usable = assets.filter((a) => a.candles.length > 0);
  if (usable.length === 0) {
    return emptyResult(risk.initialCapital);
  }

  const timeline: number[] = [];
  const seen = new Set<number>();
  for (const a of usable) {
    for (const c of a.candles) {
      if (!seen.has(c.time)) {
        seen.add(c.time);
        timeline.push(c.time);
      }
    }
  }
  timeline.sort((a, b) => a - b);

  const startIdx = options.startIdx ?? 0;
  const endIdx = options.endIdx ?? timeline.length - 1;
  const windowTimes = timeline.slice(startIdx, endIdx + 1);
  if (windowTimes.length === 0) {
    return emptyResult(risk.initialCapital);
  }

  const assetMap = new Map<string, QuantAssetData>();
  const timeIndexMap = new Map<string, Map<number, number>>();
  for (const a of usable) {
    assetMap.set(a.symbol, a);
    const tMap = new Map<number, number>();
    a.candles.forEach((c, i) => tMap.set(c.time, i));
    timeIndexMap.set(a.symbol, tMap);
  }

  const atrCache = new Map<string, number[]>();
  for (const a of usable) {
    atrCache.set(a.symbol, atr(a.candles, 14));
  }

  const signalMap = buildSignalMap(usable, risk);
  let cash = risk.initialCapital;
  let peakEquity = risk.initialCapital;
  let haltedByDd = false;
  let maxConcurrentSeen = 0;
  let signalsSeen = 0;
  let signalsTaken = 0;

  const openPositions: PortfolioPosition[] = [];
  const trades: PortfolioTrade[] = [];
  const equityCurve: EquityPoint[] = [];

  // Signals observed on bar T execute at next bar open (no same-close fill).
  let pendingSignals: QuantSignalEvent[] = [];

  const closePosition = (
    pos: PortfolioPosition,
    exitTime: number,
    rawExitPrice: number,
    reason: PortfolioTrade['exitReason']
  ) => {
    const exitPrice =
      rawExitPrice * (1 + (pos.side === 'long' ? -risk.slippage : risk.slippage));
    const gross =
      pos.side === 'long'
        ? (exitPrice - pos.entryPrice) / pos.entryPrice
        : (pos.entryPrice - exitPrice) / pos.entryPrice;
    const net = gross - 2 * risk.feeRate;
    const riskUnit = risk.stopLossATR * pos.entryATR;
    const returnOnRisk = riskUnit > 0 ? (net * pos.entryPrice) / riskUnit : 0;
    const cashPnl =
      pos.side === 'long'
        ? pos.qty * (exitPrice - pos.entryPrice)
        : pos.qty * (pos.entryPrice - exitPrice);
    const fees =
      pos.qty * pos.entryPrice * risk.feeRate + pos.qty * exitPrice * risk.feeRate;
    const finalPnl = cashPnl - fees;
    cash += finalPnl;

    trades.push({
      symbol: pos.symbol,
      side: pos.side,
      entryTime: pos.entryTime,
      exitTime,
      entryPrice: pos.entryPrice,
      exitPrice,
      qty: pos.qty,
      pnl: Math.round(finalPnl * 100) / 100,
      pnlPercent: Math.round(net * 10000) / 100,
      returnOnRisk: Math.round(returnOnRisk * 1000) / 1000,
      barsHeld: pos.barsHeld,
      exitReason: reason,
    });
  };

  for (let t = 0; t < windowTimes.length; t++) {
    const time = windowTimes[t];

    // 1) Manage open positions on this bar
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i];
      const tMap = timeIndexMap.get(pos.symbol);
      const data = assetMap.get(pos.symbol);
      if (!tMap || !data) continue;
      const ci = tMap.get(time);
      if (ci === undefined) continue;
      const candle = data.candles[ci];
      const atrSeries = atrCache.get(pos.symbol);
      const currentATR = atrSeries?.[ci] ?? pos.entryATR;
      pos.barsHeld += 1;

      let exitPrice = 0;
      let reason: PortfolioTrade['exitReason'] | null = null;

      if (pos.side === 'long') {
        if (candle.low <= pos.stopLoss) {
          exitPrice = pos.stopLoss;
          reason = 'stop_loss';
        } else if (candle.high >= pos.takeProfit) {
          exitPrice = pos.takeProfit;
          reason = 'take_profit';
        } else if (pos.barsHeld >= risk.maxHoldBars) {
          exitPrice = candle.close;
          reason = 'time_stop';
        }
      } else {
        if (candle.high >= pos.stopLoss) {
          exitPrice = pos.stopLoss;
          reason = 'stop_loss';
        } else if (candle.low <= pos.takeProfit) {
          exitPrice = pos.takeProfit;
          reason = 'take_profit';
        } else if (pos.barsHeld >= risk.maxHoldBars) {
          exitPrice = candle.close;
          reason = 'time_stop';
        }
      }

      if (reason && exitPrice > 0) {
        closePosition(pos, time, exitPrice, reason);
        openPositions.splice(i, 1);
      } else if (!isNaN(currentATR) && currentATR > 0 && pos.side === 'long') {
        const trail = candle.high - risk.stopLossATR * currentATR;
        if (trail > pos.stopLoss) pos.stopLoss = trail;
      }
    }

    // 2) Mark-to-market equity (cash + unrealized)
    const { unrealized, exposure } = markToMarket(openPositions, assetMap, timeIndexMap, time);
    const equityNow = cash + unrealized;
    if (equityNow > peakEquity) peakEquity = equityNow;
    const dd = peakEquity > 0 ? (peakEquity - equityNow) / peakEquity : 0;

    if (dd >= risk.maxPortfolioDrawdownPct && openPositions.length > 0) {
      haltedByDd = true;
      for (let i = openPositions.length - 1; i >= 0; i--) {
        const pos = openPositions[i];
        const tMap = timeIndexMap.get(pos.symbol);
        const data = assetMap.get(pos.symbol);
        const ci = tMap?.get(time);
        if (data && ci !== undefined) {
          closePosition(pos, time, data.candles[ci].close, 'dd_halt');
        }
        openPositions.splice(i, 1);
      }
    }

    // 3) Enter pending signals at this bar OPEN (slippage already in entry)
    if (!haltedByDd && pendingSignals.length > 0) {
      const sorted = [...pendingSignals].sort((a, b) => b.strength - a.strength);
      for (const ev of sorted) {
        if (openPositions.length >= risk.maxConcurrentPositions) break;
        if (openPositions.some((p) => p.symbol === ev.symbol)) continue;

        const data = assetMap.get(ev.symbol);
        const tMap = timeIndexMap.get(ev.symbol);
        if (!data || !tMap) continue;
        const ci = tMap.get(time);
        if (ci === undefined) continue;
        const candle = data.candles[ci];
        const atrSeries = atrCache.get(ev.symbol);
        const currentATR = atrSeries?.[ci] ?? 0;
        if (isNaN(currentATR) || currentATR <= 0) continue;

        const side: 'long' | 'short' = ev.type === 'buy' ? 'long' : 'short';
        // Fill at bar open, not signal close
        const openPx = candle.open || candle.close;
        const entryPrice = openPx * (1 + (side === 'long' ? risk.slippage : -risk.slippage));
        const riskPerUnit = risk.stopLossATR * currentATR;
        if (riskPerUnit <= 0 || entryPrice <= 0) continue;

        const mtmEquity = cash + markToMarket(openPositions, assetMap, timeIndexMap, time).unrealized;
        const riskCash = Math.max(0, mtmEquity) * risk.riskPerTrade;
        const qty = riskCash / riskPerUnit;

        const currentExposure = markToMarket(openPositions, assetMap, timeIndexMap, time).exposure;
        const newExposure = currentExposure + qty * entryPrice;
        if (mtmEquity > 0 && newExposure / mtmEquity > risk.maxExposurePct) {
          continue;
        }

        const stopLoss =
          side === 'long' ? entryPrice - riskPerUnit : entryPrice + riskPerUnit;
        const takeProfit =
          side === 'long'
            ? entryPrice + risk.takeProfitATR * currentATR
            : entryPrice - risk.takeProfitATR * currentATR;

        openPositions.push({
          symbol: ev.symbol,
          side,
          entryTime: time,
          entryPrice,
          entryATR: currentATR,
          qty,
          stopLoss,
          takeProfit,
          barsHeld: 0,
          signalStrength: ev.strength,
        });
        signalsTaken += 1;
      }
    }
    pendingSignals = [];

    // 4) Collect signals on this bar close → pending for next bar
    const barSignals = signalMap.get(time);
    if (barSignals) {
      signalsSeen += barSignals.length;
      pendingSignals = barSignals;
    }

    maxConcurrentSeen = Math.max(maxConcurrentSeen, openPositions.length);

    const mtm = markToMarket(openPositions, assetMap, timeIndexMap, time);
    const eq = cash + mtm.unrealized;
    equityCurve.push({
      time,
      equity: Math.round(eq * 100) / 100,
      exposure: eq > 0 ? Math.round((mtm.exposure / eq) * 1000) / 1000 : 0,
      positions: openPositions.length,
    });
  }

  // close leftovers at last bar close
  for (const pos of openPositions) {
    const data = assetMap.get(pos.symbol);
    const tMap = timeIndexMap.get(pos.symbol);
    const lastTime = windowTimes[windowTimes.length - 1];
    const ci = tMap?.get(lastTime) ?? (data ? data.candles.length - 1 : 0);
    if (data && data.candles[ci]) {
      closePosition(pos, lastTime, data.candles[ci].close, 'end_of_data');
    }
  }

  // final MTM point after closes
  if (equityCurve.length > 0) {
    equityCurve[equityCurve.length - 1] = {
      ...equityCurve[equityCurve.length - 1],
      equity: Math.round(cash * 100) / 100,
      exposure: 0,
      positions: 0,
    };
  }

  return summarize(trades, equityCurve, {
    initialCapital: risk.initialCapital,
    buyHold: buyHoldProxy(usable, windowTimes, timeIndexMap),
    maxConcurrentSeen,
    signalsSeen,
    signalsTaken,
    haltedByDd,
    barsPerYear: barsPerYear(risk.interval),
  });
}

function buyHoldProxy(
  assets: QuantAssetData[],
  windowTimes: number[],
  timeIndexMap: Map<string, Map<number, number>>
): number {
  if (assets.length === 0 || windowTimes.length < 2) return 0;
  const startPrices: number[] = [];
  const endPrices: number[] = [];
  for (const a of assets) {
    const tMap = timeIndexMap.get(a.symbol);
    if (!tMap) continue;
    const sIdx = tMap.get(windowTimes[0]);
    const eIdx = tMap.get(windowTimes[windowTimes.length - 1]);
    if (sIdx === undefined || eIdx === undefined) continue;
    startPrices.push(a.candles[sIdx].close);
    endPrices.push(a.candles[eIdx].close);
  }
  if (startPrices.length === 0) return 0;
  let sumRet = 0;
  for (let i = 0; i < startPrices.length; i++) {
    if (startPrices[i] > 0) sumRet += (endPrices[i] - startPrices[i]) / startPrices[i];
  }
  return (sumRet / startPrices.length) * 100;
}

function emptyResult(capital: number): PortfolioBacktestResult {
  return {
    trades: [],
    equityCurve: [{ time: 0, equity: capital, exposure: 0, positions: 0 }],
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    winRate: 0,
    totalPnL: 0,
    totalPnLPercent: 0,
    profitFactor: 0,
    maxDrawdownPercent: 0,
    calmarRatio: 0,
    sharpeRatio: 0,
    sortinoRatio: 0,
    avgHoldBars: 0,
    avgWinR: 0,
    avgLossR: 0,
    expectancyR: 0,
    exposurePctAvg: 0,
    maxConcurrentSeen: 0,
    buyHoldReturn: 0,
    alpha: 0,
    haltedByDd: false,
    signalsSeen: 0,
    signalsTaken: 0,
  };
}

function summarize(
  trades: PortfolioTrade[],
  equityCurve: EquityPoint[],
  extras: {
    initialCapital: number;
    buyHold: number;
    maxConcurrentSeen: number;
    signalsSeen: number;
    signalsTaken: number;
    haltedByDd: boolean;
    barsPerYear: number;
  }
): PortfolioBacktestResult {
  const winningTrades = trades.filter((t) => t.pnl > 0);
  const losingTrades = trades.filter((t) => t.pnl <= 0);
  const grossProfit = winningTrades.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losingTrades.reduce((a, t) => a + t.pnl, 0));
  const profitFactor = grossLoss === 0 ? (grossProfit > 0 ? Infinity : 0) : grossProfit / grossLoss;

  const finalEquity =
    equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].equity : extras.initialCapital;
  const totalPnL = finalEquity - extras.initialCapital;
  const totalPnLPercent = (totalPnL / extras.initialCapital) * 100;

  const returns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].equity;
    if (prev > 0) returns.push((equityCurve[i].equity - prev) / prev);
  }

  const cum = equityCurve.map((p) => p.equity / extras.initialCapital);
  const { maxDD } = maxDrawdown(cum.length ? cum : [1]);
  const maxDrawdownPercent = maxDD * 100;
  const calmarRatio =
    maxDrawdownPercent > 0
      ? totalPnLPercent / maxDrawdownPercent
      : totalPnLPercent > 0
        ? 10
        : 0;

  const ann = Math.sqrt(extras.barsPerYear || 365);
  const sharpeAnn = sharpeRatio(returns) * ann;
  const sortinoAnn = sortinoRatio(returns) * ann;

  const avgWinR =
    winningTrades.length > 0
      ? winningTrades.reduce((a, t) => a + t.returnOnRisk, 0) / winningTrades.length
      : 0;
  const avgLossR =
    losingTrades.length > 0
      ? losingTrades.reduce((a, t) => a + t.returnOnRisk, 0) / losingTrades.length
      : 0;
  const expectancyR =
    trades.length > 0 ? trades.reduce((a, t) => a + t.returnOnRisk, 0) / trades.length : 0;

  const avgHoldBars =
    trades.length > 0 ? trades.reduce((a, t) => a + t.barsHeld, 0) / trades.length : 0;

  const exposurePctAvg =
    equityCurve.length > 0
      ? equityCurve.reduce((a, p) => a + p.exposure, 0) / equityCurve.length
      : 0;

  return {
    trades,
    equityCurve,
    totalTrades: trades.length,
    winningTrades: winningTrades.length,
    losingTrades: losingTrades.length,
    winRate: trades.length > 0 ? (winningTrades.length / trades.length) * 100 : 0,
    totalPnL: Math.round(totalPnL * 100) / 100,
    totalPnLPercent: Math.round(totalPnLPercent * 100) / 100,
    profitFactor: Number.isFinite(profitFactor)
      ? Math.round(profitFactor * 100) / 100
      : profitFactor > 0
        ? 99.99
        : 0,
    maxDrawdownPercent: Math.round(maxDrawdownPercent * 100) / 100,
    calmarRatio: Math.round(calmarRatio * 100) / 100,
    sharpeRatio: Math.round(sharpeAnn * 100) / 100,
    sortinoRatio: Math.round(sortinoAnn * 100) / 100,
    avgHoldBars: Math.round(avgHoldBars * 10) / 10,
    avgWinR: Math.round(avgWinR * 1000) / 1000,
    avgLossR: Math.round(avgLossR * 1000) / 1000,
    expectancyR: Math.round(expectancyR * 1000) / 1000,
    exposurePctAvg: Math.round(exposurePctAvg * 1000) / 1000,
    maxConcurrentSeen: extras.maxConcurrentSeen,
    buyHoldReturn: Math.round(extras.buyHold * 100) / 100,
    alpha: Math.round((totalPnLPercent - extras.buyHold) * 100) / 100,
    haltedByDd: extras.haltedByDd,
    signalsSeen: extras.signalsSeen,
    signalsTaken: extras.signalsTaken,
  };
}
