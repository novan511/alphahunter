/**
 * Composition stability for the curated universe.
 *
 * Run: npx tsx scripts/smoke-curated-cache.ts
 *
 * The sweep resumes by absolute position, so the basket must be byte-identical
 * across calls within a sweep. A drifting composition changes universeId, which
 * forced a mid-sweep restart and made the sweep never reach `done` — the page
 * then rescanned on every load.
 */

import {
  buildCuratedUniverse,
  resetCuratedCache,
} from '../lib/curatedUniverse';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  PASS  ${name}`);
  else { failures++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main(): Promise<void> {
  console.log('\n[1] repeated calls return the identical list');
  {
    resetCuratedCache();
    const a = await buildCuratedUniverse();
    const b = await buildCuratedUniverse();
    const c = await buildCuratedUniverse();

    check('id stable across calls', a.id === b.id && b.id === c.id, `${a.id} / ${b.id} / ${c.id}`);
    check(
      'membership stable across calls',
      JSON.stringify(a.entries.map((e) => e.symbol)) ===
        JSON.stringify(c.entries.map((e) => e.symbol)),
    );
    check('non-empty', a.entries.length >= 20, `${a.entries.length}`);
    check(
      'no duplicate symbols',
      new Set(a.entries.map((e) => e.symbol)).size === a.entries.length,
    );
    console.log(`       id=${a.id.slice(0, 28)}… total=${a.entries.length}`);
    console.log(
      `       buckets: topCap=${a.counts.topCap} narrative=${a.counts.narrative} outsiders=${a.counts.outsiders}`,
    );
  }

  console.log('\n[2] memo survives after reset is NOT called');
  {
    // Same process, so the memo from [1] must still apply.
    const d = await buildCuratedUniverse();
    const e = await buildCuratedUniverse();
    check('still stable', d.id === e.id);
  }

  console.log('\n[3] degenerate inputs still terminate');
  {
    resetCuratedCache();
    const tiny = await buildCuratedUniverse({ topCap: 5, perNarrative: 1, outsiders: 1 });
    check('tiny basket builds', tiny.entries.length > 0, `${tiny.entries.length}`);
    check('tiny basket is small', tiny.entries.length <= 40, `${tiny.entries.length}`);

    resetCuratedCache();
    const zero = await buildCuratedUniverse({ topCap: 0, perNarrative: 0, outsiders: 0 });
    check('all-zero params does not hang or throw', zero !== null);
  }

  console.log('\n[4] quality gates hold on the real basket');
  {
    resetCuratedCache();
    const u = await buildCuratedUniverse();
    const syms = u.entries.map((e) => e.symbol);
    check('every symbol is a plain USDT pair', syms.every((s) => /^[A-Z0-9]+USDT$/.test(s)), syms.filter((s) => !/^[A-Z0-9]+USDT$/.test(s)).join(','));
    check('no leveraged tokens', !syms.some((s) => /UP$|DOWN$|BULL$|BEAR$|\d+(L|S)$/.test(s.replace(/USDT$/, ''))));
    check('all above the volume floor', u.entries.every((e) => (e.quoteVolume ?? 0) >= 500_000));
  }

  console.log(
    failures === 0
      ? '\nAll curated-universe checks passed.\n'
      : `\n${failures} check(s) FAILED.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((err) => {
  console.error('smoke-curated-cache crashed:', err instanceof Error ? err.message : err);
  process.exit(2);
});