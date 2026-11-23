# ADR 0004 — Runtime agentik dengan tool calling yang diaudit

- Status: accepted, dengan rencana migrasi
- Tanggal: 2026-11-23
- Terkait: `lib/agent/` (`types.ts`, `schema.ts`, `audit.ts`, `executor.ts`, `llm.ts`, `loop.ts`, `tools.ts`), `lib/telegramPersona.ts`, `lib/telegramAskPrompt.ts`, `lib/quant/marketNarrator.ts`, `docs/adr/0002-grounded-answers.md`

## Konteks

ADR 0002 membuat jawaban chatbot ter-ground ke data engine. Jalur itu efektif, tapi bersifat baca-saja dan statis: konteks disusun oleh kode sebelum LLM dipanggil, sehingga model tidak bisa mengambil data baru (struktur harga koin tertentu, hasil backtest) apalagi melakukan aksi. Kita ingin asisten yang bisa memilih dan memanggil tool — "analis agentik", bukan chatbot umum.

Di domain ini, LLM yang dibiarkan memanggil backend secara langsung membawa risiko yang tidak bisa diterima: argumen hasil generate yang invalid, aksi tulis tanpa izin pengguna, webhook Telegram yang di-retry sehingga notifikasi terkirim dua kali, dan klaim "sudah berhasil" padahal tool gagal. Guardrail jawaban di ADR 0002 harus tetap berlaku untuk jawaban akhir agen.

## Keputusan

Tool calling dibangun sebagai runtime kecil yang dipisahkan dari transport. Lapisannya:

1. **Inti transport-agnostic dan bebas dependency.** `lib/agent/types.ts`, `schema.ts`, `executor.ts`, dan `loop.ts` tidak tahu soal Telegram, Next.js, atau Supabase. Tidak ada zod maupun LangChain. Argumen divalidasi oleh validator tangan di `schema.ts` (`string`, `number`, `boolean`, `string[]`; wajib, `enum`, `min`/`max`, dan kunci asing ditolak). Transport menyuntik `AgentDeps` (`llm`, `audit`, opsional `now`/`id`), sehingga test bisa memakai LLM dan audit sink palsu tanpa jaringan.

2. **Pipeline satu tool call (`executor.ts`).** Urutannya tetap: whitelist `policy.allowedTools` → `validateToolArgs()` → `idempotencyKey()` → cek replay → confirmation gate → dry-run → timeout 8 detik → audit record. Kunci idempotensi adalah `sha256(chatId + toolName + argumen dengan kunci terurut)`, dipotong 32 karakter hex; replay hanya terjadi kalau audit record sebelumnya berstatus `executed`. Tool `scope: 'write'` yang tercantum di `policy.requireConfirmationFor` menghasilkan `PendingConfirmation` (token = kunci idempotensi, `expiresAt` 5 menit, instruksi `/confirm <key>`) dan mengembalikan `needs_confirmation` sebelum apa pun dieksekusi. Dry-run dipaksa untuk write tool yang belum dikonfirmasi, bisa juga lewat `policy.dryRun`. Setiap jalur — termasuk `rejected`, `cached`, `dry_run`, dan `failed` — meninggalkan `AuditRecord`. LLM tidak pernah menyentuh backend secara langsung.

3. **Loop yang dibatasi (`loop.ts`).** `runAgent` berjalan maksimal `maxSteps: 4` dengan `maxToolCalls: 3`. Tool call diubah jadi pesan `assistant` + observation `role: 'tool'` sebelum LLM dipanggil lagi, jadi model melihat hasilnya sebagai data, bukan sebagai instruksi. Ada satu kali retry guardrail. Kalau jawaban akhir masih melanggar, loop mengembalikan `SAFE_FALLBACK` dengan `outcome: 'error'`; kalau budget habis, `outcome: 'budget_exceeded'`. Jawaban akhir dicek dengan regex `FORBIDDEN` produksi, `numbersIn()`/`isKnownNumber()` terhadap `context` **dan observation tool yang sudah diterima**, keberadaan disclaimer, dan larangan artefak JSON/kode (minimal 40 karakter). Hasil `AgentResult` juga membawa `state` (`idle`/`tool_use`/`awaiting_confirmation`/`done`/`blocked`) dan `usage` untuk tracing.

4. **Adapter LLM terpisah (`llm.ts`).** `callLLMWithTools()` memakai field OpenAI-compatible `tools` dan `tool_choice: 'auto'`, dengan `llmEnv()` yang sama seperti jalur teks. Ini sengaja bukan `callLLM()`: yang terakhir hanya mengembalikan teks. Definisi tool diterjemahkan ke JSON schema dengan `additionalProperties: false`. Provider tanpa dukungan `tools` hanya mendapat satu jawaban teks — degradasi yang disadari.

5. **Tool menipis, prompt dipakai ulang (`tools.ts`, `loop.ts`).** Lima tool — `get_last_scan`, `analyze_structure`, `run_backtest`, `get_calibration` (baca) dan `send_telegram_notification` (tulis, butuh konfirmasi) — semuanya membungkus fungsi backend yang sudah teruji. Proyeksinya sengaja ringkas supaya konteks model tetap kecil. `runAgent` memakai `buildAskPrompt()` dan `TELEGRAM_SYSTEM_PROMPT` yang sama dengan webhook, plus `AGENT_INSTRUCTIONS`; aturan persona/grounding tidak diduplikasi.

