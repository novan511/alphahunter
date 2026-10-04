/**
 * Early warning engine: sector X is about to move + which coins lead it.
 *
 * Inputs are all derived from the current scan — no new API, no fake history:
 *   - `sectors`  : this scan's sector read (buildSectorHeat)
 *   - `history`  : past sector snapshots (sectorHistory, includes this scan)
 *   - `rankings` : this scan's per-coin results (for candidate coins)
 *
 * Alert kinds, in priority order:
 *   1. `breakout`    — phase flipped weak/building → early (the actual warning)
 *   2. `confirmed`    — early → confirmed (trend now underway, chase warning)
 *   3. `acceleration`— still early/building but earlyScore velocity is steep
 *   4. `persistent`   — early for N straight scans (rotation is holding)
 *   5. `watch`        — building with rising velocity (heads-up, not a call)
 *
 * Every alert carries candidate coins: tradeable names in that sector first
 * (they passed liquidity + confluence gates), then watchlist near-misses.
 * An alert without coins is a horoscope — the coins are the point.
 */

import type { CategoryId } from '../assetCategory';
import type { SectorHeat } from './narrativeHeat';
import type { MultiTimeframeResult } from './multiTimeframe';
import { buildTradeableList } from './tradeable';
import {
  prevPoint,
  phaseStreak,
  earlyVelocity,
  type SectorHistory,
} from '../sectorHistory';

export type WarningSeverity = 'high' | 'medium' | 'info';
export type WarningKind =
  | 'breakout'
  | 'confirmed'
  | 'acceleration'
  | 'persistent'
  | 'watch';

export interface CandidateCoin {
  asset: string;
  ticker: string;
  signal: MultiTimeframeResult['finalSignal'];
  confluenceScore: number;
  tradability: number | null;
  riskTier: string;
  /** 'trade' = passed gates, 'watch' = trend present, trigger absent. */
  source: 'trade' | 'watch';
}

export interface EarlyWarning {
  /** Stable across re-renders: sector + kind. Used for dimissal + notify dedupe. */
  id: string;
  kind: WarningKind;
  severity: WarningSeverity;
  sectorId: CategoryId;
  sectorLabel: string;
  sectorIcon: string;
  sectorColor: string;
  title: string;
  detail: string;
  /** 0-100 urgency, for sorting. Not a price target, just ordering. */
  urgency: number;
  coins: CandidateCoin[];
  earlyScore: number;
  heat: number;
  velocity: number | null;
  streak: number;
}

const KIND_RANK: Record<WarningKind, number> = {
  breakout: 0,
  confirmed: 1,
  acceleration: 2,
  persistent: 3,
  watch: 4,
};

/** Thin samples can inform a watch note but must never fire a real warning. */
function solid(s: SectorHeat): boolean {
  return s.members >= 3 && !s.thinSample;
}

function candidateCoins(
  sectorId: CategoryId,
  rankings: MultiTimeframeResult[]
): CandidateCoin[] {
  const inSector = rankings.filter((r) => (r.category ?? 'other') === sectorId);
  const { trades, watchlist } = buildTradeableList(inSector, {});
  const tradeTickers = new Set(trades.map((t) => t.asset));

  const out: CandidateCoin[] = [
    ...trades.slice(0, 4).map((t) => ({
      asset: t.asset,
      ticker: t.ticker,
      signal: t.signal,
      confluenceScore: t.confluenceScore,
      tradability: t.tradability,
      riskTier: t.riskTier,
      source: 'trade' as const,
    })),
  ];
  // Fill up to 6 with watchlist names not already listed as trades.
  for (const w of watchlist) {
    if (out.length >= 6) break;
    if (tradeTickers.has(w.asset)) continue;
    const r = inSector.find((x) => x.asset === w.asset);
    out.push({
      asset: w.asset,
      ticker: w.ticker,
      signal: r?.finalSignal ?? 'neutral',
      confluenceScore: w.confluenceScore,
      tradability: null,
      riskTier: w.riskTier,
      source: 'watch',
    });
  }
  return out;
}

