# Engineering journal — five bugs worth talking about

A portfolio should show not only what was built, but what went wrong and how it was found. These are five real defects from the agent runtime work, each with the symptom, how it was detected, the fix, and the general lesson. They are good interview material for "tell me about a failure you debugged".

---

## 1. Incomplete tool-call/response pairs

**Symptom.** When the model emitted more tool calls than the remaining budget, the loop pushed an assistant message containing all `tool_calls` but only executed — and replied for — the first few. The next provider request had assistant tool calls without matching `tool` messages.

**Detected by.** Reading the loop while writing the budget test, before it reached production. The test asserted `toolCalls === 2` but would not have caught the malformed message sequence on its own.

**Fix.** Slice the tool calls to the remaining budget *before* constructing the assistant message. Every accepted call now gets exactly one `tool` observation; rejected overflow calls never enter the conversation.

**Lesson.** Protocol invariants (request/response pairing) are easy to violate in a loop that mutates messages. Assert the shape of the message history, not just the counters.

---

## 2. The guardrail rejected legitimate tool-sourced numbers

**Symptom.** The final-answer check compared every number against the static scan context. A number returned by an accepted tool but absent from that context — e.g. a support level freshly computed by `analyze_structure` — was flagged as a hallucination and triggered a correction turn.

**Detected by.** Review by a second agent while documenting the runtime. Unit tests passed because their fake tools returned numbers already present in the fixture.

**Fix.** `finalAnswerIssues()` now accepts extra numbers collected from all accepted `tool` observations. Context and tool results are both legitimate sources; anything else is still rejected.

**Lesson.** A guardrail that is stricter than the system's own data flow produces false positives and trains the model to apologise for correct answers.

---

## 3. The durable sink could never activate under ESM

**Symptom.** `getAdminClient()` used a guarded `typeof require !== 'function'` check. Under Vitest / ESM the guard returned null, so the "durable" Supabase path was unreachable in exactly the environments where it was supposed to be configured.

**Detected by.** Code review after the durable store landed. Tests were green because they only exercised the in-memory fallback.

**Fix.** Replaced the `require` hack with a static import of `getSupabaseAdmin()`. The function reads env only when called, so tests with no env still get a clean fallback.

**Lesson.** Lazy initialization is fine; runtime feature-detection of the module system is not. Prefer normal imports and lazy *calls*.

---

## 4. TS2589 on the Supabase client cast

**Symptom.** `client as SupabaseLike` made TypeScript expand the deeply generic Supabase client type and fail with "Type instantiation is excessively deep and possibly infinite."

**Detected by.** `npm run typecheck` immediately after the import change.

**Fix.** Cast through `unknown`: `client as unknown as SupabaseLike`. The structural interface is intentionally minimal, so the double cast is honest — we only need `.from().insert/select`.

**Lesson.** When adapting a heavily generic third-party client, define a narrow structural interface and cast through `unknown` instead of fighting its type parameters.

---

## 5. `/confirm` re-ran the whole agent

**Symptom.** After a write tool returned `needs_confirmation`, `/confirm` re-invoked `runAgent` with the confirmed idempotency key added. If the model chose different arguments on that second run, the key changed and the write was denied again — annoying at best, wrong-data risk at worst.

**Detected by.** Design review of the confirmation flow. The mechanism "worked" in the happy path, so no test failed.

**Fix.** Store the tool name and raw arguments with the pending confirmation. Add `replayCall` to `runAgent`: on the first iteration it executes exactly that call, then lets the LLM compose only the final answer. Confirmed keys are now a replay mechanism, not a second guess.

**Lesson.** "Ask the model again" is not idempotent. Anything the user explicitly approved must be frozen and replayed byte-for-byte.
