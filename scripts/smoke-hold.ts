/**
 * Smoke test for the rotation verdict + /hold handler.
 *
 * Run: npx tsx scripts/smoke-hold.ts
 *
 * Calls the webhook handler directly, so no message reaches Telegram.
 * Needs network (exchange candles) but no bot token.
 */

import { handleHold } from '../pages/api/telegram-webhook';
import {
  buildPortfolioPlan,
  buildRotationDigest,
} from '../lib/algorithms/portfolioVerdict';
import type { CorrMatrix, CoinProfile } from '../lib/algorithms/correlationMatrix';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** Synthetic matrix with controllable profiles. */
function fakeMatrix(coins: Array<Partial<CoinProfile>>, basketCorr = 0.6): CorrMatrix {
  const full: CoinProfile[] = coins.map((c, i) => ({
    symbol: c.symbol ?? `C${i}`,
    vol: 1,
    totalReturn: c.totalReturn ?? 0,
    dominance: c.dominance ?? 0,
    dominanceRank: c.dominanceRank ?? i,
    avgCorr: 0.6,
    extensionZ: c.extensionZ ?? 0,
    basketBeta: 1,
  }));
  const n = full.length;
  const z = () => Array.from({ length: n }, () => 0);
  return {
    symbols: full.map((c) => c.symbol),
    corr: [z(), z(), z()],
    beta: [z(), z(), z()],
    rs: [z(), z(), z()],
    coins: full,
    basketCorr,
    window: 30,
    bars: 30,
    interval: '4h',
    generatedAt: Date.now(),
  };
}

