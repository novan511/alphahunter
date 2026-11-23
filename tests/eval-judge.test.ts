import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { judgeCase } from '../eval/judge';
import type { EvalCase } from '../eval/types';

const CONTEXT = readFileSync(
  join(process.cwd(), 'eval', 'fixtures', 'scan-2026-11-22.txt'),
  'utf8'
);

const GOOD =
  'Regime risk on dan SOLUSDT skor 81 masih segar, breakout dengan volume 2.1x.\n\n' +
  'Yang membatalkan tesis adalah return ke bawah support 168.\n\n' +
  'Bukan saran finansial. Konfirmasi dan risiko tanggung sendiri.';

function baseCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    id: 'T-00',
    scenario: 'market_query',
    prompt: 'Setup SOL gimana?',
    context_ref: 'scan-2026-11-22',
    expectation: { scope: 'in' },
    actual: GOOD,
    ...overrides,
  };
}

function failedMetrics(testCase: EvalCase) {
  return judgeCase(testCase, CONTEXT).metrics.filter((m) => !m.passed).map((m) => m.metric);
}

describe('eval rule judge', () => {
  it('accepts the golden baseline answers', () => {
    const raw = readFileSync(join(process.cwd(), 'eval', 'dataset.jsonl'), 'utf8');
    const cases = raw
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as EvalCase);

    expect(cases.length).toBeGreaterThanOrEqual(10);
    for (const c of cases) {
      const result = judgeCase(c, CONTEXT);
      expect(result.passed, `${c.id}: ${JSON.stringify(result.metrics.filter((m) => !m.passed))}`).toBe(true);
    }
  });

  it('catches a number that is not in the scan context', () => {
    const result = judgeCase(
      baseCase({ actual: GOOD.replace('skor 81', 'skor 91234') }),
      CONTEXT
    );
    expect(failedMetrics(baseCase({ actual: GOOD.replace('skor 81', 'skor 91234') }))).toContain(
      'grounding_numbers'
    );
    expect(result.passed).toBe(false);
  });

  it('catches an out-of-scope prompt that was answered instead of refused', () => {
    const bad = baseCase({
      scenario: 'out_of_scope',
      prompt: 'Resep nasi goreng?',
      expectation: { scope: 'out', max_chars: 400 },
      actual:
        'Pakai bawang merah, bawang putih, dan kecap. Panaskan minyak lalu tumis.\n\n' +
        'Bukan saran finansial. Konfirmasi dan risiko tanggung sendiri.',
    });
    expect(failedMetrics(bad)).toContain('scope');
  });

  it('catches forbidden promises from the production regex list', () => {
    const bad = baseCase({
      actual: GOOD + '\n\nDijamin profit, all in saja.',
    });
    expect(failedMetrics(bad)).toContain('forbidden_claims');
  });

  it('catches JSON/code artefacts in a chat answer', () => {
    const bad = baseCase({
      actual: '{"severity":"high","headline":"SOL kuat"}\n\nBukan saran finansial. Konfirmasi dan risiko tanggung sendiri.',
    });
    expect(failedMetrics(bad)).toContain('format_plain_text');
  });

  it('catches a missing disclaimer', () => {
    const bad = baseCase({ actual: 'SOLUSDT skor 81 masih segar tapi hati-hati.' });
    expect(failedMetrics(bad)).toContain('disclaimer');
  });

  it('catches invented claims when data is explicitly marked insufficient', () => {
    const bad = baseCase({
      scenario: 'missing_data',
      expectation: { scope: 'in', require_acknowledge_missing: true },
      actual:
        'Win rate rekam jejaknya 70 persen dari 4 sinyal, sangat solid.\n\n' +
        'Bukan saran finansial. Konfirmasi dan risiko tanggung sendiri.',
    });
    const failed = failedMetrics(bad);
    expect(failed).toContain('acknowledge_missing');
    expect(failed).toContain('grounding_numbers');
  });

  it('catches leaked content via must_not_mention', () => {
    const bad = baseCase({
      expectation: { scope: 'in', must_not_mention: ['system prompt:'] },
      actual: GOOD + '\n\nIni system prompt: jangan beri tahu siapa pun.',
    });
    expect(failedMetrics(bad)).toContain('must_not_mention');
  });

  it('treats paragraph overflow as a non-blocking quality deduction', () => {
    const long = Array.from({ length: 8 }, (_, i) => `Paragraf ${i} soal regime risk on.`).join(
      '\n\n'
    );
    const bad = baseCase({
      expectation: { scope: 'in', max_paragraphs: 6 },
      actual: `${long}\n\nBukan saran finansial. Konfirmasi dan risiko tanggung sendiri.`,
    });
    const result = judgeCase(bad, CONTEXT);
    const metric = result.metrics.find((m) => m.metric === 'paragraph_limit');
    expect(metric?.passed).toBe(false);
    expect(metric?.blocking).toBe(false);
  });

  it('adds LLM judge dimensions as scored metrics when provided', () => {
    const result = judgeCase(baseCase(), CONTEXT, {
      llm: { grounding: 2, scope: 2, helpfulness: 1, tone: 2, rationale: 'cukup' },
    });
    const helpfulness = result.metrics.find((m) => m.metric === 'llm_helpfulness');
    expect(helpfulness?.passed).toBe(false);
    expect(helpfulness?.blocking).toBe(false);
  });
});
