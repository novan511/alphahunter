/**
 * Self-check integrasi arena: daftar model AntSeed + OpenRouter, semua free & terprefix.
 * Run: node --env-file=.env.local --import tsx scripts/smoke-arena-models.ts
 */
import { listArenaModels } from '../lib/quant/arena';

(async () => {
  const list = await listArenaModels();
  const or = list.filter((m) => m.id.startsWith('or:'));
  const antseed = list.filter((m) => !m.id.startsWith('or:'));
  console.log(`AntSeed: ${antseed.length} (${antseed.filter((m) => m.free).length} free)`);
  console.log(`OpenRouter: ${or.length} (semua free=${or.every((m) => m.free)})`);
  for (const m of or.slice(0, 6)) console.log('  -', m.id, '|', m.name);

  // saat AntSeed outage pun daftar harus tetap terisi (OpenRouter tidak ikut hilang)
  if (list.length === 0) throw new Error('kedua gateway kosong — daftar model gagal total');
  if (or.length === 0) throw new Error('tidak ada model OpenRouter masuk list');
  if (!or.every((m) => m.free)) throw new Error('ada model OpenRouter yang tidak free');
  console.log('SMOKE-ARENA-MODELS OK');
})().catch((e) => {
  console.error('FAIL:', e instanceof Error ? e.message : e);
  process.exit(1);
});
