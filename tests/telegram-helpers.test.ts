import { describe, expect, it } from 'vitest';
import { maskChatId } from '../lib/observability';
import { MAX_ASK_CHARS, parseTf, parseWindow, short } from '../pages/api/telegram-webhook';

describe('parseTf', () => {
  it('hanya menerima 1h / 4h / 1d', () => {
    expect(parseTf('1h', '4h')).toBe('1h');
    expect(parseTf('4H', '4h')).toBe('4h');
    expect(parseTf('1d', '4h')).toBe('1d');
  });

  it('jatuh ke default untuk input sampah', () => {
    expect(parseTf('nope', '4h')).toBe('4h');
    expect(parseTf(undefined, '1d')).toBe('1d');
  });
});

describe('parseWindow', () => {
  it('membatasi window ke rentang 10..200', () => {
    expect(parseWindow('30', 60)).toBe(30);
    expect(parseWindow('1', 60)).toBe(10);
    expect(parseWindow('999', 60)).toBe(200);
    expect(parseWindow('junk', 60)).toBe(60);
  });
});

describe('short', () => {
  it('membuang prefix venue dan suffix quote', () => {
    expect(short('binance:BTCUSDT')).toBe('BTC');
    expect(short('ETHUSDC')).toBe('ETH');
  });
});

describe('batas input', () => {
  it('pertanyaan dipotong sebelum masuk prompt', () => {
    expect(MAX_ASK_CHARS).toBeGreaterThan(0);
    expect(MAX_ASK_CHARS).toBeLessThanOrEqual(1000);
  });

  it('log tidak membocorkan chat id penuh', () => {
    expect(maskChatId('123456789')).toBe('****6789');
    expect(maskChatId('123')).toBe('****');
  });
});