export function buildEarlyWarnings(
  sectors: SectorHeat[],
  history: SectorHistory,
  rankings: MultiTimeframeResult[]
): EarlyWarning[] {
  const out: EarlyWarning[] = [];

  for (const s of sectors) {
    if (s.members === 0) continue;
    const prev = prevPoint(history, s.id);
    const vel = earlyVelocity(history, s.id, 2);
    const streakEarly = phaseStreak(history, s.id, 'early');
    const coins = candidateCoins(s.id, rankings);
    const base = {
      sectorId: s.id,
      sectorLabel: s.label,
      sectorIcon: s.icon,
      sectorColor: s.color,
      earlyScore: s.earlyScore,
      heat: s.heat,
      velocity: vel,
      streak: streakEarly,
    };

    // 1. Fresh breakout into early — the core warning.
    if (s.phase === 'early' && solid(s) && coins.length > 0) {
      const wasEarly = prev?.phase === 'early';
      const wasConfirmed = prev?.phase === 'confirmed';
      if (prev && !wasEarly && !wasConfirmed) {
        out.push({
          ...base,
          id: `${s.id}:breakout`,
          kind: 'breakout',
          severity: 'high',
          title: `${s.label} mulai naik`,
          detail:
            `Fase ${prev.phase} → early. ` +
            `Short-term (${s.shortTerm.toFixed(2)}) sudah di atas tren harian ` +
            `(${s.longTerm.toFixed(2)}), early score ${s.earlyScore}, ` +
            `${s.buyCount} buy dari ${s.members} koin. Harian belum menyetujui — ` +
            `ini entry awal, bukan tren matang.`,
          urgency: 90 + Math.min(10, Math.round(s.earlyScore / 10)),
          coins,
        });
        continue; // one alert per sector — breakout outranks the rest
      }
      // No history yet (first ever scan): still warn, but softer.
      if (!prev) {
        out.push({
          ...base,
          id: `${s.id}:breakout`,
          kind: 'breakout',
          severity: 'medium',
          title: `${s.label} mulai naik (scan pertama)`,
          detail:
            `Early terdeteksi di scan pertama — belum ada histori untuk ` +
            `memastikan ini flip baru atau kondisi lama. Perlakukan sebagai ` +
            `kandidat, tunggu 1 scan lagi untuk konfirmasi.`,
          urgency: 70,
          coins,
        });
        continue;
      }
    }

    // 2. Just confirmed — useful, but framed as chase-warning, not entry.
    if (s.phase === 'confirmed' && solid(s) && prev && prev.phase !== 'confirmed') {
      out.push({
        ...base,
        id: `${s.id}:confirmed`,
        kind: 'confirmed',
        severity: 'medium',
        title: `${s.label} terkonfirmasi — jangan kejar`,
        detail:
          `Harian sudah ikut berputar (heat ${s.heat}). Tren berjalan tapi ` +
          `harga sudah jauh dari titik awal. Tunggu pullback; yang menarik ` +
          `sekarang adalah koin yang belum ikut naik.`,
        urgency: 65,
        coins,
      });
      continue;
    }

    // 3. Accelerating while early/building — velocity is the tell.
    if (
      (s.phase === 'early' || s.phase === 'building') &&
      solid(s) &&
      vel != null &&
      vel >= 8 &&
      s.earlyScore >= 35 &&
      coins.length > 0
    ) {
      out.push({
        ...base,
        id: `${s.id}:acceleration`,
        kind: 'acceleration',
        severity: s.phase === 'early' ? 'high' : 'medium',
        title: `${s.label} memanas cepat (+${Math.round(vel)}/scan)`,
        detail:
          `Early score naik ${vel >= 0 ? '+' : ''}${vel.toFixed(0)} per scan ` +
          `menjadi ${s.earlyScore}. Akselerasi seperti ini biasanya mendahului ` +
          `flip fase — pantau 1-2 scan ke depan.`,
        urgency: 75 + Math.min(10, Math.round(vel / 3)),
        coins,
      });
      continue;
    }

    // 4. Still early after N scans — rotation is holding, not fading.
    if (s.phase === 'early' && solid(s) && streakEarly >= 3 && coins.length > 0) {
      out.push({
        ...base,
        id: `${s.id}:persistent`,
        kind: 'persistent',
        severity: 'medium',
        title: `${s.label} bertahan early ${streakEarly}x scan`,
        detail:
          `Sudah ${streakEarly} scan berturut-turut di fase early tanpa ` +
          `terkonfirmasi harian. Rotasi belum gagal, tapi juga belum jalan — ` +
          `kalau harian berbalik turun, call ini batal.`,
        urgency: 60,
        coins,
      });
      continue;
    }

    // 5. Building + rising — heads-up only.
    if (
      s.phase === 'building' &&
      solid(s) &&
      vel != null &&
      vel >= 4 &&
      coins.length > 0
    ) {
      out.push({
        ...base,
        id: `${s.id}:watch`,
        kind: 'watch',
        severity: 'info',
        title: `${s.label} menunjukkan tanda awal`,
        detail:
          `Belum cukup kuat disebut narasi (heat ${s.heat}), tapi early score ` +
          `naik +${vel.toFixed(0)}/scan. Masuk radar, belum waktunya entry.`,
        urgency: 40,
        coins,
      });
    }
  }

  return out.sort(
    (a, b) => b.urgency - a.urgency || KIND_RANK[a.kind] - KIND_RANK[b.kind]
  );
}