async function main(): Promise<void> {
  console.log('\n[1] /hold live (basket default or Supabase)');
  {
    const reply = await handleHold([]);
    console.log('--- reply ---');
    console.log(reply);
    console.log('--- end ---');
    const lines = reply.split('\n');
    check('header mentions rotation window', /ROTASI 4h × 30/.test(lines[0]), lines[0]);
    check('has a verdict section', /TAHAN:|KURANGI:|BUANG:|PANTAU:/.test(reply));
    check(
      'every verdict line has an action and dominance',
      reply
        .split('\n')
        .filter((l) => /^\s{2}🟢|^\s{2}🔵|^\s{2}🟡|^\s{2}🔴|^\s{2}⚪/.test(l))
        .every((l) => /dom [+-]\d/.test(l)),
    );
    check(
      'separates hold from entry',
      reply.includes('Tahan/kurangi = soal posisi'),
    );
  }

  console.log('\n[2] /hold with explicit args (1d 60)');
  {
    const reply = await handleHold(['1d', '60']);
    check('header reflects args', reply.startsWith('ROTASI 1d × 60'), reply.split('\n')[0]);
  }

  console.log('\n[3] garbage args fall back to defaults');
  {
    const reply = await handleHold(['zzz', 'yyy']);
    check('falls back to 4h × 30', reply.startsWith('ROTASI 4h × 30'), reply.split('\n')[0]);
  }

  console.log('\n[4] verdict ladder — pure logic');
  {
    // Leader, mid, weak-but-not-bottom, clear laggard.
    const m = fakeMatrix([
      { symbol: 'LEAD', dominance: 8, dominanceRank: 0, extensionZ: 0.5, totalReturn: 5 },
      { symbol: 'MID', dominance: 0.5, dominanceRank: 1, extensionZ: 0, totalReturn: 1 },
      { symbol: 'SLIGHT', dominance: -2, dominanceRank: 2, extensionZ: -0.5, totalReturn: -1 },
      { symbol: 'LAST', dominance: -9, dominanceRank: 3, extensionZ: -1, totalReturn: -6 },
    ]);
    const plan = buildPortfolioPlan(m);
    const by = (s: string) => plan.verdicts.find((v) => v.symbol === s)!;
    check('leader -> HOLD_STRONG', by('LEAD').action === 'HOLD_STRONG', by('LEAD').action);
    check('mid -> HOLD', by('MID').action === 'HOLD', by('MID').action);
    check('slight negative -> TRIM', by('SLIGHT').action === 'TRIM', by('SLIGHT').action);
    check('clear laggard -> DROP', by('LAST').action === 'DROP', by('LAST').action);
    check('toDrop contains only the laggard', plan.toDrop.length === 1);
    check('toHold contains leader + mid', plan.toHold.length === 2);
    check('leader reported', plan.context.leader === 'LEAD');
    check('laggard reported', plan.context.laggard === 'LAST');
  }

  console.log('\n[4b] reason text must match the sign of dominance');
  {
    // Regression: a coin at dom -0.3 was labelled "masih di atas basket"
    // because it fell through to the else branch, whose reason claimed it
    // was above the basket while the number was negative.
    const m = fakeMatrix([
      { symbol: 'FLAT', dominance: -0.3, dominanceRank: 1, totalReturn: -1 },
      { symbol: 'UP', dominance: 0.4, dominanceRank: 2, totalReturn: 1 },
      { symbol: 'TOP', dominance: 6, dominanceRank: 0, totalReturn: 5 },
    ]);
    const plan = buildPortfolioPlan(m);
    const flat = plan.verdicts.find((v) => v.symbol === 'FLAT')!;
    const up = plan.verdicts.find((v) => v.symbol === 'UP')!;
    check(
      'negative dominance never claims "di atas basket"',
      !/di atas basket/.test(flat.reason),
      flat.reason,
    );
    check(
      'positive dominance may claim "di atas basket"',
      /di atas basket/.test(up.reason),
      up.reason,
    );
    check('flat negative still HOLD (not trimmed)', flat.action === 'HOLD', flat.action);
    // Guard the whole verdict set, not just one coin.
    check(
      'no verdict contradicts its own dominance sign',
      plan.verdicts.every((v) =>
        /di atas basket/.test(v.reason) ? v.dominance > 0 : true,
      ),
      plan.verdicts.map((v) => `${v.symbol}:${v.dominance}:${v.reason}`).join(' | '),
    );
  }

  console.log('\n[5] all-down basket must NOT produce DROP');
  {
    const m = fakeMatrix([
      { symbol: 'A', dominance: 6, dominanceRank: 0, totalReturn: -3 },
      { symbol: 'B', dominance: -4, dominanceRank: 1, totalReturn: -9 },
      { symbol: 'C', dominance: -8, dominanceRank: 2, totalReturn: -14 },
    ]);
    const plan = buildPortfolioPlan(m);
    check('basket direction detected', plan.context.basketDirection === 'all_down', plan.context.basketDirection);
    check('no DROP when whole basket is down', plan.toDrop.length === 0, `${plan.toDrop.length} drops`);
    check(
      'weak coins are WATCH, not DROP',
      plan.verdicts.filter((v) => v.symbol !== 'A').every((v) => v.action === 'WATCH'),
    );
  }

  console.log('\n[6] deep-below-trend is WATCH, not DROP');
  {
    const m = fakeMatrix([
      { symbol: 'A', dominance: 5, dominanceRank: 0, totalReturn: 3 },
      { symbol: 'B', dominance: -3, dominanceRank: 1, extensionZ: -3.5, totalReturn: -4 },
      { symbol: 'C', dominance: -6, dominanceRank: 2, extensionZ: -0.5, totalReturn: -5 },
    ]);
    const plan = buildPortfolioPlan(m);
    const b = plan.verdicts.find((v) => v.symbol === 'B')!;
    const c = plan.verdicts.find((v) => v.symbol === 'C')!;
    check('deep below trend -> WATCH', b.action === 'WATCH', b.action);
    check('merely negative -> DROP', c.action === 'DROP', c.action);
  }

  console.log('\n[7] persistence from history upgrades the reason');
  {
    const m = fakeMatrix([
      { symbol: 'A', dominance: 4, dominanceRank: 0 },
      { symbol: 'B', dominance: -7, dominanceRank: 1 },
      { symbol: 'C', dominance: -6, dominanceRank: 2 },
    ]);
    const now = new Date().toISOString();
    const older = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const oldest = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const history = [
      { symbol: 'B', created_at: now, dominance: -7, dominance_rank: 1 },
      { symbol: 'B', created_at: older, dominance: -6.5, dominance_rank: 1 },
      { symbol: 'B', created_at: oldest, dominance: -6, dominance_rank: 2 },
      { symbol: 'C', created_at: now, dominance: -6, dominance_rank: 2 },
      { symbol: 'C', created_at: older, dominance: 1, dominance_rank: 0 },
      { symbol: 'C', created_at: oldest, dominance: 2, dominance_rank: 0 },
      { symbol: 'A', created_at: now, dominance: 4, dominance_rank: 0 },
      { symbol: 'A', created_at: older, dominance: 3, dominance_rank: 0 },
      { symbol: 'A', created_at: oldest, dominance: 3, dominance_rank: 0 },
    ];
    const plan = buildPortfolioPlan(m, history);
    const b = plan.verdicts.find((v) => v.symbol === 'B')!;
    const c = plan.verdicts.find((v) => v.symbol === 'C')!;
    check('B weak 3x -> streak recorded', b.weakBars === 3, String(b.weakBars));
    check('B reason mentions consecutive', /berturut/.test(b.reason), b.reason);
    // C was strong one snapshot ago, so its streak restarts at 1 — that is
    // "newly weak", not confirmed. The DROP path requires >= 2.
    check('C newly weak -> streak is 1, not persistent', c.weakBars === 1, String(c.weakBars));
    check('C reason does not claim persistence', !/berturut/.test(c.reason), c.reason);
  }

  console.log('\n[8] rank delta from history');
  {
    const m = fakeMatrix([
      { symbol: 'A', dominance: 3, dominanceRank: 0 },
      { symbol: 'B', dominance: -2, dominanceRank: 1 },
      { symbol: 'C', dominance: -5, dominanceRank: 2 },
    ]);
    const now = new Date().toISOString();
    const older = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const history = [
      { symbol: 'B', created_at: now, dominance: -2, dominance_rank: 1 },
      { symbol: 'B', created_at: older, dominance: 3, dominance_rank: 0 },
      { symbol: 'A', created_at: now, dominance: 3, dominance_rank: 0 },
      { symbol: 'A', created_at: older, dominance: 2, dominance_rank: 1 },
      { symbol: 'C', created_at: now, dominance: -5, dominance_rank: 2 },
      { symbol: 'C', created_at: older, dominance: -4, dominance_rank: 2 },
    ];
    const plan = buildPortfolioPlan(m, history);
    const b = plan.verdicts.find((v) => v.symbol === 'B')!;
    check('B rankDelta = +1 (fell from 0 to 1)', b.rankDelta === 1, String(b.rankDelta));
    const digest = buildRotationDigest(plan);
    check('digest mentions rank drop', /turun 1 peringkat/.test(digest), digest.split('\n').slice(0, 6).join(' | '));
  }

  console.log('\n[9] extended leader gets a hold-not-add warning');
  {
    const m = fakeMatrix([
      { symbol: 'HOT', dominance: 9, dominanceRank: 0, extensionZ: 3 },
      { symbol: 'CALM', dominance: 4, dominanceRank: 1, extensionZ: 0.4 },
    ]);
    const plan = buildPortfolioPlan(m);
    const hot = plan.verdicts.find((v) => v.symbol === 'HOT')!;
    check('extended leader reason warns', /tahan, jangan tambah/.test(hot.reason), hot.reason);
  }

  console.log('\n[10] empty basket does not crash');
  {
    const m = fakeMatrix([]);
    const plan = buildPortfolioPlan(m);
    check('empty plan', plan.verdicts.length === 0);
    const digest = buildRotationDigest(plan);
    check('digest still returns a header', digest.includes('ROTASI'));
  }

  console.log(
    failures === 0
      ? '\nAll hold/verdict checks passed.\n'
      : `\n${failures} check(s) FAILED.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((err) => {
  console.error('smoke-hold crashed:', err instanceof Error ? err.message : err);
  process.exit(2);
});