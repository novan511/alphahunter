/**
 * Offline evaluation runner for the agentic runtime.
 *
 *   npm run eval:agent   # scripted traces, rule-based judges, CI-safe
 *   npm run eval:all     # chatbot eval + agent eval
 *
 * No API key, no network, no Supabase: the LLM is a deterministic cursor over
 * `llm_sequence` and every tool is a local counter returning canned data. The
 * production `runAgent` loop, executor, validation, audit and guardrails are
 * the real ones — only their I/O boundaries are replaced. See
 * `docs/evaluation/agent-quality.md`.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { InMemoryAuditSink, idempotencyKey, runAgent } from '../../lib/agent';
import type {
  AgentDeps,
  AgentResult,
  LLMResponse,
  ParamDef,
  ToolDefinition,
  ToolOutcome,
} from '../../lib/agent';
import { judgeAgentCase } from './judge';
import type {
  AgentCaseResult,
  AgentEvalCase,
  AgentScenario,
  ScriptedResponse,
  ToolRunCounts,
} from './judge';

const ROOT = process.cwd();
const DATASET_PATH = join(ROOT, 'eval', 'agent', 'dataset.jsonl');
const FIXTURE_PATH = join(ROOT, 'eval', 'fixtures', 'scan-2026-11-22.txt');
const REPORT_DIR = join(ROOT, 'eval', 'reports');

/** Fixed chat id keeps idempotency keys stable across runs and machines. */
export const EVAL_CHAT_ID = 'eval-agent-chat';
export const SUITE_PASS_RATE_GATE = 0.9;

/** Used when a scripted sequence runs out before the loop is done. Always
 * grounded in the scan fixture and always guarded, so it cannot mask a bug. */
export const DEFAULT_FINAL_ANSWER =
  'Regime risk on dengan breadth 14 dari 20 koin long. SOLUSDT masih menjadi koin teratas dengan skor 81 dan trigger segar, jadi jawabannya tetap berbasis data scan ini.\n\n' +
  'Bukan saran finansial. Konfirmasi dan risiko tanggung sendiri.';

const WRITE_TOOL_NAME = 'send_telegram_notification';

// ---------------------------------------------------------------------------
// Dataset / fixture loading
// ---------------------------------------------------------------------------

export function readScanFixture(): string {
  return readFileSync(FIXTURE_PATH, 'utf8');
}

export function loadAgentDataset(): AgentEvalCase[] {
  const raw = readFileSync(DATASET_PATH, 'utf8');
  const cases: AgentEvalCase[] = [];
  raw.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    try {
      cases.push(JSON.parse(line) as AgentEvalCase);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`eval/agent/dataset.jsonl baris ${i + 1} bukan JSON valid: ${msg}`);
    }
  });
  if (cases.length === 0) throw new Error('eval/agent/dataset.jsonl kosong');
  const ids = new Set(cases.map((c) => c.id));
  if (ids.size !== cases.length) throw new Error('eval/agent/dataset.jsonl mengandung id duplikat');
  return cases;
}

// ---------------------------------------------------------------------------
// Fake tools: same names/params/scope as production, canned local data only.
// ---------------------------------------------------------------------------

interface FakeToolSpec {
  scope: 'read' | 'write';
  params: Record<string, ParamDef>;
  data: Record<string, unknown>;
  preview?: string;
}

const SYMBOL_PARAM: ParamDef = {
  type: 'string',
  description: 'Simbol koin, misalnya BTCUSDT',
  required: true,
};
const INTERVAL_PARAM: ParamDef = {
  type: 'string',
  description: 'Timeframe candle',
  enum: ['4h', '1d'],
};

const TOOL_SPECS: Record<string, FakeToolSpec> = {
  get_last_scan: {
    scope: 'read',
    params: {},
    data: {
      regime: 'risk on',
      confidence: 72,
      top: [{ symbol: 'SOLUSDT', score: 81, signal: 'strong_buy' }],
    },
  },
  analyze_structure: {
    scope: 'read',
    params: { symbol: SYMBOL_PARAM, interval: INTERVAL_PARAM },
    data: {
      symbol: 'BTCUSDT',
      interval: '4h',
      trend: 'downtrend',
      support: 80888,
      resistance: 83272,
    },
  },
  run_backtest: {
    scope: 'read',
    params: {
      symbol: SYMBOL_PARAM,
      index: { type: 'string', description: 'Simbol index' },
      interval: INTERVAL_PARAM,
    },
    data: { symbol: 'SOLUSDT', totalTrades: 4, winRate: 72 },
  },
  get_calibration: {
    scope: 'read',
    params: {},
    data: { lines: ['Rekam jejak live: sampel belum cukup (n=4)'] },
  },
  send_telegram_notification: {
    scope: 'write',
    params: { text: { type: 'string', description: 'Isi pesan', required: true } },
    data: { sent: true },
    preview: 'Ringkasan scan terakhir',
  },
};

