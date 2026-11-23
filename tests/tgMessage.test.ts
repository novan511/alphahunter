import { describe, expect, it } from 'vitest';
import { signalLabel, tgFrame, TG_FOOTER } from '../lib/tgMessage';

describe('tgFrame', () => {
  it('membingkai pesan dengan label, waktu WIB, divider, dan isi', () => {
    const out = tgFrame('SEKTOR', 'Ada sinyal baru');
    expect(out).toContain('🧭 ALTHUNTER · SEKTOR');
    expect(out).toContain('WIB');
    expect(out).toContain('━━━━━━━━━━━━━━━━━━━━━━');
    expect(out).toContain('Ada sinyal baru');
  });

  it('menambahkan footer hanya kalau diberikan', () => {
    expect(tgFrame('X', 'isi')).not.toContain(TG_FOOTER);
    const withFooter = tgFrame('X', 'isi', { footer: TG_FOOTER });
    expect(withFooter).toContain(TG_FOOTER);
    expect(withFooter.indexOf('isi')).toBeLessThan(withFooter.indexOf(TG_FOOTER));
  });

  it('memotong pesan yang terlalu panjang (batas Telegram)', () => {
    const out = tgFrame('PANJANG', 'x'.repeat(10_000));
    expect(out.length).toBeLessThanOrEqual(3900);
  });
});

describe('signalLabel', () => {
  it('memetakan sinyal ke label emoji', () => {
    expect(signalLabel('strong_buy')).toBe('🚀 STRONG BUY');
    expect(signalLabel('buy')).toBe('📈 BUY');
    expect(signalLabel('strong_sell')).toBe('🔻 STRONG SELL');
    expect(signalLabel('sell')).toBe('📉 SELL');
  });

  it('mengembalikan nilai apa adanya untuk sinyal tak dikenal', () => {
    expect(signalLabel('neutral')).toBe('neutral');
  });
});
