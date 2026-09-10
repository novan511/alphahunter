/**
 * Lightweight event filter (paper-inspired news/event risk).
 * No live news feed yet — uses calendar heuristics + optional holiday list.
 * Goal: on high-event days, skip entries or scale size down.
 */

export interface EventFilterResult {
  allowEntries: boolean;
  sizeScale: number;
  reason: string;
}

/** Known high-volatility US macro days (UTC date YYYY-MM-DD). Extend as needed. */
const HIGH_IMPACT_DATES = new Set<string>([
  // leave empty or fill manually — heuristics below still apply
]);

function utcDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isWeekend(d: Date): boolean {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

/**
 * Heuristic event filter:
 * - weekend: crypto still trades; commodities/FX quieter → milder scale
 * - first Monday of month (US jobs week proxy): reduce size
 * - custom HIGH_IMPACT_DATES: block new entries
 * - optional blocklist dates from env-style list passed in
 */
export function evaluateEventFilter(
  marketId: string,
  now: Date = new Date(),
  extraBlockDates: string[] = []
): EventFilterResult {
  const key = utcDateKey(now);
  const block = new Set<string>(HIGH_IMPACT_DATES);
  extraBlockDates.forEach((d) => block.add(d));

  if (block.has(key)) {
    return {
      allowEntries: false,
      sizeScale: 0,
      reason: `high-impact event date ${key} — no new entries`,
    };
  }

  // First Monday-ish of month (UTC weekday Mon and day <= 7)
  const isFirstWeek = now.getUTCDate() <= 7;
  const isMonday = now.getUTCDay() === 1;

  if (isFirstWeek && isMonday) {
    return {
      allowEntries: true,
      sizeScale: 0.6,
      reason: 'start-of-month macro week — size reduced',
    };
  }

  if (isWeekend(now) && marketId !== 'crypto') {
    return {
      allowEntries: true,
      sizeScale: 0.5,
      reason: 'weekend — thinner books for commodities/FX',
    };
  }

  return {
    allowEntries: true,
    sizeScale: 1,
    reason: 'no special event flag',
  };
}
