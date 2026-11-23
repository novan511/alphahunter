/**
 * Offline evaluation runner for the Telegram chatbot.
 *
 *   npm run eval                       # recorded answers, rule checks, CI-safe
 *   npm run eval -- --threshold 0.95   # stricter release gate
 *   npm run eval -- --generate         # regenerate answers with the live LLM
 *   npm run eval -- --judge=llm        # add optional LLM-as-judge scores
 *
 * `--generate` and `--judge=llm` need LLM credentials and make network calls;
 * the default path does neither and is what CI runs.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { judgeCase } from './judge';
import { writeReport } from './report';
import type { EvalCase, EvalReport, LLMJudgeScores, ScenarioId, ScenarioSummary } from './types';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const has = (name: string) => args.includes(name);
const value = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

async function main(): Promise<void> {
  const thresholdRaw = Number(value('--threshold') ?? '0.9');
  if (!Number.isFinite(thresholdRaw) || thresholdRaw < 0 || thresholdRaw > 1) {
    throw new Error('--threshold harus angka antara 0 dan 1');
  }
  const generate = has('--generate');
  const useLlmJudge = has('--judge=llm');

  const datasetRaw = readFileSync(join(ROOT, 'eval', 'dataset.jsonl'), 'utf8');
  const cases: EvalCase[] = [];
  datasetRaw.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    try {
      cases.push(JSON.parse(line) as EvalCase);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`eval/dataset.jsonl baris ${i + 1} bukan JSON valid: ${msg}`);
    }
  });
  if (cases.length === 0) throw new Error('eval/dataset.jsonl kosong');

  const fixtureNames = Array.from(new Set(cases.map((c) => c.context_ref)));
  const contextByRef: Record<string, string> = {};
  for (const ref of fixtureNames) {
    contextByRef[ref] = readFileSync(
      join(ROOT, 'eval', 'fixtures', `${ref}.txt`),
      'utf8'
    );
  }
  const contextFor = (c: EvalCase) => contextByRef[c.context_ref] ?? '';

  let source: EvalReport['source'] = 'recorded';
  let model = 'recorded-baseline';

  if (generate || useLlmJudge) {
    const [{ callLLM, llmEnv }, { buildAskPrompt }, { TELEGRAM_SYSTEM_PROMPT }] = await Promise.all([
      import('../lib/quant/marketNarrator'),
      import('../lib/telegramAskPrompt'),
      import('../lib/telegramPersona'),
    ]);
    model = llmEnv().model;

    if (generate) {
      source = 'generated';
      for (const c of cases) {
        const prompt = buildAskPrompt({
          memory: c.memory ?? '',
          context: contextFor(c),
          question: c.prompt,
        });
        try {
          const answer = await callLLM(prompt, { system: TELEGRAM_SYSTEM_PROMPT });
          // Mirror the production truncation in handleAsk().
          c.actual = answer.slice(0, 3500);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[${c.id}] generasi gagal, memakai jawaban tersimpan: ${msg}`);
        }
      }
    }

    if (useLlmJudge) {
      for (const c of cases) {
        const scores = await judgeWithLLM(c, contextFor(c), callLLM);
        if (scores) llmScores.set(c.id, scores);
        else console.warn(`[${c.id}] LLM judge tidak mengembalikan JSON yang valid`);
      }
    }
  }

  const results = cases.map((c) => judgeCase(c, contextFor(c), { llm: llmScores.get(c.id) }));
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const passRate = total === 0 ? 0 : passed / total;
  const weightedScore =
    total === 0 ? 0 : results.reduce((sum, r) => sum + r.score, 0) / total;

  const byScenarioMap = new Map<ScenarioId, { total: number; passed: number }>();
  for (const r of results) {
    const acc = byScenarioMap.get(r.scenario) ?? { total: 0, passed: 0 };
    acc.total += 1;
    if (r.passed) acc.passed += 1;
    byScenarioMap.set(r.scenario, acc);
  }
  const byScenario: ScenarioSummary[] = Array.from(byScenarioMap.entries())
    .map(([scenario, acc]) => ({
      scenario,
      total: acc.total,
      passed: acc.passed,
      passRate: acc.total === 0 ? 0 : acc.passed / acc.total,
    }))
    .sort((a, b) => a.scenario.localeCompare(b.scenario));

  const report: EvalReport = {
    generatedAt: new Date().toISOString(),
    source,
    model,
    threshold: thresholdRaw,
    total,
    passed,
    failed: total - passed,
    passRate,
    weightedScore,
    llmJudge: llmScores.size > 0,
    byScenario,
    cases: results,
    suitePassed: passRate >= thresholdRaw,
  };

  const written = writeReport(report, join(ROOT, 'eval', 'reports'));
  console.log(`\n${renderSummary(report)}`);
  console.log(`\nJSON: ${written.json}`);
  console.log(`Markdown: ${written.md}`);

  if (!report.suitePassed) process.exitCode = 1;
}

const llmScores = new Map<string, LLMJudgeScores>();

const JUDGE_SYSTEM = `You are a strict evaluator for an Indonesian-language financial chatbot.
Score the answer on four dimensions, each 0-2:
- grounding: every number and fact is supported by CONTEXT
- scope: the answer respects EXPECTED scope (domain refusal for out-of-scope prompts)
- helpfulness: the answer actually addresses the user's question
- tone: concise, plain text, authoritative but not robotic
Return ONLY a JSON object, no prose, no markdown fence:
{"grounding":2,"scope":2,"helpfulness":2,"tone":2,"rationale":"one short sentence"}`;

async function judgeWithLLM(
  c: EvalCase,
  context: string,
  callLLM: (prompt: string, opts?: { system?: string }) => Promise<string>
): Promise<LLMJudgeScores | undefined> {
  const user = `CONTEXT:\n${context}\n\nEXPECTED:\n${JSON.stringify(c.expectation)}\n\nUSER QUESTION:\n${c.prompt}\n\nANSWER:\n${c.actual}`;
  try {
    const raw = await callLLM(user, { system: JUDGE_SYSTEM });
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const num = (k: string) => {
      const n = Number(parsed[k]);
      return Number.isFinite(n) ? Math.max(0, Math.min(2, Math.round(n))) : 0;
    };
    return {
      grounding: num('grounding'),
      scope: num('scope'),
      helpfulness: num('helpfulness'),
      tone: num('tone'),
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale.slice(0, 300) : '',
    };
  } catch {
    return undefined;
  }
}

function renderSummary(r: EvalReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines = [
    `Chatbot eval — ${r.suitePassed ? 'PASS' : 'FAIL'} (gate ${pct(r.threshold)})`,
    `Cases: ${r.passed}/${r.total} passed · pass rate ${pct(r.passRate)} · score ${pct(r.weightedScore)}`,
    `Source: ${r.source} · model: ${r.model} · LLM judge: ${r.llmJudge ? 'on' : 'off'}`,
    '',
  ];
  for (const c of r.cases.filter((x) => !x.passed)) {
    const failed = c.metrics.filter((m) => !m.passed).map((m) => m.metric).join(', ');
    lines.push(`  ✗ ${c.id} [${c.scenario}] ${failed}`);
  }
  return lines.join('\n');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
