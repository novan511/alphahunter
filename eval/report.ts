/** Renders an evaluation report as Markdown and writes both artefacts. */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalReport } from './types';

export function renderMarkdown(r: EvalReport): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines: string[] = [];

  lines.push('# Chatbot Evaluation Report');
  lines.push('');
  lines.push(`- Generated: ${r.generatedAt}`);
  lines.push(`- Source: ${r.source === 'generated' ? 'fresh LLM generation (\`--generate\`)' : 'recorded baseline answers'}`);
  lines.push(`- Model: ${r.model}`);
  lines.push(`- LLM-as-judge: ${r.llmJudge ? 'enabled' : 'disabled (rules only)'}`);
  lines.push(`- Suite gate: pass rate >= ${pct(r.threshold)}`);
  lines.push('');
  lines.push(`## Result: ${r.suitePassed ? 'PASS ✅' : 'FAIL ❌'}`);
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Cases | ${r.total} |`);
  lines.push(`| Passed | ${r.passed} |`);
  lines.push(`| Failed | ${r.failed} |`);
  lines.push(`| Pass rate | ${pct(r.passRate)} |`);
  lines.push(`| Weighted quality score | ${pct(r.weightedScore)} |`);
  lines.push('');

  lines.push('## By scenario');
  lines.push('');
  lines.push('| Scenario | Cases | Passed | Pass rate |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const s of r.byScenario) {
    lines.push(`| ${s.scenario} | ${s.total} | ${s.passed} | ${pct(s.passRate)} |`);
  }
  lines.push('');

  const failures = r.cases.filter((c) => !c.passed);
  if (failures.length === 0) {
    lines.push('## Findings');
    lines.push('');
    lines.push('No scenario regressions in this run.');
  } else {
    lines.push('## Findings');
    lines.push('');
    for (const c of failures) {
      lines.push(`### ${c.id} — ${c.scenario}`);
      lines.push('');
      lines.push(`> ${c.prompt}`);
      lines.push('');
      for (const m of c.metrics.filter((x) => !x.passed)) {
        lines.push(`- **${m.metric}**${m.blocking ? ' (blocking)' : ''}: ${m.detail}`);
      }
      lines.push('');
    }
  }

  lines.push('');
  lines.push('## Method');
  lines.push('');
  lines.push(
    'Rule checks reuse production guardrails from `lib/quant/marketNarrator.ts` ' +
      '(forbidden-claim regexes, number grounding) so the rubric cannot drift from the chatbot. ' +
      'Blocking violations fail a case regardless of score. The optional LLM-as-judge pass adds ' +
      'four advisory dimensions (grounding, scope, helpfulness, tone).'
  );
  lines.push('');

  return lines.join('\n');
}

/** Writes `latest.json` and `latest.md` under the given directory. */
export function writeReport(report: EvalReport, outDir: string): { json: string; md: string } {
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, 'latest.json');
  const mdPath = join(outDir, 'latest.md');
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeFileSync(mdPath, renderMarkdown(report), 'utf8');
  return { json: jsonPath, md: mdPath };
}
