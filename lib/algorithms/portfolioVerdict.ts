/**
 * Portfolio verdict: what to HOLD, what to DROP.
 *
 * This is the rotation decision, not the entry decision.
 *
 * Entry says "this coin has a tradeable setup right now" (tradeable.ts).
 * Hold/drop says "of what you already carry, which is still earning its slot
 * in the basket". Those are different questions and conflating them is how
 * people sell the bottom of their own rotation.
 *
 * The rule
 * --------
 * A coin is only a DROP candidate if it underperforms the basket AND that
 * underperformance is confirmed, not provisional:
 *
 *   dominance < threshold          → losing to the basket
 *   rank in the bottom third       → losing to its peers, not just to BTC
 *   extensionZ is NOT deeply neg   → not merely "pulled back from a spike",
 *                                    which is a recovery setup, not a drop
 *
 * The last clause is the one that matters. A coin sitting 1.5σ below its own
 * basket trend is resting. The same coin at -3σ is falling knife territory
 * only if the trend itself is intact; if the whole basket is down, that is a
 * market event, not a coin failure.
 *
 * Everything here is relative to the basket, so a HOLD means "still the best
 * place for this money among these coins" — not "buy".
 */

import { CorrMatrix, CoinProfile, classifyStrength } from './correlationMatrix';

export type HoldAction = 'HOLD_STRONG' | 'HOLD' | 'TRIM' | 'DROP' | 'WATCH';

export interface HoldVerdict {
  symbol: string;
  action: HoldAction;
  /** Plain-language reason, safe to send over Telegram. */
  reason: string;
  dominance: number;
  rank: number;
  extensionZ: number;
  /** Rank change vs the previous snapshot, when history exists. Positive = fell. */
  rankDelta: number | null;
  /** Bars spent below the basket — how persistent the weakness is. */
  weakBars: number | null;
}

export interface PortfolioPlan {
  verdicts: HoldVerdict[];
  /** Symbols worth acting on, best first. */
  toDrop: HoldVerdict[];
  toHold: HoldVerdict[];
  /** Basket-wide context, so a "DROP" is not read in isolation. */
  context: {
    basketCorr: number;
    basketDirection: 'all_up' | 'all_down' | 'mixed';
    leader: string | null;
    laggard: string | null;
    window: string;
  };
}

/** Dominance below this = losing to the basket. */
const WEAK_DOMINANCE = -1.5;
/**
 * Below this the coin has clearly lost its slot and is a drop regardless of
 * confirmation. Calibrated against the 30-bar window where a one-sigma move
 * is roughly this much; tighter would cut winners on ordinary noise.
 */
const SEVERE_DOMINANCE = -5;
/**
 * The "drop zone" is the bottom third by rank, counting down from the worst
 * rank. Computed from the end rather than as a fraction of n: with n=4 a
 * floor(n*0.34) threshold flagged 3 of 4 coins as bottom-ranked, which would
 * make a DROP verdict mean nothing. n - max(1, n/3) gives 1 of 4, 2 of 6,
 * 3 of 10.
 */
function dropZoneStart(n: number): number {
  return n - Math.max(1, Math.floor(n / 3));
}

interface HistoryRow {
  symbol: string;
  created_at: string;
  dominance: number | null;
  dominance_rank: number | null;
}

/**
 * Count consecutive snapshots where a coin sat below the weakness threshold,
 * newest-first. Returns null when there is no history to judge persistence.
 */
function weakStreak(
  symbol: string,
  history: HistoryRow[],
  snapshotTimes: string[],
): number | null {
  const byTime = new Map<string, HistoryRow>();
  for (const r of history) {
    if (r.symbol === symbol) byTime.set(r.created_at, r);
  }
  let n = 0;
  for (const t of snapshotTimes) {
    const row = byTime.get(t);
    if (!row || row.dominance == null) break;
    if (row.dominance >= WEAK_DOMINANCE) break;
    n++;
  }
  return n > 0 ? n : null;
}

/** Rank in the most recent snapshot before the one we are judging. */
function previousRank(symbol: string, history: HistoryRow[], currentTime: string): number | null {
  const rows = history
    .filter((r) => r.symbol === symbol && r.dominance_rank != null && r.created_at !== currentTime)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return rows.length > 0 ? rows[0].dominance_rank : null;
}

