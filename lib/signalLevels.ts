/**
 * Signal levels: the one place that turns an emitted signal into a stop, a
 * target, and (later) a realised R-multiple.
 *
 * The convention is fixed and versioned on purpose. Win rate is a function of
 * where the stop sits, so a stop we could tune would let us pick a flattering
 * win rate and call it calibration. A constant risk definition makes the number
 * mean the same thing for every signal. Changing the rule means minting a new
 * convention string, never editing rows already scored.
 *
 * Everything here is pure: no network, no clock except an injected `nowMs`, so
 * the outcome of a row can be reproduced from its own stored candles.
 *
 * Rules in docs/superpowers/specs/2026-10-18-signal-calibration-design.md.
 */

import type { Candle } from './types';

export const LEVEL_CONVENTION = 'atr1.5-2R-v1';

/** Stop distance, in ATR from entry. Never tuned. */
export const ATR_STOP_MULT = 1.5;

/** Target distance, in multiples of the stop distance. Fixed so win rate is comparable. */
export const TARGET_R = 2;

export const FOUR_H_BAR_SEC = 4 * 3_600;
export const MAX_HOLD_SEC = 7 * 24 * 3_600;

export interface Levels {
  stop: number;
  target: number;
  convention: string;
}

/**
 * Stop at 1.5 ATR beyond entry, target at 2R. Null when the row has no usable
 * entry or ATR — an unlevelled row is excluded from calibration rather than
 * scored against an invented risk.
 */
export function levelsFor(
  direction: 'long' | 'short',
  entry: number | null | undefined,
  atr: number | null | undefined
): Levels | null {
  if (entry == null || atr == null) return null;
  if (!Number.isFinite(entry) || entry <= 0) return null;
  if (!Number.isFinite(atr) || atr <= 0) return null;

  const risk = ATR_STOP_MULT * atr;
  const stop = direction === 'long' ? entry - risk : entry + risk;
  const target = direction === 'long' ? entry + TARGET_R * risk : entry - TARGET_R * risk;
  // A long whose stop lands at or below zero cannot be represented, and a stop
  // on the wrong side of entry would make R meaningless. Leave it unlevelled.
  if (!(stop > 0) || !(target > 0)) return null;
  if (direction === 'long' ? stop >= entry : stop <= entry) return null;

  return { stop, target, convention: LEVEL_CONVENTION };
}

export type ROutcome = 'target' | 'stop' | 'open' | 'lost';

export interface TouchResult {
  outcome: ROutcome;
  /** Null only for `lost`: no R can honestly be computed from a partial path. */
  r: number | null;
  /** Bars consumed until the touch, or the length of the window on a time exit. */
  bars: number;
}

export interface TouchOptions {
  holdSec?: number;
  barSec?: number;
  nowSec?: number;
}

/**
 * Walk the candle path after `emittedSec` (candle times are in seconds) and
 * report the first decisive event.
 *
 * Returns null when nothing is decided yet (still inside the hold window, or no
 * bar has opened since entry) — the caller must leave the row unscored and try
 * again later. Scoring a live trade would freeze a number the next candle can
 * invalidate, and that first write is permanent.
 *
 * `lost` means the path cannot be trusted: its start is gone, a bar is missing
 * from the middle, or the series stops before the window ends. A row that cannot
 * be walked end to end is never scored — the missing bars are exactly where a
 * stop would have been touched.
 */
export function firstTouch(
  candles: Candle[],
  direction: 'long' | 'short',
  entry: number,
  stop: number,
  target: number,
  emittedSec: number,
  opts: TouchOptions = {}
): TouchResult | null {
  const holdSec = opts.holdSec ?? MAX_HOLD_SEC;
  const barSec = opts.barSec ?? FOUR_H_BAR_SEC;
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);

  const risk = direction === 'long' ? entry - stop : stop - entry;
  if (!(risk > 0) || !Number.isFinite(emittedSec)) return null;
  const rOf = (exit: number) =>
    direction === 'long' ? (exit - entry) / risk : (entry - exit) / risk;

  const deadline = emittedSec + holdSec;
  const LOST: TouchResult = { outcome: 'lost', r: null, bars: 0 };

  if (candles.length > 0) {
    let earliest = Infinity;
    let latest = -Infinity;
    for (const c of candles) {
      if (c.time < earliest) earliest = c.time;
      if (c.time > latest) latest = c.time;
    }
    // The beginning of the path is gone, so a touch may have happened unseen.
    if (earliest - emittedSec > barSec) return LOST;
    // The series stops before the window closes (delisting, halted pair): the
    // final bars — where a stop or target would most likely land — do not exist.
    if (nowSec >= deadline && latest < deadline - barSec) return LOST;
  }

  // Bars that opened before emit are excluded: the bar the signal fired on can
  // contain price action from *before* entry, and counting its low as a stop-out
  // would invent losses that never happened. Cost of the rule: a stop hit inside
  // the entry bar itself is not visible. That asymmetry is known and accepted.
  //
  // The window is half-open [emit, emit+hold): a bar opening exactly on the
  // deadline sits entirely after it, so its lows are not part of the trade.
  const path = candles.filter((c) => c.time >= emittedSec && c.time < deadline);
  if (path.length === 0) return null;

  for (let i = 0; i < path.length; i++) {
    // A missing bar is a hole in the path: whatever happened inside it cannot be
    // seen, and walking straight past it would quietly delete a stop-out.
    if (i > 0 && path[i].time - path[i - 1].time > barSec * 1.5) return LOST;

    const c = path[i];
    // Pessimistic on both sides. A bar that could have touched both levels is
    // recorded as a stop; a level gapped through fills at the open when that is
    // the worse price, and at the level when the open would flatter it.
    if (direction === 'long') {
      if (c.low <= stop) return { outcome: 'stop', r: rOf(Math.min(c.open, stop)), bars: i + 1 };
      if (c.high >= target) return { outcome: 'target', r: rOf(target), bars: i + 1 };
    } else {
      if (c.high >= stop) return { outcome: 'stop', r: rOf(Math.max(c.open, stop)), bars: i + 1 };
      if (c.low <= target) return { outcome: 'target', r: rOf(target), bars: i + 1 };
    }
  }

  // Still inside the hold window with nothing touched: undecided, not a result.
  if (nowSec < deadline) return null;

  // Time exit at the close of the last bar sitting *fully* inside the window.
  // Using the newest available close would give the same row different answers
  // depending on when the scorer ran.
  const inside = path.filter((c) => c.time + barSec <= deadline);
  const last = inside[inside.length - 1] ?? path[path.length - 1];
  return { outcome: 'open', r: rOf(last.close), bars: path.length };
}
