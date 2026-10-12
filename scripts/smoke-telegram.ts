/**
 * Smoke test for Telegram bot commands that compute live data.
 *
 * Run: npx tsx scripts/smoke-telegram.ts
 *
 * Calls the webhook handlers directly so no message is sent to Telegram.
 * Needs network (exchange candles) but no bot token.
 */

import { handleMatrix, handlePair } from '../pages/api/telegram-webhook';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main(): Promise<void> {
console.log('\n[1] /matrix default (4h x30, 6 coins)');
{
  const reply = await handleMatrix([]);
  console.log('--- reply ---');
  console.log(reply);
  console.log('--- end ---');
  const lines = reply.split('\n');
  check('header mentions window', /Matrix 4h x30/.test(lines[0]), lines[0]);
  const ranked = lines.filter((l) => /^\d\. /.test(l));
  check('6 ranked coins', ranked.length === 6, `got ${ranked.length}`);
  check(
    'every rank has dominance + label',
    ranked.every((l) => /[+-]\d+\.\d+% (LEAD|STRONG|NEUTRAL|WEAK|LAGGARD)/.test(l)),
  );
  const ranks = ranked.map((l) => parseInt(l, 10));
  check('ranks are 1..6 in order', ranks.join(',') === '1,2,3,4,5,6', ranks.join(','));
  check('strongest/weakest summary present', /Terkuat vs semua/.test(reply));
}

  console.log('\n[2] /matrix with args (1d 60)');
{
  const reply = await handleMatrix(['1d', '60']);
  check('header reflects args', reply.startsWith('Matrix 1d x60'), reply.split('\n')[0]);
}

  console.log('\n[3] /matrix with garbage args falls back to defaults');
{
  const reply = await handleMatrix(['nope', 'junk']);
  check('falls back to 4h x30', reply.startsWith('Matrix 4h x30'), reply.split('\n')[0]);
}

  console.log('\n[4] /pair SOL BTC');
{
  const reply = await handlePair(['SOL', 'BTC']);
  console.log('--- reply ---');
  console.log(reply);
  console.log('--- end ---');
  const lines = reply.split('\n');
  check('header names the pair', /^SOL\/BTC 4h x\d+:/.test(lines[0]), lines[0]);
  check('window-30 line present', /^Window 30 bar: [+-]\d+\.\d+%$/.test(lines[1]), lines[1]);
  check('MA20 read present', /MA20/.test(lines[2] ?? ''));
}

  console.log('\n[5] /pair with explicit tf');
{
  const reply = await handlePair(['HYPE', 'SOL', '1d']);
  check('uses 1d', reply.startsWith('HYPE/SOL 1d x'), reply.split('\n')[0]);
}

  console.log('\n[6] /pair without args shows usage, not an error');
{
  const reply = await handlePair([]);
  check('usage hint', reply.startsWith('Format: /pair'), reply.split('\n')[0]);
}

  console.log('\n[7] /pair with unknown coin fails honestly');
{
  const reply = await handlePair(['SOL', 'COINTHATDOESNOTEXIST123']);
  check('honest failure, no crash', /Gagal memuat/.test(reply), reply.split('\n')[0]);
}

  console.log(
    failures === 0
      ? '\nAll telegram smoke checks passed.\n'
      : `\n${failures} check(s) FAILED.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((err) => {
  console.error('smoke-telegram crashed:', err instanceof Error ? err.message : err);
  process.exit(2);
});