export function buildPortfolioPlan(
  matrix: CorrMatrix,
  history: HistoryRow[] = [],
): PortfolioPlan {
  const n = matrix.coins.length;
  if (n === 0) {
    return {
      verdicts: [],
      toDrop: [],
      toHold: [],
      context: {
        basketCorr: matrix.basketCorr,
        basketDirection: 'mixed',
        leader: null,
        laggard: null,
        window: `${matrix.interval} × ${matrix.window}`,
      },
    };
  }

  const sorted = [...matrix.coins].sort((a, b) => a.dominanceRank - b.dominanceRank);
  const leader = sorted[0];
  const laggard = sorted[n - 1];

  // Basket direction from absolute return, not dominance — a basket can have a
  // clear winner while every single coin is down.
  const totalRets = matrix.coins.map((c) => c.totalReturn);
  const allDown = totalRets.length > 0 && totalRets.every((r) => r < 0);
  const allUp = totalRets.length > 0 && totalRets.every((r) => r > 0);
  const basketDirection = allDown ? 'all_down' : allUp ? 'all_up' : 'mixed';

  // Newest-first distinct snapshot times, so persistence reads forward in time.
  const snapshotTimes = Array.from(new Set(history.map((r) => r.created_at))).sort().reverse();
  const currentTime = snapshotTimes[0] ?? '';

  const verdicts: HoldVerdict[] = sorted.map((c: CoinProfile) => {
    const strength = classifyStrength(c);
    const rank = c.dominanceRank;
    const bottomZone = n > 2 && rank >= dropZoneStart(n);
    const weak = c.dominance <= WEAK_DOMINANCE;
    const prevRank = previousRank(c.symbol, history, currentTime);
    // Positive = fell since the last snapshot. Null when there is no history.
    const rankDelta = prevRank == null ? null : rank - prevRank;
    const streak = weakStreak(c.symbol, history, snapshotTimes);
    const persistent = streak != null && streak >= 2;
    const deepBelowTrend = c.extensionZ <= -3;

    let action: HoldAction;
    let reason: string;

    // Severity scales with how far the coin has lost its slot. Dominance is
    // already "distance below the basket", so the bands read directly:
    // barely below → trim, clearly below → drop.
    if (basketDirection === 'all_down' && weak) {
      // Everything is red. Calling that a coin failure is how you sell the
      // bottom of your own rotation.
      action = 'WATCH';
      reason = 'seluruh basket turun — market event, bukan kegagalan koin';
    } else if (deepBelowTrend && c.dominance > SEVERE_DOMINANCE) {
      action = 'WATCH';
      reason = 'turun dalam dari trennya sendiri, belum ada konfirmasi pulih';
    } else if (c.dominance <= SEVERE_DOMINANCE) {
      action = 'DROP';
      reason = persistent
        ? `kalah basket ${streak}x berturut, belum ada pemulihan`
        : 'kalah basket jauh, tidak layak tahan';
    } else if (weak && bottomZone && persistent) {
      // Newly weak alone is not enough — wait for it to persist.
      action = 'DROP';
      reason = `kalah basket ${streak}x berturut dan tertinggal dari rekan`;
    } else if (weak && bottomZone) {
      action = 'WATCH';
      reason = 'baru mulai kalah basket — tunggu konfirmasi sebelum buang';
    } else if (weak) {
      action = 'TRIM';
      reason = 'sedikit di bawah basket — kurangi porsi, belum layak dibuang';
    } else if (strength.label === 'LEAD' || strength.label === 'STRONG') {
      action = 'HOLD_STRONG';
      reason =
        c.extensionZ >= 2
          ? 'pemimpin basket, meski sudah panjang — tahan, jangan tambah'
          : 'pemimpin basket, belum overextended';
    } else if (c.dominance > 0) {
      action = 'HOLD';
      reason = 'masih di atas basket, layak dipertahankan';
    } else {
      // Slightly negative but above the weakness threshold: flat, not losing.
      // Saying "di atas basket" here would be a lie — dominance is negative.
      action = 'HOLD';
      reason = 'nyaris datar dengan basket — belum ada alasan untuk kurangi';
    }

    return {
      symbol: c.symbol,
      action,
      reason,
      dominance: c.dominance,
      rank,
      extensionZ: c.extensionZ,
      rankDelta,
      weakBars: streak,
    };
  });

  return {
    verdicts,
    toDrop: verdicts.filter((v) => v.action === 'DROP'),
    toHold: verdicts.filter((v) => v.action === 'HOLD_STRONG' || v.action === 'HOLD'),
    context: {
      basketCorr: matrix.basketCorr,
      basketDirection,
      leader: leader.symbol,
      laggard: laggard.symbol,
      window: `${matrix.interval} × ${matrix.window}`,
    },
  };
}

