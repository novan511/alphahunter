# Chatbot evaluation harness

Offline, deterministic evaluation of the Telegram assistant. No API key, network, or Supabase
needed for the default run.

```bash
npm run eval                        # recorded answers, rule checks (CI gate)
npm run eval -- --threshold 0.95    # stricter gate
npm run eval -- --generate          # regenerate answers with the configured LLM
npm run eval -- --judge=llm         # add LLM-as-judge advisory scores
npm run eval:generate               # shorthand for --generate
npm run eval:judge                  # shorthand for --generate --judge=llm
```

Layout:

- `dataset.jsonl` — recorded cases, one JSON object per line
- `fixtures/scan-2026-11-22.txt` — the grounded scan snapshot injected into every case
- `judge.ts` — rule-based metrics; reuses production guardrails
- `run.ts` — CLI, optional generation and LLM judge, report assembly
- `report.ts` — Markdown/JSON rendering
- `reports/latest.md` and `latest.json` — generated, gitignored

Read `docs/evaluation/quality-standard.md` for the rubric and
`docs/evaluation/scenario-taxonomy.md` for what each scenario means.
