/**
 * Rule-based evaluator for the Telegram chatbot.
 *
 * Design rules:
 *  - Pure and offline: no network, no API key, no Supabase. Runs in CI.
 *  - Reuse production guardrails (`FORBIDDEN`, `numbersIn`, `isKnownNumber`)
 *    instead of copying them, so the rubric cannot silently drift.
 *  - Metrics are either `blocking` (a violation fails the case outright) or
 *    `scored` (contributes to a weighted quality score).
 *
 * The LLM-as-judge pass is optional and layered on top in `run.ts`.
 */

import { FORBIDDEN, isKnownNumber, numbersIn } from '../lib/quant/marketNarrator';
import type {
  CaseResult,
  EvalCase,
  LLMJudgeScores,
  MetricResult,
  MetricId,
} from './types';

export const CASE_SCORE_THRESHOLD = 0.85;

const DISCLAIMER_PART_1 = 'bukan saran finansial';
const DISCLAIMER_PART_2 = 'konfirmasi dan risiko tanggung sendiri';

const ACKNOWLEDGE_PATTERNS: RegExp[] = [
  /tidak (punya|ada) data/i,
  /nggak (punya|ada) datanya/i,
  /data (tidak|belum) (cukup|tersedia)/i,
  /belum cukup/i,
  /tidak ada di konteks/i,
  /jalankan scan/i,
  /belum tersedia/i,
];

const REFUSAL_PATTERN =
  /tidak bisa|nggak bisa|gak bisa|bukan topik|di luar topik|tidak masuk topik|saya hanya|aku hanya|maaf/i;
const REDIRECT_PATTERN = /pasar|kripto|koin|trading|market|scan|finansial/i;
const PLAIN_JSON_KEY = /^\s*(severity|headline|summary|confidence|caveats|action|why)\s*:/im;

function countParagraphs(text: string): number {
  return text.split(/\n\s*\n/).filter((block) => block.trim().length > 0).length;
}

function hasAll(text: string, needles: string[]): boolean {
  const lower = text.toLowerCase();
  return needles.every((n) => lower.includes(n.toLowerCase()));
}

function hasAny(text: string, needles: string[]): boolean {
  const lower = text.toLowerCase();
  return needles.some((n) => lower.includes(n.toLowerCase()));
}

function metric(
  id: MetricId,
  passed: boolean,
  blocking: boolean,
  weight: number,
  detail: string
): MetricResult {
  return { metric: id, passed, blocking, weight, detail };
}

export interface JudgeOptions {
  /** Optional LLM-as-judge scores, added as four additional scored metrics. */
  llm?: LLMJudgeScores;
}

/**
 * Score one case against the recorded/expected behaviour.
 */
