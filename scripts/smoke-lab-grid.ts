import { defaultLabCombos } from '../lib/quant/labEngine';

for (const m of ['crypto', 'commodities', 'gold-silver'] as const) {
  for (const g of ['quick', 'standard', 'full'] as const) {
    const c = defaultLabCombos(m, g);
    const tfs = Array.from(new Set(c.map((x) => x.interval)));
    console.log(m, g, 'n=' + c.length, 'tf=' + tfs.join(','));
  }
}
