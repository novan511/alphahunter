/**
 * Sector ("narrative") level heat, derived from the same per-coin scan the
 * ranking table already shows.
 *
 * The question this answers is one a single coin cannot: the trader wants to
 * know WHICH story is about to turn on before picking the vehicle. That is a
 * breadth question — how many coins in a sector lean the same way, how much
 * conviction they carry, and whether the higher timeframe has confirmed —
 * not a question about the top-ranked name.
 *
 * IMPORTANT — what "about to rise" can and cannot mean here.
 *
 * This module works from a SINGLE scan snapshot. It has no price history
 * across snapshots, so it cannot measure a sector's score rising over the last
 * hour, and it does not pretend to. What it does measure is real and is the
 * standard early-rotation tell: SHORT-timeframe strength arriving while the
 * LONG timeframe has not yet turned. That divergence (`thrust`) is what
 * distinguishes a sector that is starting to move from one that is already
 * extended. Genuine cross-snapshot trend detection needs snapshot history —
 * that is deliberately out of scope here rather than faked.
 */

import { clamp01 } from './indicators';
import { MultiTimeframeResult, tfSigned } from './multiTimeframe';
import {
  CATEGORIES,
  CategoryId,
  allCategoryIds,
  categoryMeta,
  isNonDirectional,
} from '../assetCategory';

/** Bars-of-thrust at which short-term divergence saturates. */
const THRUST_CEILING = 0.25;
/** Evidence level at which the daily timeframe counts as "confirmed". */
const CONFIRM_FLOOR = 0.075;
/** Breadth above 0.5 that maps to full bullish heat. */
const BREADTH_CEILING = 0.3;
/**
 * A sector with fewer members than this is reported but flagged as a thin
 * sample. One strong coin must not be able to declare its sector "hot".
 */
export const MIN_SECTOR_MEMBERS = 3;

export type SectorPhase =
  /** Short TFs pushing, daily not confirming — the early notification. */
  | 'early'
  /** Daily has turned and breadth is broad. Trend is underway. */
  | 'confirmed'
  /** Lean is turning but too early / too thin to call. */
  | 'building'
  /** Broad, confident, but leaning down. */
  | 'falling'
  /** Was bid, now being sold — money leaving the sector. */
  | 'rotating_out'
  /** Nothing meaningful. */
  | 'weak';

export interface SectorHeat {
  id: CategoryId;
  label: string;
  icon: string;
  color: string;
  blurb: string;
  /** Coins in this sector present in the current scan. */
  members: number;
  /** True when `members` is too small for a confident read. */
  thinSample: boolean;
  /** 0-100 overall sector heat. */
  heat: number;
  /** 0-100 — how far ahead of its own daily trend the sector is running. */
  earlyScore: number;
  phase: SectorPhase;
  direction: 'bullish' | 'bearish' | 'mixed';
  /**
   * Volume-weighted directional tilt of the sector in [0,1]; 0.5 is neutral.
   * Weighted because a micro-cap wick must not outvote real flow.
   */
  breadth: number;
  /** Weighted mean conviction of the sector's leading side, 0-1. */
  conviction: number;
  /** Weighted mean timeframe agreement of the leading side, 0-1. */
  agreement: number;
  /** Weighted mean signed evidence on 1h+4h. */
  shortTerm: number;
  /** Signed evidence on 1d. */
  longTerm: number;
  /** shortTerm - longTerm. Positive = running ahead of its own daily trend. */
  thrust: number;
  /** Coins currently printing a buy signal. */
  buyCount: number;
  /** Coins currently printing a sell signal. */
  sellCount: number;
  /** Summed market cap of members with a known cap. */
  knownCap: number;
  /** Top members by confluence score, for a quick "who leads it" read. */
  leaders: string[];
  /** One-line summary. */
  headline: string;
  /** Sentence explaining the phase call and what would change it. */
  read: string;
}

/**
 * Volume weight for a member. `liquidityFactor` already encodes 24h turnover,
 * so using it here means the sector read inherits the same protection the
 * per-coin score has against illiquid names producing fake strength.
 */
