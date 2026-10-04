/**
 * Scan history.
 *
 * Two sources are merged into one timeline:
 *   1. `scan_history` in Supabase (long-lived, survives new devices) via
 *      /api/scans-history — but only its *summary* columns, never `results`,
 *      which is hundreds of KB per row.
 *   2. A local ring buffer in localStorage, so the panel still works when
 *      Supabase is unconfigured and so history starts accumulating immediately.
 *
 * Summary strings look like `ETH(72.1), BTC(65.0)` — the top 20 signals the
 * save path already writes. That is enough to answer "is this coin persisting?"
 * without pulling full rankings.
 */

export interface ScanHistoryEntry {
  scannedAt: number;
  indexSymbol: string;
  regimeLabel: string | null;
  /** Non-neutral signals in that scan. */
  signalsCount: number;
  totalScanned: number;
  /** Bare tickers that were BUY (parse of buy_signals_summary). */
  buys: string[];
  /** Bare tickers that were SELL. */
  sells: string[];
}

export interface ScanHistoryResponse {
  configured: boolean;
  entries: ScanHistoryEntry[];
}

const LOCAL_KEY = 'althunter:scan-history:v1';
/** Local buffer cap. Old entries drop off; Supabase keeps the long tail. */
const LOCAL_MAX = 40;

/** `ETH(72.1), BTC(65.0)` → `['ETH', 'BTC']`, tolerating junk. */
export function parseSignalSummary(summary: string | null | undefined): string[] {
  if (!summary) return [];
  return summary
    .split(',')
    .map((part) => {
      // Strip the score suffix and any surrounding whitespace.
      const name = part.replace(/\(.*$/, '').trim();
      return name;
    })
    .filter((name) => name.length > 0 && name.length <= 24);
}

export function loadLocalScanHistory(): ScanHistoryEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(LOCAL_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (e): e is ScanHistoryEntry =>
          !!e && typeof e.scannedAt === 'number' && Array.isArray(e.buys)
      )
      .slice(0, LOCAL_MAX);
  } catch {
    return [];
  }
}

export function saveLocalScanHistory(entries: ScanHistoryEntry[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      LOCAL_KEY,
      JSON.stringify(entries.slice(0, LOCAL_MAX))
    );
  } catch {
    // full / private mode — history simply doesn't grow locally
  }
}

/**
 * Append a scan, deduping by scan minute (two sources writing the same scan
 * must not double-count it) and keeping the timeline newest-first.
 */
export function recordScan(entry: ScanHistoryEntry): ScanHistoryEntry[] {
  const minute = Math.floor(entry.scannedAt / 60000);
  const existing = loadLocalScanHistory();
  const merged = [entry, ...existing.filter(
    (e) => Math.floor(e.scannedAt / 60000) !== minute
  )];
  merged.sort((a, b) => b.scannedAt - a.scannedAt);
  saveLocalScanHistory(merged);
  return merged.slice(0, LOCAL_MAX);
}

/** Merge remote + local, dedupe by minute, newest first. */
export function mergeHistory(
  remote: ScanHistoryEntry[],
  local: ScanHistoryEntry[]
): ScanHistoryEntry[] {
  const seen = new Set<number>();
  const out: ScanHistoryEntry[] = [];
  for (const e of [...remote, ...local].sort((a, b) => b.scannedAt - a.scannedAt)) {
    const minute = Math.floor(e.scannedAt / 60000);
    if (seen.has(minute)) continue;
    seen.add(minute);
    out.push(e);
  }
  return out;
}

/**
 * How many consecutive recent scans (newest first) an asset kept showing up as
 * a BUY. A coin that keeps reappearing is a rotating narrative; one that
 * appeared once and vanished was noise.
 */
export function buyStreak(entries: ScanHistoryEntry[], asset: string): number {
  let streak = 0;
  for (const e of entries) {
    if (e.buys.includes(asset)) streak++;
    else break;
  }
  return streak;
}

export async function fetchScanHistory(
  indexSymbol: string
): Promise<ScanHistoryEntry[]> {
  try {
    const res = await fetch(
      `/api/scans-history?index=${encodeURIComponent(indexSymbol)}&limit=30`
    );
    if (!res.ok) return [];
    const data = (await res.json()) as ScanHistoryResponse;
    if (!data?.configured || !Array.isArray(data.entries)) return [];
    return data.entries;
  } catch {
    return [];
  }
}