const ACTION_LABEL: Record<HoldAction, string> = {
  HOLD_STRONG: 'TAHAN (pemimpin)',
  HOLD: 'TAHAN',
  TRIM: 'KURANGI',
  DROP: 'BUANG',
  WATCH: 'PANTAU',
};

const ACTION_ICON: Record<HoldAction, string> = {
  HOLD_STRONG: '🟢',
  HOLD: '🔵',
  TRIM: '🟡',
  DROP: '🔴',
  WATCH: '⚪',
};

/** Compact verdict line for a Telegram message. */
export function formatVerdict(v: HoldVerdict): string {
  const icon = ACTION_ICON[v.action];
  const delta =
    v.rankDelta != null && v.rankDelta !== 0
      ? v.rankDelta > 0
        ? ` (turun ${v.rankDelta} peringkat)`
        : ` (naik ${Math.abs(v.rankDelta)} peringkat)`
      : '';
  return `${icon} ${bare(v.symbol)} — ${ACTION_LABEL[v.action]}${delta} · dom ${v.dominance >= 0 ? '+' : ''}${v.dominance.toFixed(2)}%`;
}

/**
 * Full rotation digest. Deliberately says "tahan" not "beli": this ranks what
 * you already hold. Entries come from the tradeable list, which is a separate
 * gate, and the message keeps the two apart so nobody reads a HOLD as an entry.
 */
export function buildRotationDigest(plan: PortfolioPlan): string {
  const { context, verdicts } = plan;
  const lines: string[] = [];

  const dir =
    context.basketDirection === 'all_down'
      ? 'seluruh basket turun'
      : context.basketDirection === 'all_up'
        ? 'seluruh basket naik'
        : 'terbagi';
  lines.push(`ROTASI ${context.window} · korelasi ${context.basketCorr.toFixed(2)} · ${dir}`);

  if (context.leader && context.laggard) {
    lines.push(`Terkuat ${bare(context.leader)} · Terlemah ${bare(context.laggard)}`);
  }
  lines.push('');

  const hold = verdicts.filter((v) => v.action === 'HOLD_STRONG' || v.action === 'HOLD');
  const trim = verdicts.filter((v) => v.action === 'TRIM');
  const drop = verdicts.filter((v) => v.action === 'DROP');
  const watch = verdicts.filter((v) => v.action === 'WATCH');

  if (hold.length > 0) {
    lines.push('TAHAN:');
    for (const v of hold.slice(0, 5)) lines.push(`  ${formatVerdict(v)}`);
  }
  if (trim.length > 0) {
    lines.push('KURANGI:');
    for (const v of trim.slice(0, 4)) lines.push(`  ${formatVerdict(v)}`);
  }
  if (drop.length > 0) {
    lines.push('BUANG:');
    for (const v of drop.slice(0, 4)) lines.push(`  ${formatVerdict(v)} — ${v.reason}`);
  }
  if (watch.length > 0) {
    lines.push('PANTAU:');
    for (const v of watch.slice(0, 4)) lines.push(`  ${formatVerdict(v)}`);
  }

  lines.push('');
  lines.push('Tahan/kurangi = soal posisi yang sudah kamu punya. Untuk entry baru, tanya /top.');
  return lines.join('\n').slice(0, 3900);
}

function bare(sym: string): string {
  return (sym.includes(':') ? sym.slice(sym.indexOf(':') + 1) : sym).replace(/USDT$|USDC$/, '');
}