function memberWeight(r: MultiTimeframeResult): number {
  const liq = r.liquidityFactor;
  const base = Number.isFinite(liq) ? (liq as number) : 0.7;
  // Floor keeps a $30k book present but unable to dominate the average.
  return Math.max(0.08, base);
}

/** Signed evidence for a named timeframe, 0 when the timeframe is inactive. */
function tfEvidence(r: MultiTimeframeResult, tf: string): number {
  const found = r.timeframes?.find((t) => t.timeframe === tf);
  if (!found || !found.active) return 0;
  const v = tfSigned(found);
  return Number.isFinite(v) ? v : 0;
}

/**
 * Short-horizon vs long-horizon split. Uses the daily as the anchor because a
 * sector that has not turned its daily has, by definition, not run yet.
 */
function horizonSplit(r: MultiTimeframeResult): { short: number; long: number } {
  const h1 = tfEvidence(r, '1h');
  const h4 = tfEvidence(r, '4h');
  return { short: (h1 + h4) / 2, long: tfEvidence(r, '1d') };
}

function fmtCap(v: number): string {
  if (v >= 1e12) return `$${(v / 1e12).toFixed(1)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return `$${(v / 1e3).toFixed(0)}K`;
}

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

/**
 * Aggregate every sector in the current scan.
 *
 * Sectors are always returned for every known category (including ones with
 * zero members) so the UI can render a stable set of cards; `members === 0`
 * means "not in this scan" rather than "no interest".
 */
export function buildSectorHeat(rankings: MultiTimeframeResult[]): SectorHeat[] {
  const buckets = new Map<CategoryId, MultiTimeframeResult[]>();
  for (const id of allCategoryIds()) buckets.set(id, []);
  for (const r of rankings) {
    const id = (r.category ?? 'other') as CategoryId;
    const list = buckets.get(id);
    if (list) list.push(r);
    else buckets.set('other', [...(buckets.get('other') ?? []), r]);
  }

  const out: SectorHeat[] = [];

  buckets.forEach((members, id) => {
    const meta = categoryMeta(id);
    const n = members.length;

    let wTotal = 0;
    let wTilt = 0;
    let wShort = 0;
    let wLong = 0;
    let wLiq = 0;
    let buyCount = 0;
    let sellCount = 0;
    let knownCap = 0;

    // Leading side is decided first, then conviction/agreement are averaged
    // over the coins that actually joined it. Averaging over the whole sector
    // would let a sector's dissenters dilute the strength of the trend.
    const tiltWeighted = { bull: 0, bear: 0 };
    const lead = { bull: { conv: 0, agree: 0 }, bear: { conv: 0, agree: 0 } };

    for (const r of members) {
      const w = memberWeight(r);
      const { short, long } = horizonSplit(r);

      // netBias is already the sign-weighted evidence blend in [-1,1]; mapping
      // it to [0,1] turns it into a comparable tilt.
      const bias = Number.isFinite(r.netBias) ? (r.netBias as number) : 0;
      const tilt = clamp01((bias + 1) / 2);

      wTotal += w;
      wTilt += w * tilt;
      wShort += w * short;
      wLong += w * long;
      wLiq += w * (r.liquidityFactor ?? 0);

      if (bias > 0) {
        tiltWeighted.bull += w;
        lead.bull.conv += w * (r.conviction ?? 0);
        lead.bull.agree += w * (r.agreement ?? 0);
      } else if (bias < 0) {
        tiltWeighted.bear += w;
        lead.bear.conv += w * (r.conviction ?? 0);
        lead.bear.agree += w * (r.agreement ?? 0);
      }

      if (r.finalSignal.includes('buy')) buyCount++;
      if (r.finalSignal.includes('sell')) sellCount++;
      if (Number.isFinite(r.marketCap as number)) knownCap += (r.marketCap as number) as number;
    }

    const safeW = wTotal > 0 ? wTotal : 1;
    const breadth = wTilt / safeW;
    const shortTerm = wShort / safeW;
    const longTerm = wLong / safeW;
    const liquidity = wLiq / safeW;

    const bullW = tiltWeighted.bull;
    const bearW = tiltWeighted.bear;
    const direction: SectorHeat['direction'] =
      bullW > bearW * 1.15 ? 'bullish' : bearW > bullW * 1.15 ? 'bearish' : 'mixed';

    // When direction is 'mixed' the two sides are within 15% of each other;
    // reporting the bull side keeps the number meaningful instead of
    // oscillating between two near-identical averages.
    const leadW = direction === 'bearish' ? bearW : bullW;
    const leadSide = direction === 'bearish' ? lead.bear : lead.bull;
    const conviction = leadW > 0 ? leadSide.conv / leadW : 0;
    const agreement = leadW > 0 ? leadSide.agree / leadW : 0;

    const thrust = shortTerm - longTerm;

    // --- scoring -----------------------------------------------------------
    //
    // Four separate, honest measurements. Breadth asks "how many agree",
    // conviction "how strongly", thrust "is it ahead of its own daily trend",
    // confirmation "has the daily turned yet".
    const breadthOver = clamp01((breadth - 0.5) / BREADTH_CEILING);
    const thrustOver = clamp01(Math.max(0, thrust) / THRUST_CEILING);
    const shortStrength = clamp01(shortTerm / THRUST_CEILING);
    const confirm = clamp01(longTerm / CONFIRM_FLOOR);

    const heat = Math.round(
      100 *
        clamp01(
          0.32 * breadthOver +
            0.26 * conviction +
            0.20 * thrustOver +
            0.14 * confirm +
            0.08 * liquidity
        )
    );

    // Early score is deliberately gated on the daily NOT having confirmed.
    // Once the daily is in, the trade is a continuation, not an early entry —
    // and calling it "early" would be the single most expensive mislabelling
    // this panel could make.
    const earlyScore = Math.round(
      100 *
        clamp01(
          0.40 * thrustOver +
            0.28 * shortStrength +
            0.20 * breadthOver +
            0.12 * (1 - confirm)
        )
    );

    const thinSample = n < MIN_SECTOR_MEMBERS;

    let phase: SectorPhase;
    if (n === 0) {
      phase = 'weak';
    } else if (direction === 'bearish') {
      phase = thrust < -0.08 ? 'rotating_out' : 'falling';
    } else if (heat >= 55 && confirm >= 0.35) {
      phase = 'confirmed';
    } else if (earlyScore >= 45 && heat >= 25) {
      phase = 'early';
    } else if (heat >= 28) {
      phase = 'building';
    } else {
      phase = 'weak';
    }

    const leaders = [...members]
      .sort((a, b) => b.confluenceScore - a.confluenceScore)
      .slice(0, 3)
      .map((r) => r.asset.replace('USDT', ''));

    out.push({
      id,
      label: meta.label,
      icon: meta.icon,
      color: meta.color,
      blurb: meta.blurb,
      members: n,
      thinSample,
      heat,
      earlyScore,
      phase,
      direction,
      breadth,
      conviction,
      agreement,
      shortTerm,
      longTerm,
      thrust,
      buyCount,
      sellCount,
      knownCap,
      leaders,
      headline: buildHeadline({ phase, heat, buyCount, sellCount, n, thinSample }),
      read: buildRead({
        phase,
        heat,
        thrust,
        longTerm,
        shortTerm,
        agreement,
        buyCount,
        sellCount,
        n,
        thinSample,
        knownCap,
        leaders,
      }),
    });
  });

  // Hot first, then early-but-cool, then everything else. Within a band, heat
  // decides. Sectors absent from the scan sink to the bottom.
  const phaseRank: Record<SectorPhase, number> = {
    early: 0,
    confirmed: 1,
    building: 2,
    rotating_out: 3,
    falling: 4,
    weak: 5,
  };

  return out.sort((a, b) => {
    if (phaseRank[a.phase] !== phaseRank[b.phase]) return phaseRank[a.phase] - phaseRank[b.phase];
    if (a.members === 0 && b.members > 0) return 1;
    if (b.members === 0 && a.members > 0) return -1;
    return b.heat - a.heat;
  });
}

interface HeadlineCtx {
  phase: SectorPhase;
  heat: number;
  buyCount: number;
  sellCount: number;
  n: number;
  thinSample: boolean;
}

function buildHeadline(c: HeadlineCtx): string {
  if (c.n === 0) return 'Tidak ada koin dari sektor ini di scan saat ini.';
  const flows =
    c.buyCount > 0
      ? `${c.buyCount} buy`
      : c.sellCount > 0
        ? `${c.sellCount} sell`
        : 'belum ada signal';
  const thin = c.thinSample ? ' (sampel tipis)' : '';
  switch (c.phase) {
    case 'early':
      return `Mulai naik — 1h/4h lebih dulu, harian belum menyusul · ${flows} dari ${c.n} koin${thin}`;
    case 'confirmed':
      return `Sudah naik & terkonfirmasi — tren harian ikut berputar · ${flows} dari ${c.n} koin${thin}`;
    case 'building':
      return `Mulai bergerak, belum ekstensi · heat ${c.heat}, ${flows} dari ${c.n} koin${thin}`;
    case 'falling':
      return `Sedang turun — sebagian besar koin melemah · ${c.sellCount} dari ${c.n} koin${thin}`;
    case 'rotating_out':
      return `Uang keluar dari sektor — 1h/4h sudah melemah lebih dulu · ${c.sellCount} dari ${c.n} koin${thin}`;
    default:
      return `Belum ada narasi — heat ${c.heat}, belum ada yang bisa jadi tulang punggung${thin}`;
  }
}

interface ReadCtx extends HeadlineCtx {
  thrust: number;
  longTerm: number;
  shortTerm: number;
  agreement: number;
  knownCap: number;
  leaders: string[];
}

/**
 * The "so what" sentence under each card. Names the evidence, then names the
 * thing that would change the call — a phase label without a falsifier is just
 * a mood ring.
 */
function buildRead(c: ReadCtx): string {
  if (c.n === 0) {
    return 'Sektor ini tidak terisi di scan berjalan — lebarkan coverage agar bisa dinilai.';
  }

  const bits: string[] = [];

  if (c.thinSample) {
    bits.push(
      `Hanya ${c.n} koin ter-scan, jadi bacaan ini kurang representatif — perlakukan sebagai indikasi, bukan kesimpulan.`
    );
  }

  switch (c.phase) {
    case 'early':
      bits.push(
        `Kekuatan short-term (${c.shortTerm.toFixed(2)}) lebih tinggi dari tren harian (${c.longTerm.toFixed(2)}), ` +
          `selisih +${c.thrust.toFixed(2)} — pola khas rotasi awal: uang masuk sebelum harga harian berubah.`
      );
      bits.push(
        'Harian belum menyetujui, jadi ini entry lebih awal dengan risiko salah waktu. Kalau harian berbalik turun, call ini batal.'
      );
      break;
    case 'confirmed':
      bits.push(
        'Harian sudah searah, jadi ini kelanjutan tren, bukan lagi fase awal — dan harganya sudah jauh naik.'
      );
      bits.push('Tunggu pullback; mengejar harga yang sudah teregang adalah cara tercepat kehilangan advantage early rotation.');
      break;
    case 'building':
      bits.push('Sebagian kekuatan sudah ada, tapi belum cukup untuk menyebut ini narasi.');
      bits.push('Perhatikan apakah breadth membesar pada scan berikutnya — itu yang akan menaikkan fase ke "early" atau "confirmed".');
      break;
    case 'falling':
      bits.push(
        'Kekuatan harian negatif dan short-term juga tidak menopang — jangan menangkap pisau jatuh di sektor ini.'
      );
      break;
    case 'rotating_out':
      bits.push(
        'Uang mulai keluar: short-term sudah melemah lebih dulu. Tunggu koin pertama di sektor ini yang bertahan, atau tunggu akumulasi ulang.'
      );
      break;
    default:
      bits.push('Tidak ada bukti arah yang layak di seluruh timeframe.');
  }

  bits.push(`Kesepakatan antar-timeframe di sisi yang dominan: ${pct(c.agreement)}.`);
  if (c.knownCap > 0) bits.push(`Total cap sektor yang terdata ${fmtCap(c.knownCap)}.`);
  if (c.leaders.length > 0) bits.push(`Pemimpin sementara: ${c.leaders.join(', ')}.`);

  return bits.join(' ');
}
