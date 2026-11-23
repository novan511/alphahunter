# Agent Runtime Quality Standard

This document defines how we measure the agentic runtime in `lib/agent/`. It is
written in English so a reviewer who did not build the runtime can read it
first. For the free-text chatbot answer quality standard, see
[quality-standard.md](./quality-standard.md); this document covers the layer
above it — tool choice, write safety, and loop completion.

## 1. What the two metrics mean

**Tool-selection accuracy** asks whether the agent used its capabilities
correctly:

- the expected tool was called, in the expected order;
- no forbidden tool was called (for example, a backtest for a pattern question);
- arguments passed validation, or an invalid-argument rejection was expected;
- a write tool never executed without a confirmed idempotency key;
- a tool rejected by validation/authorisation never ran its side effect;
- the exact number of `tool.run` invocations matches the case, where pinned.

**Task completion** asks whether the loop reached a correct terminal state:

- outcome and state match the expectation (`answered`/`done`,
  `needs_confirmation`/`awaiting_confirmation`, `budget_exceeded`/`blocked`, …);
- the step count stays within `max_steps`;
- the final answer contains the required facts and the financial disclaimer;
- the runtime did not silently fall back to the safe answer;
- required audit statuses are present (`executed`, `rejected`,
  `needs_confirmation`, …);
- a guardrail retry is visible in the audit trail when the case is about one;
- the final answer still passes the production `FORBIDDEN` claim regexes.

## 2. Metric table

| Dimension | Blocking | Weight | Judge |
|---|---:|---:|---|
| Expected tools called in order | yes | 3 | tool selection |
| No forbidden tool | yes | 3 | tool selection |
| Argument validity reflected in audit | yes | 2 | tool selection |
| No unauthorized write execution | yes | 3 | tool selection |
| Exact `tool.run` count (when pinned) | yes | 2 | tool selection |
| Rejected tool not run | yes | 2 | tool selection |
| Expected outcome | yes | 3 | completion |
| Expected state | yes | 2 | completion |
| Step budget | yes | 2 | completion |
| Required facts (`must_mention`) | yes | 2 | completion |
| Disclaimer (composed answers) | yes | 2 | completion |
| No safe fallback | yes | 2 | completion |
| Required audit statuses | yes | 2 | completion |
| Guardrail retry recorded | yes | 2 | completion |
| No forbidden claims | yes | 2 | completion |

```
case score   = Σ(weight of passed metrics) / Σ(weight of applied metrics)
case passed  = no blocking failure AND score >= 0.85
pass rate    = passed cases / total cases
suite passed = pass rate >= 0.90
```

Metrics that do not apply to a case (for example the disclaimer check on a
runtime-generated confirmation prompt) are excluded from the denominator,
exactly as in the chatbot eval.

## 3. How the scripted LLM sequence works

Each dataset case carries an `llm_sequence`: an ordered list of model turns.
`eval/agent/run.ts` shifts one turn per loop step and converts each turn into
the `LLMResponse` shape the real runtime expects. A turn with `tool_calls`
exercises the executor; a turn with only `content` is treated as a final answer
and goes through the real guardrail. If the sequence runs out, a fixed grounded
answer is returned so a harness gap cannot masquerade as a model failure.

This lets a case express multi-step behaviour without a model:

- **retry** — a forbidden answer, then a clean one (guardrail case);
- **confirmation gate** — a write call that stops with `needs_confirmation`, or
  the same call with a pre-seeded key that executes;
- **budget** — five tool calls scripted while the policy caps execution at two;
- **invalid arguments** — a call that the schema validator rejects before
  `tool.run` is reached.

Confirmation keys are computed with the production `idempotencyKey()` from the
first scripted call of each tool listed in `confirmed_tools`, so the
pre-confirm path is tested against the same key the executor derives.

## 4. Why scripted traces are legitimate regression tests

A scripted trace is not a claim about what a real model would say. It is a claim
about what the runtime **does** given a known model output. That is precisely
what the runtime owns: tool dispatch, validation, idempotency, confirmation,
audit, budgets, and guardrails. By pinning the model output we get:

- **Determinism** — the same case always exercises the same branch, in CI, with
  no temperature or provider drift;
- **Reachability** — rare but critical states (over-budget floods, invalid
  arguments, guardrail retries, unconfirmed writes) can be triggered on demand;
- **Isolation** — a failure points at a runtime regression, not at a model mood
  swing or a changed system prompt upstream.

The rules in `eval/agent/judge.ts` reuse production code where it exists (the
`FORBIDDEN` regex list from `lib/quant/marketNarrator.ts`) so the rubric cannot
silently drift from the guardrail it evaluates.

## 5. Limitations

This suite is deliberately narrow. It does **not** measure:

- **A real model.** Scripted traces are chosen by a human. They cannot reveal
  that a model picks the wrong tool, argues with the guardrail, or phrases an
  answer badly. They check that the runtime handles those cases correctly once
  they occur.
- **Real tool behaviour.** Fake tools return canned, grounded payloads and a
  plain call counter. No exchange API, Supabase read, or Telegram send happens.
  Backtest math, scan freshness, and rate limits are outside this suite.
- **Live traffic.** There is no end-to-end webhook, no real chat, no memory
  persistence, and no confirmation token round-trip through a user. The
  confirmation path is simulated by pre-seeding an idempotency key.
- **Model-side prompt quality.** The script bypasses the LLM; whether the
  system prompt actually induces the right tool call is a separate question,
  best answered with live smoke tests or an LLM-as-judge harness.

A passing `eval:agent` means the runtime's safety and control flow still behave
as specified. It does not mean the assistant will make the right decision in
production.
