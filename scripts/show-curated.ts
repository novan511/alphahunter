/**
 * Print the curated universe for human review.
 *
 * Run: npx tsx scripts/show-curated.ts
 *
 * If a coin here looks wrong (dead listing, wrong category, missing famous
 * name), fix lib/curatedUniverse.ts or lib/assetCategory.ts — not the output.
 */

import { buildCuratedUniverse } from '../lib/curatedUniverse';
import { categoryFor } from '../lib/assetCategory';

async function main(): Promise<void> {
  const started = Date.now();
  const curated = await buildCuratedUniverse();
  console.log(`\nbuilt in ${Date.now() - started}ms · id ${curated.id.slice(0, 24)}…`);
  console.log(
    `counts: topCap=${curated.counts.topCap} narrative=${curated.counts.narrative} ` +
    `outsiders=${curated.counts.outsiders} total=${curated.counts.total}\n`,
  );

  const byCat: Record<string, string[]> = {};
  for (const e of curated.entries) {
    const cat = categoryFor(e.symbol);
    if (!byCat[cat]) byCat[cat] = [];
    byCat[cat].push(e.symbol.replace(/USDT$/, ''));
  }

  const order = Object.keys(byCat).sort((a, b) => byCat[b].length - byCat[a].length);
  for (const cat of order) {
    console.log(`${cat} (${byCat[cat].length}): ${byCat[cat].join(', ')}`);
  }

  const other = byCat['other'] ?? [];
  console.log(`\nuncategorized ("other"): ${other.length} — these get no narrative slot`);
  if (other.length > 0) console.log(other.join(', '));
  console.log('');
}

void main().catch((err) => {
  console.error('show-curated failed:', err instanceof Error ? err.message : err);
  process.exit(2);
});
