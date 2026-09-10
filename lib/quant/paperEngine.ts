import { Candle } from '../types';
import { atr } from '../algorithms/indicators';
import { QuantRiskConfig } from './types';
import { claimSymbol, releaseSymbol, releaseAgent } from './conflictGuard';
import { evaluateEventFilter } from './eventFilter';
import { createBanditState, pickStrategyUCB, updateBandit, BanditState, StrategyArm } from './strategyBandit';

export interface PaperPosition {
  symbol: string;
  side: 'long' | 'short';
  entryTime: number;
  entryPrice: number;
  entryATR: number;
  qty: number;
  stopLoss: number;
  takeProfit: number;
  barsHeld: number;
  signalStrength: number;
  reason: string;
  strategy?: StrategyArm;
}

export interface PaperTrade {
  symbol: string;
  side: 'long' | 'short';
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  pnl: number;
  pnlPercent: number;
  exitReason: string;
  reason: string;
}

export interface PaperSignal {
  time: number;
  symbol: string;
  type: 'buy' | 'sell';
  price: number;
  strength: number;
  reason: string;
}

export interface PaperWatchRow {
  symbol: string;
  price: number;
  changePct: number;
  volumeRatio: number | null;
  lastSignal: 'buy' | 'sell' | null;
  lastSignalStrength: number | null;
  openPosition: 'long' | 'short' | null;
  note: string;
}

export interface PaperState {
  running: boolean;
  startedAt: number | null;
  updatedAt: number | null;
  /** Human-readable: what the agent is doing right now */
  activity: string;
  /** Last market scan snapshot */
  watchlist: PaperWatchRow[];
  risk: QuantRiskConfig;
  universe: string[];
  cash: number;
  peakEquity: number;
  halted: boolean;
  positions: PaperPosition[];
  trades: PaperTrade[];
  log: string[];
  lastBarTimes: Record<string, number>;
  /** Latest close per symbol from last market scan (for running PnL) */
  lastPrices: Record<string, number>;
  /** Rolling equity samples for supervisor charts */
  equityHistory: Array<{ time: number; equity: number }>;
  /** Strategy bandit state per agent */
  bandit: BanditState;
  /** Meta capital weight from supervisor allocator (0–1) */
  metaWeight: number;
  /** Last meta allocation snapshot (for UI without re-step) */
  lastMeta?: {
    weights: Record<string, number>;
    reason: string;
    scale?: number;
    at: number;
  };
  lastBandit?: string;
  lastStress?: unknown;
  stats: {
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    totalPnL: number;
    totalPnLPercent: number;
  };
}

export function createPaperState(
  risk: QuantRiskConfig,
  universe: string[]
): PaperState {
  const cash = risk.initialCapital;
  return {
    running: true,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    activity: 'Booting paper agent… loading universe',
    watchlist: [],
    risk: { ...risk },
    universe: [...universe],
    cash,
    peakEquity: cash,
    halted: false,
    positions: [],
    trades: [],
    log: [`[start] paper agent online · capital ${cash} · ${universe.length} assets · ${risk.interval}`],
    lastBarTimes: {},
    lastPrices: {},
    equityHistory: [{ time: Date.now(), equity: cash }],
    bandit: createBanditState(),
    metaWeight: 1 / 3,
    stats: {
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      winRate: 0,
      totalPnL: 0,
      totalPnLPercent: 0,
    },
  };
}

function pushLog(state: PaperState, msg: string) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  state.log = [line, ...state.log].slice(0, 80);
}

export function paperEquity(state: PaperState, prices: Record<string, number>): number {
  let eq = state.cash;
  for (const pos of state.positions) {
    const px = prices[pos.symbol] ?? pos.entryPrice;
    eq += pos.side === 'long' ? pos.qty * (px - pos.entryPrice) : pos.qty * (pos.entryPrice - px);
  }
  return eq;
}

function recalcStats(state: PaperState) {
  const wins = state.trades.filter((t) => t.pnl > 0);
  const losses = state.trades.filter((t) => t.pnl <= 0);
  state.stats = {
    totalTrades: state.trades.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    winRate: state.trades.length ? (wins.length / state.trades.length) * 100 : 0,
    totalPnL: Math.round((state.cash - state.risk.initialCapital) * 100) / 100,
    totalPnLPercent:
      Math.round(((state.cash - state.risk.initialCapital) / state.risk.initialCapital) * 10000) / 100,
  };
}