/** Builds tools with plain JS counters — no vitest import in production code. */
export function buildFakeTools(names: string[], runs: ToolRunCounts): ToolDefinition[] {
  return names.map((name) => {
    const spec = TOOL_SPECS[name];
    if (!spec) throw new Error(`Tool "${name}" tidak dikenal dalam TOOL_SPECS`);
    runs[name] = 0;
    return {
      name,
      description: `Fake offline tool: ${name}`,
      scope: spec.scope,
      params: spec.params,
      run: async (): Promise<ToolOutcome> => {
        runs[name] = (runs[name] ?? 0) + 1;
        return {
          ok: true,
          data: spec.data,
          ...(spec.scope === 'write' ? { preview: spec.preview ?? name } : {}),
        };
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Scripted LLM trace
// ---------------------------------------------------------------------------

export function toLLMResponse(raw: ScriptedResponse, seqIndex: number): LLMResponse {
  const toolCalls = (raw.tool_calls ?? []).map((call, i) => ({
    id: call.id ?? `call_${seqIndex}_${i}`,
    name: call.name,
    arguments: JSON.stringify(call.arguments ?? {}),
  }));
  return { content: raw.content ?? '', toolCalls };
}

/** Policy used for every case; per-case overrides (budget) win. */
export function policyFor(testCase: AgentEvalCase) {
  return {
    maxSteps: 4,
    maxToolCalls: 3,
    requireConfirmationFor: [WRITE_TOOL_NAME],
    ...(testCase.policy ?? {}),
  };
}

/**
 * Pre-seed confirmation keys from the first scripted call of each confirmed
 * tool. The executor derives the same key from validated arguments, so a
 * mismatch here would be a real finding, not a harness artefact.
 */
export function confirmedKeysFor(testCase: AgentEvalCase): Set<string> {
  const keys = new Set<string>();
  for (const name of testCase.confirmed_tools ?? []) {
    const call = testCase.llm_sequence
      .flatMap((response) => response.tool_calls ?? [])
      .find((c) => c.name === name);
    if (!call) throw new Error(`${testCase.id}: confirmed_tools member "${name}" tidak dipanggil`);
    keys.add(idempotencyKey(EVAL_CHAT_ID, name, call.arguments ?? {}));
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Single-case harness (also used by tests/eval-agent.test.ts)
// ---------------------------------------------------------------------------

export interface AgentCaseRun {
  testCase: AgentEvalCase;
  result: AgentResult;
  runs: ToolRunCounts;
  judgement: AgentCaseResult;
}

export async function runAgentEvalCase(
  testCase: AgentEvalCase,
  context: string = readScanFixture()
): Promise<AgentCaseRun> {
  const runs: ToolRunCounts = {};
  const tools = buildFakeTools(testCase.tools, runs);
  const audit = new InMemoryAuditSink();

  let seqIndex = 0;
  let idCounter = 0;
  const deps: AgentDeps = {
    llm: async (): Promise<LLMResponse> => {
      const scripted = testCase.llm_sequence[seqIndex] ?? { content: DEFAULT_FINAL_ANSWER };
      const response = toLLMResponse(scripted, seqIndex);
      seqIndex += 1;
      return response;
    },
    audit,
    now: () => 1_700_000_000_000,
    id: () => `ev_${++idCounter}`,
  };

  const result = await runAgent({
    question: testCase.question,
    context,
    tools,
    policy: policyFor(testCase),
    deps,
    chatId: EVAL_CHAT_ID,
    confirmedKeys: confirmedKeysFor(testCase),
  });

  const judgement = judgeAgentCase(testCase, result, runs);
  return { testCase, result, runs, judgement };
}

// ---------------------------------------------------------------------------
// Aggregation + reporting
// ---------------------------------------------------------------------------

export interface AgentScenarioSummary {
  scenario: AgentScenario;
  total: number;
  passed: number;
  passRate: number;
}

export interface AgentEvalReport {
  generatedAt: string;
  source: 'scripted-agent-trace';
  threshold: number;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  weightedScore: number;
  byScenario: AgentScenarioSummary[];
  cases: AgentCaseResult[];
  suitePassed: boolean;
}

export function buildReport(cases: AgentCaseResult[]): AgentEvalReport {
  const total = cases.length;
  const passed = cases.filter((c) => c.passed).length;
  const passRate = total === 0 ? 0 : passed / total;
  const byScenarioMap = new Map<AgentScenario, { total: number; passed: number }>();
  for (const c of cases) {
    const acc = byScenarioMap.get(c.scenario) ?? { total: 0, passed: 0 };
    acc.total += 1;
    if (c.passed) acc.passed += 1;
    byScenarioMap.set(c.scenario, acc);
  }
  const byScenario = Array.from(byScenarioMap.entries())
    .map(([scenario, acc]) => ({
      scenario,
      total: acc.total,
      passed: acc.passed,
      passRate: acc.total === 0 ? 0 : acc.passed / acc.total,
    }))
    .sort((a, b) => a.scenario.localeCompare(b.scenario));

  return {
    generatedAt: new Date().toISOString(),
    source: 'scripted-agent-trace',
    threshold: SUITE_PASS_RATE_GATE,
    total,
    passed,
    failed: total - passed,
    passRate,
    weightedScore: total === 0 ? 0 : cases.reduce((sum, c) => sum + c.score, 0) / total,
    byScenario,
    cases,
    suitePassed: passRate >= SUITE_PASS_RATE_GATE,
  };
}

export function renderMarkdown(r: AgentEvalReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines: string[] = [
    '# Agent Runtime Evaluation Report',
    '',
    `- Generated: ${r.generatedAt}`,
    '- Source: scripted LLM traces + fake tools (fully offline)',
    `- Suite gate: pass rate >= ${pct(r.threshold)}`,
    '',
    `## Result: ${r.suitePassed ? 'PASS ✅' : 'FAIL ❌'}`,
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Cases | ${r.total} |`,
    `| Passed | ${r.passed} |`,
    `| Failed | ${r.failed} |`,
    `| Pass rate | ${pct(r.passRate)} |`,
    `| Weighted score | ${pct(r.weightedScore)} |`,
    '',
    '## By scenario',
    '',
    '| Scenario | Cases | Passed | Pass rate |',
    '| --- | ---: | ---: | ---: |',
  ];
  for (const s of r.byScenario) {
    lines.push(`| ${s.scenario} | ${s.total} | ${s.passed} | ${pct(s.passRate)} |`);
  }
  lines.push('', '## Findings', '');
  const failures = r.cases.filter((c) => !c.passed);
  if (failures.length === 0) {
    lines.push('No scenario regressions in this run.');
  } else {
    for (const c of failures) {
      lines.push(`### ${c.id} — ${c.scenario}`, '', `> ${c.question}`, '');
      for (const m of c.checks.filter((x) => !x.passed)) {
        lines.push(`- **${m.metric}**${m.blocking ? ' (blocking)' : ''}: ${m.detail}`);
      }
      lines.push('');
    }
  }
  lines.push(
    '',
    '## Method',
    '',
    'The real `runAgent` loop, executor, schema validation, audit sink and output ' +
      'guardrails are exercised. Only the LLM and tool I/O are replaced with local ' +
      'scripted traces and counters. See `docs/evaluation/agent-quality.md` for the ' +
      'metric definitions and the limits of this approach.',
    ''
  );
  return lines.join('\n');
}

export function writeAgentReport(r: AgentEvalReport): { json: string; md: string } {
  mkdirSync(REPORT_DIR, { recursive: true });
  const json = join(REPORT_DIR, 'agent-latest.json');
  const md = join(REPORT_DIR, 'agent-latest.md');
  writeFileSync(json, `${JSON.stringify(r, null, 2)}\n`, 'utf8');
  writeFileSync(md, renderMarkdown(r), 'utf8');
  return { json, md };
}

function renderSummary(r: AgentEvalReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines = [
    `Agent eval — ${r.suitePassed ? 'PASS' : 'FAIL'} (gate ${pct(r.threshold)})`,
    `Cases: ${r.passed}/${r.total} passed · pass rate ${pct(r.passRate)} · score ${pct(r.weightedScore)}`,
    '',
  ];
  for (const c of r.cases.filter((x) => !x.passed)) {
    const failed = c.checks.filter((m) => !m.passed).map((m) => m.metric).join(', ');
    lines.push(`  ✗ ${c.id} [${c.scenario}] ${failed}`);
  }
  return lines.join('\n');
}

export async function main(): Promise<void> {
  const cases = loadAgentDataset();
  const context = readScanFixture();
  const judgements: AgentCaseResult[] = [];
  for (const testCase of cases) {
    const run = await runAgentEvalCase(testCase, context);
    judgements.push(run.judgement);
  }

  const report = buildReport(judgements);
  const written = writeAgentReport(report);
  console.log(`\n${renderSummary(report)}`);
  console.log(`\nJSON: ${written.json}`);
  console.log(`Markdown: ${written.md}`);
  if (!report.suitePassed) process.exitCode = 1;
}

// `npm run eval:agent` executes this file directly; importing the harness from
// tests must not start a second run.
const invokedDirectly =
  typeof process.argv[1] === 'string' &&
  process.argv[1].replace(/\\/g, '/').includes('eval/agent/run.ts');
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exitCode = 1;
  });
}
