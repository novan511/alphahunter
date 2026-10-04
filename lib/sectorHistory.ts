/**
 * Sector history — ring buffer of per-sector snapshots across scans.
 *
 * Why this exists: `buildSectorHeat()` answers "which sector is hot NOW" from
 * a single scan. A real early warning needs the time dimension: is this
 * sector *getting hotter*, did it just flip phase, does it persist? That
 * requires remembering past snapshots.
 *
 * Storage is localStorage-first (works with zero backend, accumulates
 * immediately). Supabase already stores full rankings per scan, so a future
 * server-side version can rebuild this remotely — the point shape is kept
 * small and JSON-safe on purpose.
 */

import type { CategoryId } from './assetCategory';
import type { SectorHeat, SectorPhase } from './algorithms/narrativeHeat';

export interface SectorPoint {
  /** ms epoch of the scan that produced this point. */
  t: number;
  heat: number;
  earlyScore: number;
  phase: SectorPhase;
  members: number;
  buyCount: number;
  sellCount: number;
  thrust: number;
  /** Top tickers at that time, for "who led it then" reads. */
  leaders: string[];
}

export type SectorHistory = Partial<Record<CategoryId, SectorPoint[]>>;

const KEY = 'althunter:sector-history:v1';
/** Points kept per sector. ~60 scans is plenty for velocity + persistence. */
const MAX_POINTS = 60;
/** Two writes within the same minute are the same scan — dedupe. */
const DEDUPE_MS = 60_000;

export function loadSectorHistory(): SectorHistory {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as SectorHistory;
    if (!parsed || typeof parsed !== 'object') return {};
    // Trim + validate defensively; a corrupt buffer must not break the page.
    const out: SectorHistory = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (!Array.isArray(v)) continue;
      out[k as CategoryId] = v
        .filter((p) => p && typeof p.t === 'number' && typeof p.heat === 'number')
        .slice(-MAX_POINTS);
    }
    return out;
  } catch {
    return {};
  }
}

function saveSectorHistory(h: SectorHistory): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(h));
  } catch {
    // full / private mode — history just doesn't persist
  }
}

/**
 * Append one scan's sectors. Returns the updated history.
 * Skips the write when the newest point is < 60s old (same scan re-render).
 */
export function recordSectorSnapshot(
  sectors: SectorHeat[],
  scannedAt: number = Date.now()
): SectorHistory {
  const h = loadSectorHistory();
  for (const s of sectors) {
    const pts = h[s.id] ?? [];
    const last = pts[pts.length - 1];
    if (last && Math.abs(scannedAt - last.t) < DEDUPE_MS) continue;
    pts.push({
      t: scannedAt,
      heat: s.heat,
      earlyScore: s.earlyScore,
      phase: s.phase,
      members: s.members,
      buyCount: s.buyCount,
      sellCount: s.sellCount,
      thrust: Math.round(s.thrust * 1000) / 1000,
      leaders: s.leaders.slice(0, 3),
    });
    h[s.id] = pts.slice(-MAX_POINTS);
  }
  saveSectorHistory(h);
  return h;
}

/** Previous point before the latest, or null when there is no past. */
export function prevPoint(h: SectorHistory, id: CategoryId): SectorPoint | null {
  const pts = h[id];
  if (!pts || pts.length < 2) return null;
  return pts[pts.length - 2];
}

/**
 * Consecutive-scan streak of `phase` ending at the latest point.
 * e.g. streak(h,'ai','early') === 3 means early for the last 3 scans.
 */
export function phaseStreak(h: SectorHistory, id: CategoryId, phase: SectorPhase): number {
  const pts = h[id];
  if (!pts || pts.length === 0) return 0;
  let n = 0;
  for (let i = pts.length - 1; i >= 0; i--) {
    if (pts[i].phase === phase) n++;
    else break;
  }
  return n;
}

/**
 * Velocity of earlyScore per scan step over the last `steps` points.
 * Positive = heating up. Null when there aren't enough points.
 */
export function earlyVelocity(
  h: SectorHistory,
  id: CategoryId,
  steps = 2
): number | null {
  const pts = h[id];
  if (!pts || pts.length < steps + 1) return null;
  const a = pts[pts.length - 1 - steps].earlyScore;
  const b = pts[pts.length - 1].earlyScore;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (b - a) / steps;
}

/** Heat velocity, same shape — used for the "confirmed but accelerating" case. */
export function heatVelocity(
  h: SectorHistory,
  id: CategoryId,
  steps = 2
): number | null {
  const pts = h[id];
  if (!pts || pts.length < steps + 1) return null;
  const a = pts[pts.length - 1 - steps].heat;
  const b = pts[pts.length - 1].heat;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (b - a) / steps;
}