function closePaper(
  state: PaperState,
  pos: PaperPosition,
  exitTime: number,
  rawExit: number,
  reason: string,
  prices: Record<string, number>
) {
  const slip = state.risk.slippage || 0;
  const fee = state.risk.feeRate || 0;
  const exitPrice = rawExit * (1 + (pos.side === 'long' ? -slip : slip));
  const cashPnl =
    pos.side === 'long'
      ? pos.qty * (exitPrice - pos.entryPrice)
      : pos.qty * (pos.entryPrice - exitPrice);
  const fees = pos.qty * pos.entryPrice * fee + pos.qty * exitPrice * fee;
  const pnl = cashPnl - fees;
  state.cash += pnl;

  state.trades.unshift({
    symbol: pos.symbol,
    side: pos.side,
    entryTime: pos.entryTime,
    exitTime,
    entryPrice: pos.entryPrice,
    exitPrice,
    qty: pos.qty,
    pnl: Math.round(pnl * 100) / 100,
    pnlPercent: Math.round((pnl / Math.max(1, pos.qty * pos.entryPrice)) * 10000) / 100,
    exitReason: reason,
    reason: pos.reason,
  });
  state.trades = state.trades.slice(0, 200);

  pushLog(
    state,
    `CLOSE ${pos.side.toUpperCase()} ${pos.symbol} @ ${exitPrice.toFixed(4)} pnl=${pnl.toFixed(2)} (${reason})`
  );
  void prices;
}

export interface StepMarketSnapshot {
  /** symbol -> latest closed candle */
  latest: Record<string, Candle>;
  /** symbol -> last N candles for ATR / signals (at least 40) */
  history: Record<string, Candle[]>;
  benchmarkSymbol: string | null;
  benchmarkHistory: Candle[] | null;
  signals: PaperSignal[];
}

export function buildWatchlist(
  state: PaperState,
  snap: StepMarketSnapshot
): PaperWatchRow[] {
  const rows: PaperWatchRow[] = [];
  const openBySym = new Map(state.positions.map((p) => [p.symbol, p.side]));

  for (const symbol of state.universe) {
    const last = snap.latest[symbol];
    const hist = snap.history[symbol];
    if (!last || !hist || hist.length < 2) continue;

    const prev = hist[hist.length - 2].close;
    const changePct = prev > 0 ? ((last.close - prev) / prev) * 100 : 0;

    const recentSignals = snap.signals.filter((s) => s.symbol === symbol);
    const lastSig = recentSignals.sort((a, b) => b.time - a.time)[0] || null;

    let volumeRatio: number | null = null;
    if (hist.length >= 21) {
      const volMa =
        hist.slice(-21, -1).reduce((a, c) => a + c.volume, 0) / 20;
      if (volMa > 0) volumeRatio = last.volume / volMa;
    }

    const openSide = openBySym.get(symbol) || null;
    let note = 'scanning';
    if (openSide) note = `holding ${openSide}`;
    else if (lastSig && lastSig.strength >= state.risk.minSignalStrength) {
      note = `candidate ${lastSig.type} str=${lastSig.strength.toFixed(1)}`;
    } else if (lastSig) {
      note = `mtf ${lastSig.type} ${lastSig.strength.toFixed(1)}${lastSig.strength >= state.risk.minSignalStrength ? '' : ' (<min)'}`;
    }

    rows.push({
      symbol,
      price: last.close,
      changePct: Math.round(changePct * 100) / 100,
      volumeRatio: volumeRatio != null ? Math.round(volumeRatio * 100) / 100 : null,
      lastSignal: lastSig ? lastSig.type : null,
      lastSignalStrength: lastSig ? lastSig.strength : null,
      openPosition: openSide,
      note,
    });
  }

  // sort: open positions first, then strongest candidates, then by |change|
  rows.sort((a, b) => {
    const ao = a.openPosition ? 1 : 0;
    const bo = b.openPosition ? 1 : 0;
    if (ao !== bo) return bo - ao;
    const as = a.lastSignalStrength ?? 0;
    const bs = b.lastSignalStrength ?? 0;
    if (as !== bs) return bs - as;
    return Math.abs(b.changePct) - Math.abs(a.changePct);
  });

  return rows;
}

