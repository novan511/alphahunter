import { describe, expect, it } from 'vitest';
import { TELEGRAM_SYSTEM_PROMPT } from '../lib/telegramPersona';

describe('TELEGRAM_SYSTEM_PROMPT', () => {
  it('menetapkan persona trader, bukan asisten generik', () => {
    expect(TELEGRAM_SYSTEM_PROMPT).toContain('spesialis pasar');
    expect(TELEGRAM_SYSTEM_PROMPT).toContain('hedge fund');
    expect(TELEGRAM_SYSTEM_PROMPT).toContain('jangan asisten generik');
  });

  it('membatasi topik dan menolak obrolan di luar pasar', () => {
    expect(TELEGRAM_SYSTEM_PROMPT).toContain('BATAS TOPIK');
    expect(TELEGRAM_SYSTEM_PROMPT).toContain('cuaca');
    expect(TELEGRAM_SYSTEM_PROMPT).toContain('tolak dengan SATU kalimat pendek');
  });

  it('melarang halusinasi angka dan mewajibkan teks biasa', () => {
    expect(TELEGRAM_SYSTEM_PROMPT).toContain('JANGAN mengarang angka');
    expect(TELEGRAM_SYSTEM_PROMPT).toContain('TEKS BIASA');
    expect(TELEGRAM_SYSTEM_PROMPT).toContain('JANGAN JSON');
  });

  it('membedakan rekam jejak nyata dari prediksi dan selalu disclaimer', () => {
    expect(TELEGRAM_SYSTEM_PROMPT).toContain('REKAM JEJAK LIVE');
    expect(TELEGRAM_SYSTEM_PROMPT).toContain('bukan prediksi');
    expect(TELEGRAM_SYSTEM_PROMPT).toContain('Bukan saran finansial. Konfirmasi dan risiko tanggung sendiri.');
  });
});
