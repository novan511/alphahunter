/**
 * Calibration: what the forward record actually says about each setup.
 *
 * Reads only stored outcomes (r + outcome), never a simulation, so the number
 * is a fact about signals that really fired.
 *
 * The gate is the whole point. With a fixed 2R target, a bucket needs a 95%
 * confidence interval that excludes zero before anything is called an edge:
 * at n=30 and p=0.5 the win-rate interval is roughly ±18 points, so publishing
 * "+0.4R" at that sample size would dress noise as a base rate. Below the
 * sample floor nothing is published at all.
 *
 * Pure: no clock, no network. Self-checked in scripts/smoke-calibration.ts.
 */

/** Minimum decided trades before a bucket number is shown at all. */
export const MIN_SAMPLE = 30;

const Z_95 = 1.96;

/** Buckets are deliberately coarse: fine buckets never reach a usable sample. */
export const SIGNAL_ORDER = ['strong_buy', 'buy', 'strong_sell', 'sell'] as const;

export interface CalibrationRow {
  signal: string;
  outcome: string | null;
  r: number | null;
}

export interface Interval {
  lo: number;
  hi: number;
}

export interface BucketStats {
  signal: string;
  /** Decided trades (target | stop). The only rows the rates are built from. */
  n: number;
  wins: number;
  winRate: number | null;
  winRateCi: Interval | null;
  expectancyR: number | null;
  expectancyCi: Interval | null;
  /** n is sufficient *and* the expectancy interval excludes zero. */
  conclusive: boolean;
  /** Time exits and unscorable paths: reported separately, never mixed in. */
  open: number;
  lost: number;
  /** Undecided rows (still inside their hold window). */
  pending: number;
}

/** Mean with a 95% normal interval. Null when there is nothing to average. */
export function meanInterval(values: number[]): (Interval & { mean: number }) | null {
  const n = values.length;
  if (n === 0) return null;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n === 1) return { mean, lo: mean, hi: mean };
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const se = Math.sqrt(variance / n);
  return { mean, lo: mean - Z_95 * se, hi: mean + Z_95 * se };
}

/**
 * Aggregate decided rows per signal. Undecided and lost rows are counted but
 * excluded from every rate — a trade that never resolved is not evidence of
 * anything, and folding it in either way would move the number without basis.
 */
export function bucketStats(rows: CalibrationRow[]): BucketStats[] {
  const bySignal = new Map<string, CalibrationRow[]>();
  for (const row of rows) {
    const list = bySignal.get(row.signal);
    if (list) list.push(row);
    else bySignal.set(row.signal, [row]);
  }

  const stats: BucketStats[] = [];
  for (const [signal, group] of Array.from(bySignal.entries())) {
    const decided = group.filter(
      (row: CalibrationRow) =>
        (row.outcome === 'target' || row.outcome === 'stop') && row.r != null
    );
    const rs = decided.map((row: CalibrationRow) => row.r as number);
    const n = decided.length;
    const wins = decided.filter((row: CalibrationRow) => row.outcome === 'target').length;

    // Expectancy is the mean of the stored R, never a formula over win rate:
    // gaps and time exits make the two differ, and the mean is the real number.
    const exp = meanInterval(rs);
    const winRate = n > 0 ? wins / n : null;
    const winSe = n > 0 ? Math.sqrt((winRate as number) * (1 - (winRate as number)) / n) : 0;

    stats.push({
      signal,
      n,
      wins,
      winRate,
      winRateCi: winRate == null ? null : { lo: winRate - Z_95 * winSe, hi: winRate + Z_95 * winSe },
      expectancyR: exp?.mean ?? null,
      expectancyCi: exp ? { lo: exp.lo, hi: exp.hi } : null,
      conclusive: n >= MIN_SAMPLE && exp != null && exp.lo > 0,
      open: group.filter((row: CalibrationRow) => row.outcome === 'open').length,
      lost: group.filter((row: CalibrationRow) => row.outcome === 'lost').length,
      pending: group.filter((row: CalibrationRow) => row.outcome == null).length,
    });
  }

  const rank = (s: string) => {
    const i = (SIGNAL_ORDER as readonly string[]).indexOf(s);
    return i === -1 ? SIGNAL_ORDER.length : i;
  };
  return stats.sort((a, b) => rank(a.signal) - rank(b.signal) || a.signal.localeCompare(b.signal));
}

/** True once any bucket may be quoted. Callers use it to suppress numbers. */
export function hasConclusiveBucket(buckets: BucketStats[]): boolean {
  return buckets.some((b) => b.conclusive);
}

/**
 * One line per bucket for the AI context. A bucket that has not cleared the bar
 * says so in words and prints no rate at all: the model would otherwise quote a
 * number from its context as an edge, which is exactly what the gate exists to
 * prevent. It also names *why* it is not conclusive, so "n=40 from 30" is never
 * labelled as a missing sample.
 */
export function calibrationLines(buckets: BucketStats[]): string[] {
  return buckets.map((b) => {
    const label = b.signal.replace(/_/g, ' ');
    const extras = [
      `${b.open} waktu habis`,
      `${b.lost} hilang`,
      `${b.pending} menunggu`,
    ].join(', ');

    if (!b.conclusive) {
      const why =
        b.n < MIN_SAMPLE
          ? `sampel belum cukup (n=${b.n} dari ${MIN_SAMPLE})`
          : 'interval keyakinan masih menyentuh nol';
      return `${label}: belum konklusif (${why}) — ${extras}. Jangan sebut angka win rate/expectancy untuk setup ini.`;
    }

    return (
      `${label}: n=${b.n}, win ${((b.winRate as number) * 100).toFixed(0)}% ` +
      `(95% CI ${(b.winRateCi!.lo * 100).toFixed(0)}..${(b.winRateCi!.hi * 100).toFixed(0)}%), ` +
      `expectancy ${b.expectancyR! >= 0 ? '+' : ''}${b.expectancyR!.toFixed(2)}R ` +
      `(95% CI ${b.expectancyCi!.lo.toFixed(2)}..${b.expectancyCi!.hi.toFixed(2)}) — ${extras}`
    );
  });
}
