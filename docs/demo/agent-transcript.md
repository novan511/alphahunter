# Demo walkthrough — one agent request, end to end

This is an **illustrative transcript** reconstructed from the offline harness and the code paths, not a screenshot of live Telegram traffic. It is meant to make the agent behaviour readable to a reviewer who does not want to parse JSON artefacts.

Fixture used: `eval/fixtures/scan-2026-11-22.txt`.

---

### 1. User asks for something that requires an action

> **Owner:** `/agent Kirim ringkasan SOL ke Telegram ya, sekalian kasih status timingnya`

The webhook slices the question to 500 chars, applies the 30-second rate limiter, loads `scanContext()`, `formatMemory()` and calls `runAgent`.

### 2. Model proposes tools

```json
{
  "tool_calls": [
    { "name": "get_last_scan", "arguments": "{}" },
    { "name": "send_telegram_notification", "arguments": "{\"text\":\"SOLUSDT skor 81 masih segar, invalidasi di support 168.\"}" }
  ]
}
```

Both are in `policy.allowedTools`. The first is `read` and executes immediately. The second is `write` and is listed in `requireConfirmationFor`, so the executor stops before any side effect:

```
AuditRecord {
  status: "needs_confirmation",
  toolName: "send_telegram_notification",
  idempotencyKey: "3f9c…a12",
  args: { text: "SOLUSDT skor 81 masih segar, invalidasi di support 168." },
  detail: "menunggu konfirmasi: send_telegram_notification(text=\"…\")"
}
```

### 3. Bot asks for approval

> **Bot:** Aksi ini akan menulis data: send_telegram_notification(text="SOLUSDT skor 81 masih segar, invalidasi di support 168."). Ketik /confirm 3f9c…a12 untuk melanjutkan (berlaku 5 menit).

The token, raw arguments, original question and chat id are persisted in `agent_confirmation` when the admin client is configured.

### 4. User confirms

> **Owner:** `/confirm 3f9c…a12`

`consume()` is single-use and checks the 5-minute TTL. The webhook then calls `runAgent` with `replayCall`:

```ts
{
  toolName: 'send_telegram_notification',
  arguments: '{"text":"SOLUSDT skor 81 masih segar, invalidasi di support 168."}',
  confirmedKeys: new Set(['3f9c…a12'])
}
```

The first loop iteration executes **that exact call**. The model is not asked to choose a tool again. Only after the observation is appended does the LLM compose the final answer.

### 5. Final answer

> **Bot:** Regime risk on, breadth 14 dari 20 koin long. SOLUSDT skor 81 masih segar, dan pesan ringkasnya sudah saya kirim ke chat ini. Yang paling bisa membatalkan tesis adalah return ke bawah support 168.
>
> Bukan saran finansial. Konfirmasi dan risiko tanggung sendiri.

### 6. What the audit trail shows

| # | status | tool | idempotency key | note |
|---|---|---|---|---|
| 1 | `executed` | `get_last_scan` | — | read-only, result cached in trace |
| 2 | `needs_confirmation` | `send_telegram_notification` | `3f9c…a12` | no side effect |
| 3 | `executed` | `send_telegram_notification` | `3f9c…a12` | replay of the approved call |
| 4 | `cached` | `send_telegram_notification` | `3f9c…a12` | if the webhook retried, no second message |

### Why this is the interesting part

Most agent demos stop at "the model called a function". The engineering question is what happens when the call writes something, the transport retries, or the model changes its mind between approval and execution. Steps 2–6 are the part that makes this a portfolio piece rather than a tutorial.

Run the offline equivalent yourself:

```bash
npm run eval:agent
cat eval/reports/agent-latest.md
```
