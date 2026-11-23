# Althunter

**Relative Strength Decoupling Hunter** — mesin deteksi kekuatan relatif crypto dengan backtest, dashboard web, dan asisten LLM di Telegram.

Althunter memindai ratusan aset, mencari koin yang mulai terlepas dari index (BTC), lalu menerjemahkan hasilnya menjadi analisis bahasa Indonesia yang bisa dikonsumsi lewat web atau obrolan Telegram. Bot Telegram-nya bukan echo bot: setiap jawaban di-*ground* ke hasil scan terakhir, struktur harga live, funding/CVD, dan rekam jejak sinyal yang sudah lewat.

> ⚠️ Proyek ini adalah alat riset dan simulasi. Bukan saran finansial, bukan eksekusi broker, dan bukan jaminan profit.

> Ringkasan berbahasa Inggris untuk keperluan portofolio: [PORTFOLIO.md](PORTFOLIO.md)

## Isi

- [Arsitektur](#arsitektur)
- [Apa yang bisa dilakukan bot Telegram](#apa-yang-bisa-dilakukan-bot-telegram)
- [Cara bot menjawab](#cara-bot-menjawab)
- [Stack](#stack)
- [Quickstart lokal](#quickstart-lokal)
- [Konfigurasi](#konfigurasi)
- [Deploy](#deploy)
- [Kualitas & test](#kualitas--test)
- [Struktur proyek](#struktur-proyek)
- [Dokumen desain](#dokumen-desain)
- [Batasan](#batasan)

## Arsitektur

```mermaid
flowchart LR
    subgraph Sumber[Data]
        EX[Exchange / Yahoo / macro]
        SB[(Supabase)]
    end

    subgraph Engine[Engine deterministik]
        SCAN[Scanner + RS / regime]
        ALERT[Early warning + kalibrasi]
        MATRIX[Correlation / rotasi]
    end

    subgraph App[Next.js API]
        HOOK[telegram-webhook]
        CRON[scan / futures / morning cron]
        API[/api/explain, /api/quant, /api/arena]
    end

    LLM[LLM OpenAI-compatible<br/>DeepSeek / NVIDIA]

    EX --> SCAN --> SB
    SCAN --> ALERT
    SCAN --> MATRIX
    SB --> HOOK
    EX --> HOOK
    MATRIX --> HOOK
    HOOK --> LLM
    LLM --> HOOK
    HOOK --> TG[Telegram Bot API]
    CRON --> TG
    API --> WEB[Dashboard React]
    WEB --> API
```

Alur satu pesan Telegram:

```
pesan masuk
  → validasi chat id + webhook secret + dedup update_id
  → slash command?  ya → handler deterministik (/status, /matrix, /pair, /hold, …)
                     tidak → handleAsk()
                               → muat riwayat percakapan (Supabase)
                               → susun konteks dari scan + data live
                               → LLM dengan persona + guardrail
                               → simpan riwayat balasan
  → kirim balasan (plain text, ≤3500 char)
```

## Apa yang bisa dilakukan bot Telegram

| Perintah | Fungsi |
|---|---|
| `/start`, `/help` | Daftar perintah + tombol pintasan |
| `/status` | Regime, umur scan, sektor early & terkonfirmasi |
| `/top` | 5 koin paling tradeable dari scan terakhir |
| `/watch` | Koin dengan tren tapi pemicu belum muncul |
| `/matrix [tf] [window]` | Ranking kekuatan antar-koin, mis. `/matrix 4h 30` |
| `/pair A B [tf]` | Arah relatif A/B dalam kata-kata |
| `/hold [tf] [window]` | Verdict rotasi: tahan / kurangi / buang |
| `/scan` | Memanggil scan ulang, lalu analisis |
| teks bebas | Diskusi natural dengan persona trader (multi-turn) |

Bot hanya membalas `TELEGRAM_CHAT_ID` yang terdaftar. Orang lain dibungkam (bukan dijawab "unauthorized") supaya tidak mengonfirmasi keberadaan bot.

Contoh obrolan:

```
Kamu: gimana pandanganmu soal SOL sekarang?
Bot:  📊 REGIME — Pasar masih risk-on tapi breadth menyempit...
      📈 RELATIVE STRENGTH — SOL masuk 3 teratas vs basket...
      ⚠️ RISIKO — Trigger 5 bar lalu: sudah telat, tunggu pullback...
      Bukan saran finansial. Konfirmasi dan risiko tanggung sendiri.
```

## Cara bot menjawab

Bagian ini yang paling relevan kalau kamu menilai proyek ini dari sisi LLM engineering:

1. **Persona & scope guard** — `lib/telegramPersona.ts` membatasi bot hanya pada topik pasar/keuangan; di luar itu ditolak satu kalimat.
2. **Grounding, bukan free chat** — jawaban wajib bersumber dari `scanContext()`: scan Supabase, alasan & risiko per koin dari engine, struktur 4h/1d yang dihitung live, funding/CVD live, dan rekam jejak live.
3. **Anti-halusinasi** — prompt melarang angka/berita/katalis yang tidak ada di konteks; kalau data tidak cukup, bot bilang terus terang.
4. **Memory multi-turn** — riwayat per chat disimpan di Supabase (`telegram_chat_memory`) dan disuntikkan sebagai konteks, dibatasi N pesan terakhir.
5. **Rate limiting** — cooldown 30 detik per chat untuk mencegah pemborosan token.
6. **Graceful degradation** — LLM error → pesan error yang jelas + saran perintah deterministik; data live gagal → analisis tetap jalan dengan data scan saja.
7. **Keamanan & UX** — validasi secret token webhook, dedup `update_id`, batas 500 karakter pertanyaan, indikator "typing", tombol pintasan inline, dan perintah hanya untuk chat yang diizinkan.
8. **Observability** — satu baris log JSON per update (tanpa isi pesan/token) dan `GET /api/health` untuk cek konfigurasi setelah deploy.

## Stack

- **Frontend:** Next.js 14 (Pages Router), React 18, TypeScript, lightweight-charts
- **Backend:** Next.js API routes, Supabase (Postgres)
- **LLM:** OpenAI-compatible chat API (DeepSeek untuk obrolan Telegram, NVIDIA untuk penjelasan web)
- **Infra:** Vercel + GitHub Actions (cron scan, futures, morning report, arena step)

## Quickstart lokal

```bash
git clone <repo-url> althunter
cd althunter
npm ci
cp .env.local.example .env.local
# isi variabel minimal: Supabase, Telegram, LLM (lihat tabel di bawah)
npm run dev
```

Buka `http://localhost:3000`. Untuk bot, jalankan setup sekali:

```bash
npx tsx scripts/telegram-setup.ts
```

Script ini menampilkan identitas bot, chat id yang baru saja mengirim pesan, lalu mendaftarkan webhook + menu perintah. Setelah itu chat bot dan kirim `/help`.

> `npm run dev` di laptop memakai `.env.local`; deployment Vercel memakai Environment Variables di dashboard — keduanya harus diisi, bukan salah satu.

## Konfigurasi

| Variabel | Wajib | Fungsi |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ya | Persistensi scan & memory bot |
| `TELEGRAM_BOT_TOKEN` | ya | Token dari @BotFather |
| `TELEGRAM_CHAT_ID` | ya | Satu-satunya chat yang dilayani |
| `TELEGRAM_WEBHOOK_SECRET` | disarankan | Secret token untuk validasi `X-Telegram-Bot-Api-Secret-Token` |
| `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` | ya untuk AI chat | Endpoint chat-compatible (mis. DeepSeek) |
| `NVIDIA_API_KEY` | tidak | Penjelasan AI di dashboard (`/api/explain`) |
| `SCAN_CRON_SECRET` | ya untuk cron | Bearer token untuk route terjaga |
| `VERCEL_URL` | ya di Vercel | Origin yang dipanggil GitHub Actions |
| `BINANCE_BASE_URL` | tidak | Default: `https://data-api.binance.vision` |

Jangan pernah mengisi `TELEGRAM_BOT_TOKEN` dengan prefix `NEXT_PUBLIC_` — token hanya boleh hidup di server.

## Deploy

1. Deploy ke Vercel, lalu isi semua variabel di atas di **Settings → Environment Variables**.
2. Jalankan SQL di `supabase/migrations/` (terutama `012_signal_ledger.sql` sampai `021_telegram_chat_memory.sql`) lewat SQL Editor.
3. Set GitHub Secrets: `VERCEL_URL`, `SCAN_CRON_SECRET`, `ARENA_CONTROL_TOKEN` (untuk workflow arena).
4. Daftarkan webhook Telegram:

```bash
npx tsx scripts/telegram-setup.ts
```

Atau manual:

```
https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<domain>/api/telegram-webhook
```

Cek status dengan `getWebhookInfo`, lalu verifikasi `GET /api/health`. Endpoint health hanya mengembalikan boolean (tanpa token/chat id), jadi aman dibuka di browser:

```json
{ "ok": true, "checks": { "telegramToken": true, "telegramChatId": true, "telegramWebhookSecret": true, "llm": true, "supabase": true, "cronSecret": true }, "model": "deepseek-chat", "uptimeSeconds": 120 }
```

## Kualitas & test

```bash
npm run typecheck     # tsc --noEmit
npm run lint          # next lint
npm test              # Vitest (unit + webhook dengan fetch di-mock)
npm run eval          # evaluation chatbot (offline, tanpa API key)
npm run eval:agent    # evaluation agent: tool selection + task completion
npm run eval:all      # keduanya
npm run build         # build produksi
```

Script di `scripts/` terdiri dari dua jenis:

- `probe-*` — pemeriksaan offline/pure logic, aman dipanggil CI.
- `smoke-*` — integrasi yang menyentuh jaringan atau Supabase; dijalankan manual:

```bash
npx tsx scripts/smoke-telegram.ts
```

CI di `.github/workflows/ci.yml` menjalankan typecheck, lint, test, kedua evaluation gate, dan build pada setiap push dan pull request. Laporan eval di-upload sebagai artifact.

## Struktur proyek

```
pages/
  api/telegram-webhook.ts   router perintah + AI chat + laporan pagi
  api/health.ts             health check konfigurasi
  api/scan*.ts, quant*.ts   engine & cron endpoints
  index.tsx, backtest.tsx, ml-dashboard.tsx, arena.tsx  dashboard
lib/
  telegramPersona.ts        system prompt + scope guard
  telegramAskPrompt.ts      user prompt (dipakai webhook + evaluator)
  telegramMemory.ts         riwayat percakapan per chat
  serverTelegram.ts         pengirim pesan + setup webhook
  quant/marketNarrator.ts   callLLM + narrator
  agent/                    runtime agentik: tool calling + guardrail + audit (ADR 0004)
  algorithms/, quant/       logika deterministik
eval/                       evaluation harness chatbot + agent (offline)
  agent/                    tool-selection accuracy + task completion
supabase/migrations/        skema + RLS + write lock
scripts/                    probe, smoke, dan setup bot
docs/adr/                   decision records
```

## Dokumen desain

- `docs/ARCHITECTURE.md` — panduan arsitektur dan kontrak antar modul
- `docs/agent-architecture.md` — arsitektur runtime agentik (tool calling, audit, konfirmasi)
- `docs/adr/0001-webhook-over-polling.md`
- `docs/adr/0002-grounded-answers.md`
- `docs/adr/0003-in-memory-rate-limit.md`
- `docs/adr/0004-agentic-tool-calling.md` — tool calling yang divalidasi dan diaudit
- `docs/arena-operations.md` — catatan operasional Arena
- `docs/evaluation/quality-standard.md` — rubrik kualitas jawaban chatbot
- `docs/evaluation/scenario-taxonomy.md` — skenario user + metriknya
- `docs/evaluation/agent-quality.md` — evaluasi tool selection & task completion
- `eval/README.md` — cara menjalankan evaluation harness chatbot
- `eval/agent/README.md` — cara menjalankan evaluation harness agent
- `docs/engineering-journal.md` — lima bug nyata yang ketemu dan diperbaiki
- `docs/demo/agent-transcript.md` — contoh alur agent dari pertanyaan sampai audit trail

## Batasan

- Bot melayani **satu chat id** (owner). Multi-user memerlukan tabel allowlist.
- Rate limiter berbasis memori: di Vercel multi-instance, batasnya bisa dilewati dan hilang saat deploy. Ini keputusan sadar — lihat ADR 0003.
- Context window LLM dibatasi 3500 karakter balasan dan N pesan riwayat.
- Jalur agent (`/agent`, `/confirm`) bersifat opt-in; obrolan bebas tetap memakai assistant text-only.
- Eval agent memakai LLM dan tool palsu yang di-script — bagus untuk regresi, bukan bukti perilaku model nyata.
- Seluruh angka adalah hasil riset/simulasi harga historis, bukan data broker real-time.

---

**Bukan saran finansial. Konfirmasi dan risiko tanggung sendiri.**
