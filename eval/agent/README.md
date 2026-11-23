# Agent runtime evaluation

Offline regression suite for the agentic runtime in `lib/agent/`. It measures two
things that the chatbot answer eval (`eval/dataset.jsonl`) cannot see:

- **Tool-selection accuracy** — did the agent call the right tool, with valid
  arguments, in the right order, and did it respect the write/confirmation
  boundary?
- **Task completion** — did the loop finish with the expected outcome and state,
  within its step budget, with the required audit trail and a grounded answer?

Run it from the repository root:

```bash
npm run eval:agent   # writes eval/reports/agent-latest.{md,json}
npm run eval:all     # chatbot eval followed by agent eval
```

The suite is fully offline: no API key, no network, no Supabase. `runAgent`,
the executor, schema validation, audit sink and output guardrails are the real
production modules. Only the LLM and the tool I/O boundaries are replaced.

## Dataset format

One JSON object per line in `eval/agent/dataset.jsonl`:

```json
{
  "id": "AG-01",
  "question": "Kondisi pasar hari ini gimana?",
  "scenario": "read_tool",
  "llm_sequence": [
    { "tool_calls": [{ "name": "get_last_scan", "arguments": {} }], "content": "" },
    { "content": "...final answer ending with the disclaimer..." }
  ],
  "expectation": {
    "expected_tools": ["get_last_scan"],
    "forbidden_tools": ["run_backtest"],
    "expected_outcome": "answered",
    "expected_state": "done",
    "max_steps": 4,
    "require_audit_statuses": ["executed"],
    "must_mention": ["risk on"]
  },
  "tools": ["get_last_scan", "analyze_structure"]
}
```

Optional fields:

- `confirmed_tools` — tool names whose idempotency key is pre-seeded so a write
  tool executes instead of returning `needs_confirmation`.
- `policy` — per-case overrides of the default `{ maxSteps: 4, maxToolCalls: 3,
  requireConfirmationFor: ['send_telegram_notification'] }` (used by the budget
  case).
- `expectation.expected_tool_runs` — exact number of `tool.run` invocations.

`scenario` is one of `read_tool`, `write_guard`, `no_tool`, `budget`,
`guardrail`, `missing_arg`.

## How the scripted trace works

Each `llm_sequence` entry becomes one `LLMResponse` in order. Entries with
`tool_calls` are fed to the real executor; entries with only `content` are
treated as final answers and pass through the real guardrail. The runner shifts
through the sequence one response per loop step, so the script can express a
retry (guardrail case), a confirmation gate (write cases), or an over-budget
flood of calls (budget case). If the sequence is exhausted, a fixed grounded
answer is returned so a harness gap cannot be mistaken for a model failure.

Final answers in the dataset must use only numbers from
`eval/fixtures/scan-2026-11-22.txt` (or a fake tool's canned data) and must end
with `Bukan saran finansial. Konfirmasi dan risiko tanggung sendiri.` — otherwise
the production guardrail rejects them and retries, which would make the case
fail for the wrong reason.

## Scoring

See `docs/evaluation/agent-quality.md`. A case passes when no blocking check
fails and its weighted score is at least `0.85`. The suite passes when the pass
rate is at least `0.90`; `run.ts` sets `process.exitCode = 1` otherwise.