/**
 * One autonomous paper-trading tick:
 * manage exits → MTM/DD halt → open new positions from agent-selected signals.
 */
export function paperStep(
  state: PaperState,
  snap: StepMarketSnapshot,
  agentId: string = 'default'
): { state: PaperState; closedTrades: PaperTrade[] } {
  const closedTrades: PaperTrade[] = [];
  if (!state.running) {
    state.activity = 'Agent stopped — not scanning';
    return { state, closedTrades };
  }
  const risk = state.risk;
  const prices: Record<string, number> = {};
  for (const [sym, c] of Object.entries(snap.latest)) {
    prices[sym] = c.close;
  }

  state.watchlist = buildWatchlist(state, snap);
  state.lastPrices = { ...prices };
  state.activity = `MTF scan ${state.universe.length} assets · primary ${risk.interval} + context TFs…`;

  // only act on newly closed bars
  const freshSymbols = new Set<string>();
  for (const [sym, c] of Object.entries(snap.latest)) {
    const last = state.lastBarTimes[sym];
    if (last === undefined || c.time > last) {
      freshSymbols.add(sym);
      state.lastBarTimes[sym] = c.time;
    }
  }

  const closeAndTrack = (
    pos: PaperPosition,
    exitTime: number,
    exitPx: number,
    reason: string
  ) => {
    closePaper(state, pos, exitTime, exitPx, reason, prices);
    releaseSymbol(pos.symbol, agentId);
    // Update bandit with realized reward
    if (state.bandit && pos.strategy) {
      const lastT = state.trades[0];
      if (lastT) {
        const reward = Math.max(-1, Math.min(1, lastT.pnlPercent / 5));
        updateBandit(state.bandit, pos.strategy, reward);
      }
    }
    if (state.trades[0]) closedTrades.unshift(state.trades[0]);
  };

  // exits / manage
  for (let i = state.positions.length - 1; i >= 0; i--) {
    const pos = state.positions[i];
    const hist = snap.history[pos.symbol];
    const last = snap.latest[pos.symbol];
    if (!hist || !last) continue;

    const idxAtr = hist.length - 1;
    const currentATR = atr(hist, 14)[idxAtr] || pos.entryATR;
    pos.barsHeld += 1;

    let exitPx = 0;
    let reason = '';
    if (pos.side === 'long') {
      if (last.low <= pos.stopLoss) {
        exitPx = pos.stopLoss;
        reason = 'stop_loss';
      } else if (last.high >= pos.takeProfit) {
        exitPx = pos.takeProfit;
        reason = 'take_profit';
      } else if (pos.barsHeld >= risk.maxHoldBars) {
        exitPx = last.close;
        reason = 'time_stop';
      } else if (currentATR > 0) {
        const trail = last.high - risk.stopLossATR * currentATR;
        if (trail > pos.stopLoss) pos.stopLoss = trail;
      }
    } else {
      if (last.high >= pos.stopLoss) {
        exitPx = pos.stopLoss;
        reason = 'stop_loss';
      } else if (last.low <= pos.takeProfit) {
        exitPx = pos.takeProfit;
        reason = 'take_profit';
      } else if (pos.barsHeld >= risk.maxHoldBars) {
        exitPx = last.close;
        reason = 'time_stop';
      }
    }

    if (reason && exitPx > 0) {
      closeAndTrack(pos, last.time, exitPx, reason);
      state.positions.splice(i, 1);
    }
  }

  const equity = paperEquity(state, prices);
  if (equity > state.peakEquity) state.peakEquity = equity;
  const dd = state.peakEquity > 0 ? (state.peakEquity - equity) / state.peakEquity : 0;

  if (dd >= risk.maxPortfolioDrawdownPct && state.positions.length > 0) {
    state.halted = true;
    pushLog(state, `DD HALT at ${(dd * 100).toFixed(2)}% — closing all`);
    for (let i = state.positions.length - 1; i >= 0; i--) {
      const pos = state.positions[i];
      const last = snap.latest[pos.symbol];
      if (last) closeAndTrack(pos, last.time, last.close, 'dd_halt');
    }
    state.positions = [];
  }

  if (!state.halted) {
    const evt = evaluateEventFilter(agentId);
    if (!evt.allowEntries) {
      pushLog(state, `event-filter: skip entries — ${evt.reason}`);
    } else {
      // Prefer newest signals; also allow recent-window signals on first fills
      const candidates = snap.signals
        .filter((s) => s.strength >= risk.minSignalStrength)
        .filter((s) => risk.allowShort || s.type === 'buy')
        .sort((a, b) => b.time - a.time || b.strength - a.strength);

      // Dedupe by symbol keep strongest recent
      const bySym = new Map<string, (typeof candidates)[number]>();
      for (const s of candidates) {
        const prev = bySym.get(s.symbol);
        if (!prev || s.strength > prev.strength || s.time > prev.time) {
          bySym.set(s.symbol, s);
        }
      }
      const deduped: typeof candidates = [];
      bySym.forEach((v) => deduped.push(v));
      deduped.sort((a, b) => b.strength - a.strength);

      // Bandit picks preferred arm; we boost matching signals
      if (!state.bandit) state.bandit = createBanditState();
      const preferredArm = pickStrategyUCB(state.bandit);
      const armBoost = (reason: string): number => {
        const r = reason.toLowerCase();
        if (preferredArm === 'spike' && r.includes('spike')) return 1.15;
        if (preferredArm === 'momentum' && (r.includes('mom') || r.includes('vol'))) return 1.1;
        if (preferredArm === 'decoupling' && r.includes('decoupl')) return 1.1;
        return 1;
      };

      const metaScale = Math.max(0.5, Math.min(1.3, state.metaWeight || 1 / 3) * 3);

      for (const sig of deduped) {
        if (state.positions.length >= risk.maxConcurrentPositions) break;
        if (state.positions.some((p) => p.symbol === sig.symbol)) continue;

        const claim = claimSymbol(agentId, sig.symbol, sig.type === 'buy' ? 'long' : 'short', sig.strength);
        if (!claim.ok) {
          pushLog(state, `conflict-guard skip ${sig.symbol} — ${claim.reason}`);
          continue;
        }

        const hist = snap.history[sig.symbol];
        const last = snap.latest[sig.symbol];
        if (!hist || !last || hist.length < 20) {
          releaseSymbol(sig.symbol, agentId);
          continue;
        }

        const currentATR = atr(hist, 14)[hist.length - 1];
        if (!currentATR || currentATR <= 0) {
          releaseSymbol(sig.symbol, agentId);
          continue;
        }

        const side: 'long' | 'short' = sig.type === 'buy' ? 'long' : 'short';
        const openPx = last.open || last.close;
        const entryPrice = openPx * (1 + (side === 'long' ? risk.slippage : -risk.slippage));
        const riskPerUnit = risk.stopLossATR * currentATR;
        const eqNow = paperEquity(state, prices);
        const sizeScale = evt.sizeScale * metaScale * armBoost(sig.reason);
        const qty = (Math.max(0, eqNow) * risk.riskPerTrade * sizeScale) / riskPerUnit;

        const exposure = state.positions.reduce((sum, p) => {
          const px = prices[p.symbol] ?? p.entryPrice;
          return sum + p.qty * px;
        }, 0);
        if (eqNow > 0 && (exposure + qty * entryPrice) / eqNow > risk.maxExposurePct) {
          releaseSymbol(sig.symbol, agentId);
          continue;
        }

        const stopLoss =
          side === 'long' ? entryPrice - riskPerUnit : entryPrice + riskPerUnit;
        const takeProfit =
          side === 'long'
            ? entryPrice + risk.takeProfitATR * currentATR
            : entryPrice - risk.takeProfitATR * currentATR;

        const strategy: StrategyArm = sig.reason.toLowerCase().includes('spike')
          ? 'spike'
          : sig.reason.toLowerCase().includes('decoupl')
            ? 'decoupling'
            : 'momentum';

        state.positions.push({
          symbol: sig.symbol,
          side,
          entryTime: last.time,
          entryPrice,
          entryATR: currentATR,
          qty,
          stopLoss,
          takeProfit,
          barsHeld: 0,
          signalStrength: sig.strength,
          reason: sig.reason,
          strategy,
        });
        pushLog(
          state,
          `OPEN ${side.toUpperCase()} ${sig.symbol} @ ${entryPrice.toFixed(4)} str=${sig.strength.toFixed(1)} [${strategy}] — ${sig.reason}`
        );
      }
    }
  }

  recalcStats(state);
  const finalEq = paperEquity(state, prices);
  if (!state.equityHistory) state.equityHistory = [];
  const lastSample = state.equityHistory[state.equityHistory.length - 1];
  const nowMs = Date.now();
  if (!lastSample || nowMs - lastSample.time > 45_000 || Math.abs(lastSample.equity - finalEq) > 0.05) {
    state.equityHistory.push({ time: nowMs, equity: Math.round(finalEq * 100) / 100 });
    if (state.equityHistory.length > 240) {
      state.equityHistory = state.equityHistory.slice(-240);
    }
  }
  state.updatedAt = nowMs;

  // Final activity narrative
  if (state.halted) {
    state.activity =
      'DD HALT — capital preservation mode. Waiting for reset / recovery.';
  } else if (closedTrades.length > 0 && state.positions.length > 0) {
    const held = state.positions.map((p) => p.symbol.replace(/^.*:/, '')).join(', ');
    state.activity = `Managed exits (${closedTrades.length}) · holding ${state.positions.length}: ${held}`;
  } else if (closedTrades.length > 0) {
    state.activity = `Closed ${closedTrades.length} position(s) · now flat, watching for next setup`;
  } else if (state.positions.length > 0) {
    const held = state.positions.map((p) => `${p.side.toUpperCase()} ${p.symbol.replace(/^.*:/, '')}`).join(', ');
    const candidates = state.watchlist.filter((w) => !w.openPosition && (w.lastSignalStrength ?? 0) >= risk.minSignalStrength);
    const candTxt =
      candidates.length > 0
        ? ` · candidates: ${candidates.slice(0, 3).map((c) => c.symbol.replace(/^.*:/, '')).join(', ')}`
        : ' · no new entry above min strength';
    state.activity = `Monitoring open: ${held}${candTxt}`;
  } else {
    const recent = state.watchlist
      .filter((w) => w.lastSignalStrength != null)
      .sort((a, b) => (b.lastSignalStrength ?? 0) - (a.lastSignalStrength ?? 0));
    const above = recent.filter((w) => (w.lastSignalStrength ?? 0) >= risk.minSignalStrength);
    if (above.length > 0) {
      state.activity = `Flat · scanning ${state.universe.length} assets · candidates: ${above
        .slice(0, 4)
        .map((c) => `${c.symbol.replace(/^.*:/, '')}(${c.lastSignal} ${c.lastSignalStrength?.toFixed(1)})`)
        .join(', ')}`;
    } else if (recent.length > 0) {
      const top = recent[0];
      state.activity = `Flat · no signal ≥ minStr ${risk.minSignalStrength} · closest: ${top.symbol.replace(/^.*:/, '')} ${top.lastSignal} ${top.lastSignalStrength?.toFixed(1)}`;
    } else {
      state.activity = `Flat · scanning ${state.universe.length} assets · waiting setups on ${risk.interval}`;
    }
  }

  return { state, closedTrades };
}

