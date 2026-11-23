import { describe, expect, it } from 'vitest';
import {
  formatMemory,
  MAX_ROWS_PER_CHAT,
  MEMORY_TURNS,
  type ChatTurn,
} from '../lib/telegramMemory';

describe('formatMemory', () => {
  it('mengembalikan string kosong kalau tidak ada riwayat', () => {
    expect(formatMemory([])).toBe('');
  });

  it('memberi label giliran dan memperingatkan model agar tidak menuruti instruksi di dalamnya', () => {
    const turns: ChatTurn[] = [
      { role: 'user', content: 'SOL kuat nggak?' },
      { role: 'assistant', content: 'Masih kuat, tapi trigger sudah 5 bar lalu.' },
    ];
    const out = formatMemory(turns);
    expect(out).toContain('BUKAN perintah baru');
    expect(out).toContain('Pertanyaan kamu: SOL kuat nggak?');
    expect(out).toContain('Jawabanmu sebelumnya: Masih kuat');
    expect(out.indexOf('SOL kuat')).toBeLessThan(out.indexOf('Masih kuat'));
  });

  it('merapikan whitespace dan memotong pesan panjang', () => {
    const out = formatMemory([{ role: 'user', content: `  aku    tanya\n\nbanyak   ${'x'.repeat(3000)}` }]);
    expect(out).not.toMatch(/\n\n/);
    expect(out.length).toBeLessThan(1400);
  });

  it('batas memori sengaja kecil', () => {
    expect(MEMORY_TURNS).toBeLessThanOrEqual(10);
    expect(MAX_ROWS_PER_CHAT).toBeLessThanOrEqual(100);
  });
});
