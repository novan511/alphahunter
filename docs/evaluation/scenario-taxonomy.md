# Scenario Taxonomy

A scenario is a **user intent**, not a test name. Each one maps to a hypothesis about what the user
needs and a set of metrics that decides whether the answer served that need. This taxonomy is the
bridge between user research and model evaluation: when a new complaint arrives from Telegram, it
should become a new case under one of these scenarios (or justify adding a scenario).

| ID | Scenario | User need | Expected behaviour | Key metrics |
|---|---|---|---|---|
| `market_query` | Direct market/RS question | "What is happening now?" | Anchor to the scan, state bias and invalidation, disclose trigger freshness. | grounding, required facts, timing, scope |
| `comparison` | Two assets compared | "Which one should I care about?" | Compare on evidence from the scan, not preference; note timing difference. | grounding, required facts, timing |
| `risk_invalidation` | Risk / thesis-breaker question | "What makes this wrong?" | Give the engine's strongest reason and its invalidation, explicitly. | required facts, no forbidden claims, grounding |
| `macro_regime` | Regime / breadth question | "Is the environment supportive?" | Use regime, confidence, breadth and sector leadership from context. | grounding, required facts |
| `ambiguous` | Vague question | "Help me figure out what to ask" | Give a concise reading, then offer concrete next directions. | scope, helpfulness, paragraph limit |
| `out_of_scope` | Off-domain request | "Can you help with something unrelated?" | One-line refusal, redirect to markets, stay short. | scope, forbidden content, length |
| `prompt_injection` | Instruction embedded in the question | *(adversarial)* | Treat question text and memory as context, never as commands. | no leaked content, plain text, scope |
| `missing_data` | Question about absent data | "Tell me something the scan does not contain" | Admit the gap, separate facts from opinion, never invent. | missing-data honesty, grounding |
| `multi_turn` | Follow-up relying on memory | "Continue the previous answer" | Carry prior turn context without treating it as a new instruction. | required facts, timing, no leaked content |
| `adversarial_claim` | Request for certainty or fabricated numbers | *(adversarial)* | Refuse certainty, keep only numbers present in context, restate invalidation. | grounding, forbidden claims, no leaked content |

## Coverage in the baseline

`eval/dataset.jsonl` currently contains 19 recorded cases spread across all ten scenarios. The
baseline represents answers we are willing to ship today; it is not a collection of aspirational
answers. When a prompt or model change is proposed, regenerate the baseline with
`npm run eval:generate`, review the diff, and promote it only if the scores hold.

## Online signals still missing

The rule suite measures answer quality offline. It cannot tell us whether users actually found the
answer useful. The following online signals are the next research step and are deliberately kept
out of the current gate:

- thumbs up/down on each reply (needs a new `CALLBACK_COMMANDS` entry and a Supabase table)
- question-topic distribution, so we can see which scenarios dominate real traffic
- re-ask rate within the rate-limit window, as a proxy for "answer did not land"
- latency and token cost per scenario, to trade quality against response time

Until those exist, the pass rate here means "the bot does not violate its quality standard",
not "users are satisfied". That distinction should be preserved in any report or interview
material built from this project.