export function serializePaper(state: PaperState) {
  const prices: Record<string, number> = { ...(state.lastPrices || {}) };
  for (const p of state.positions) {
    if (prices[p.symbol] === undefined) prices[p.symbol] = p.entryPrice;
  }

  const positions = state.positions.map((p) => {
    const mark = prices[p.symbol] ?? p.entryPrice;
    const gross =
      p.side === 'long' ? p.qty * (mark - p.entryPrice) : p.qty * (p.entryPrice - mark);
    const notional = p.qty * p.entryPrice || 1;
    return {
      ...p,
      markPrice: Math.round(mark * 10000) / 10000,
      unrealizedPnl: Math.round(gross * 100) / 100,
      unrealizedPnlPct: Math.round((gross / notional) * 10000) / 100,
    };
  });

  const totalUnrealized = positions.reduce((a, p) => a + p.unrealizedPnl, 0);
  const equity = paperEquity(state, prices);

  // ensure history has at least current point
  if (!state.equityHistory) state.equityHistory = [];
  if (state.equityHistory.length === 0) {
    state.equityHistory.push({ time: Date.now(), equity: Math.round(equity * 100) / 100 });
  }

  return {
    ...state,
    positions,
    lastPrices: prices,
    equityHistory: state.equityHistory,
    totalUnrealizedPnl: Math.round(totalUnrealized * 100) / 100,
    equity: Math.round(equity * 100) / 100,
    openCount: state.positions.length,
  };
}