6. **Audit sink & confirmation store.** `audit.ts` menyediakan dua implementasi dengan antarmuka yang sama: `InMemoryAuditSink` / `InMemoryConfirmationStore` untuk test, dan `SupabaseAuditSink` / `SupabaseConfirmationStore` untuk produksi. `getDefaultAuditSink()` dan `getDefaultConfirmationStore()` memilih yang durable bila `getSupabaseAdmin()` tersedia, kalau tidak fallback ke memori. Migrasi `022_agent_audit.sql` membuat `agent_audit` (partial unique index pada `idempotency_key` yang berstatus `executed`) dan `agent_confirmation`; keduanya RLS-only service-role karena anon key ikut ter-bundle ke browser.

7. **Replay persis tool call (`loop.ts`, `pages/api/telegram-webhook.ts`).** `/confirm` menyimpan nama tool dan argumen mentah hasil generate, lalu memanggil `runAgent` dengan opsi `replayCall`. Pada iterasi pertama, executor menjalankan tepat call itu — model tidak diberi kesempatan memilih ulang — baru setelah itu LLM menyusun jawaban akhir. Argumen mentah diambil dari baris audit `needs_confirmation` bila field `arguments` tidak tersedia, jadi tidak ada dependency baru pada executor.

## Alternatif yang ditimbang

| Opsi | Kenapa tidak dipilih |
|---|---|
| LangChain / CrewAI | Dependency dan lapisan abstraksi tambahan untuk sesuatu yang bisa ditulis dalam beberapa ratus baris; agent framework juga menyembunyikan guardrail produksi di balik abstraction yang sulit diuji tanpa jaringan. Kita sudah punya prompt, regex `FORBIDDEN`, dan kalibrasi sendiri. |
| LLM bebas tanpa tool | Tidak bisa menjawab "struktur ETH sekarang" atau menjalankan backtest selain dari konteks statis, dan tidak bisa melakukan aksi sama sekali. Memaksanya menebak justru mengulang masalah yang sudah dicegah ADR 0002. |
| zod / ajv untuk validasi argumen | Menambah dependency untuk kebutuhan yang hanya mencakup empat tipe primitif; validator tangan di `schema.ts` cukup, dan pipeline audit serta pesan error berbahasa Indonesia terintegrasi langsung. |
| `/confirm` menjalankan ulang seluruh agent | Model bisa memilih argumen berbeda saat replay, sehingga kunci idempotensinya berubah dan aksi tulis tertolak — atau lebih buruk, menulis sesuatu yang tidak disetujui. Replay tool call asal dipilih. |

## Konsekuensi

- Setiap tool call bisa ditelusur lewat `AuditRecord` (status, argumen, kunci idempotensi, durasi, hasil). Argumen invalid ditolak sebelum backend dipanggil; aksi tulis tidak mungkin berjalan tanpa konfirmasi; retry dalam satu proses tidak mengirim notifikasi dobel.
- **Durabilitas bergantung pada kredensial admin.** Bila `SUPABASE_SERVICE_ROLE_KEY` dan migrasi 022 aktif, audit dan konfirmasi selamat dari deploy serta bisa dipakai lintas instance. Tanpa itu keduanya diam-diam jatuh ke store in-memory per-proses — aman untuk development, bukan jaminan produksi. Migrasi 022 harus dijalankan manual di SQL Editor.
- TTL 5 menit ditegakkan di `ConfirmationStore.consume()` (baik versi Supabase maupun in-memory), bukan cuma di helper webhook. Setelah dikonfirmasi, kunci idempotensinya tetap dikenal sampai proses berhenti — ini disengaja supaya replay tidak terhapus saat jendela konfirmasi lewat. Token itu sendiri sekali pakai.
- Proyeksi tool membuang detail mentah (mis. hanya 5 ranking teratas, 3 pola). Ini disengaja untuk menjaga ukuran konteks, tapi berarti agen tidak bisa menggali payload penuh.
- Agent dipasang sebagai jalur **opt-in** di webhook: `/agent <pertanyaan>` dan `/confirm <token>`. Obrolan bebas masih lewat `handleAsk()` dengan `callLLM()` text-only, sehingga perilaku lama tidak berubah. Keputusan ini sengaja: agent bisa diuji dan dimatikan tanpa mengganggu bot yang sudah dipakai owner.
- Guardrail angka menggabungkan `context` statis dengan angka dari observation tool, sehingga angka hasil tool tidak salah ditolak. Angka dari pengetahuan umum di luar keduanya tetap ditolak — ini disengaja di domain finansial.
- `/confirm` kini memutar **persis tool call asli** lewat opsi `replayCall` di `runAgent`: nama tool dan argumen mentah diambil dari `agent_confirmation`, bukan dipilih ulang oleh model. Model hanya menyusun jawaban akhir. Ini menutup celah lama di mana model bisa mengganti argumen saat replay. Kalau replay gagal, loop jatuh ke jalur normal dan tetap diaudit.
- Biaya dan latena naik: sampai empat panggilan LLM dan tiga tool call per pertanyaan.

## Verifikasi

`npm test` — `tests/agent-core.test.ts` (validator, idempotensi, confirmation gate, dry-run, budget, guardrail dengan LLM/audit palsu; fixture scan memakai file yang sama dengan `eval/`) dan `tests/agent-webhook.test.ts` (TTL, single-use consume, token asing/kedaluwarsa). `npm run typecheck`, `npm run eval`. Belum ada verifikasi terhadap lalu lintas nyata.