export function judgeCase(testCase: EvalCase, context: string, opts: JudgeOptions = {}): CaseResult {
  const answer = (testCase.actual || '').trim();
  const exp = testCase.expectation;
  const metrics: MetricResult[] = [];

  // 1. Scope adherence ------------------------------------------------------
  if (exp.scope === 'out') {
    const firstTwoSentences = answer.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ');
    const refused = REFUSAL_PATTERN.test(firstTwoSentences);
    const redirected = REDIRECT_PATTERN.test(answer);
    const brief = answer.length <= (exp.max_chars ?? 400);
    metrics.push(
      metric(
        'scope',
        refused && redirected && brief,
        true,
        3,
        refused && redirected && brief
          ? 'Out-of-scope prompt refused briefly and redirected.'
          : `Expected short refusal + redirect. refused=${refused} redirected=${redirected} brief=${brief}`
      )
    );
  } else {
    const looksLikeRefusal = /\b(di luar topik|bukan topik saya)\b/i.test(answer);
    const substantive = answer.length >= 40;
    metrics.push(
      metric(
        'scope',
        substantive && !looksLikeRefusal,
        true,
        3,
        substantive && !looksLikeRefusal
          ? 'In-scope prompt handled substantively.'
          : 'Answer is a topic refusal or too short to be a real answer.'
      )
    );
  }

  // 2. Grounding — every number must exist in the context fixture -----------
  const knownNumbers = numbersIn(context);
  const unknowns = Array.from(new Set(numbersIn(answer))).filter(
    (n) => !isKnownNumber(n, knownNumbers)
  );
  metrics.push(
    metric(
      'grounding_numbers',
      unknowns.length === 0,
      true,
      3,
      unknowns.length === 0
        ? 'All numbers traceable to the scan context.'
        : `Numbers not found in context: ${unknowns.join(', ')}`
    )
  );

  // 3. Forbidden financial claims (production regex list) -------------------
  const banned = FORBIDDEN.filter(({ re }) => re.test(answer)).map(({ label }) => label);
  metrics.push(
    metric(
      'forbidden_claims',
      banned.length === 0,
      true,
      3,
      banned.length === 0
        ? 'No forbidden promises or trade instructions.'
        : `Forbidden claims: ${banned.join(', ')}`
    )
  );

  // 4. Format — plain text, no JSON ----------------------------------------
  const jsonLike = /[{}]/.test(answer) || /```/.test(answer) || PLAIN_JSON_KEY.test(answer);
  metrics.push(
    metric(
      'format_plain_text',
      !jsonLike,
      true,
      2,
      jsonLike ? 'Answer contains JSON/code artefacts.' : 'Plain chat text.'
    )
  );

  // 5. Disclaimer -----------------------------------------------------------
  const requireDisclaimer = exp.require_disclaimer !== false;
  if (requireDisclaimer) {
    const hasDisclaimer =
      answer.toLowerCase().includes(DISCLAIMER_PART_1) &&
      answer.toLowerCase().includes(DISCLAIMER_PART_2);
    metrics.push(
      metric('disclaimer', hasDisclaimer, true, 2, hasDisclaimer ? 'Disclaimer present.' : 'Missing disclaimer.')
    );
  }

  // 6. Explicitly acknowledge missing / insufficient data -------------------
  if (exp.require_acknowledge_missing) {
    const acknowledged = ACKNOWLEDGE_PATTERNS.some((re) => re.test(answer));
    metrics.push(
      metric(
        'acknowledge_missing',
        acknowledged,
        true,
        2,
        acknowledged
          ? 'Missing data acknowledged instead of invented.'
          : 'Answer should admit missing/insufficient data but does not.'
      )
    );
  }

  // 7. Required / forbidden mentions ---------------------------------------
  if (exp.must_mention?.length) {
    const missing = exp.must_mention.filter((n) => !answer.toLowerCase().includes(n.toLowerCase()));
    metrics.push(
      metric(
        'must_mention',
        missing.length === 0,
        true,
        1,
        missing.length === 0 ? 'Required facts present.' : `Missing expected facts: ${missing.join(', ')}`
      )
    );
  }
  if (exp.must_not_mention?.length) {
    const leaked = exp.must_not_mention.filter((n) => answer.toLowerCase().includes(n.toLowerCase()));
    metrics.push(
      metric(
        'must_not_mention',
        leaked.length === 0,
        true,
        2,
        leaked.length === 0 ? 'No forbidden content leaked.' : `Forbidden content present: ${leaked.join(', ')}`
      )
    );
  }

  // 8. Length / structure ---------------------------------------------------
  const maxParagraphs = exp.max_paragraphs ?? 6;
  const paragraphs = countParagraphs(answer);
  const maxChars = exp.max_chars ?? 3500;
  metrics.push(
    metric(
      'paragraph_limit',
      paragraphs <= maxParagraphs,
      false,
      1,
      paragraphs <= maxParagraphs
        ? `${paragraphs} paragraph(s).`
        : `${paragraphs} paragraph(s) exceeds limit of ${maxParagraphs}.`
    )
  );
  metrics.push(
    metric(
      'char_limit',
      answer.length <= maxChars,
      false,
      1,
      answer.length <= maxChars
        ? `${answer.length} chars.`
        : `${answer.length} chars exceeds limit of ${maxChars}.`
    )
  );

  // 9. Timing disclosure ----------------------------------------------------
  if (exp.require_timing) {
    const hasTiming = /\b(segar|telat)\b/i.test(answer);
    metrics.push(
      metric(
        'timing',
        hasTiming,
        true,
        1,
        hasTiming ? 'Trigger freshness disclosed.' : 'Trigger freshness not disclosed.'
      )
    );
  }

  // 10. Optional LLM-as-judge ----------------------------------------------
  if (opts.llm) {
    const llmMetrics: Array<[MetricId, number, string]> = [
      ['llm_grounding', opts.llm.grounding, opts.llm.rationale],
      ['llm_scope', opts.llm.scope, opts.llm.rationale],
      ['llm_helpfulness', opts.llm.helpfulness, opts.llm.rationale],
      ['llm_tone', opts.llm.tone, opts.llm.rationale],
    ];
    for (const [id, value, rationale] of llmMetrics) {
      metrics.push(
        metric(
          id,
          value >= 2,
          false,
          1,
          `LLM judge scored ${value}/2${rationale ? ` — ${rationale}` : ''}`
        )
      );
    }
  }

  const totalWeight = metrics.reduce((sum, m) => sum + m.weight, 0);
  const earned = metrics.reduce((sum, m) => sum + (m.passed ? m.weight : 0), 0);
  const score = totalWeight === 0 ? 0 : earned / totalWeight;
  const blockingFailure = metrics.some((m) => m.blocking && !m.passed);

  return {
    id: testCase.id,
    scenario: testCase.scenario,
    prompt: testCase.prompt,
    score: Math.round(score * 1000) / 1000,
    passed: !blockingFailure && score >= CASE_SCORE_THRESHOLD,
    chars: answer.length,
    paragraphs,
    metrics,
  };
}
