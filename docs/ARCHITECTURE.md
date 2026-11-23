# Arsitektur Althunter

Dokumen ini menjelaskan batas antar modul, bukan tutorial. Untuk alasan di balik keputusan, lihat [`adr/`](./adr/).

## Prinsip

1. **Engine deterministik dulu, AI kemudian.** Scanner, correlation matrix, dan kalibrasi menghitung angka. LLM hanya menafsirkan angka itu — tidak pernah menjadi sumber angka.
2. **Jangan pernah kirim rahasia ke browser.** Token Telegram dan kunci LLM hanya dibaca di API route / server helper.
3. **Gagal dengan jujur.** Kalau data tidak ada, sistem bilang "data tidak cukup", bukan mengarang. Kalau LLM mati, sistem fallback ke rule-based.
4. **Push bersifat best-effort.** Notifikasi tidak boleh menggagalkan scan; chat tidak boleh menggagalkan webhook.

## Layer

| Layer | Lokasi | Kontrak |
|---|---|---|
| Sumber data | `lib/yahoo.ts`, `lib/universe.ts`, `lib/quant/derivatives.ts` | Mengembalikan candle / flow, atau kosong. Tidak pernah throw ke caller tanpa penjelasan. |
| Engine | `lib/algorithms/`, `lib/quant/` | Fungsi murni atau nyaris murni: input candle + config → ranking, regime, matrix, verdict. |
| Persistensi | `lib/supabase.ts`, `supabase/migrations/` | `getSupabase()` bisa null; semua pemanggil harus punya jalur tanpa database. |
| Orkestrasi | `pages/api/scan-cron.ts`, `pages/api/telegram-webhook.ts` | Satu endpoint = satu use case. Webhook selalu balas 200 cepat ke Telegram. |
| Presentasi | `pages/*.tsx`, `components/` | Dashboard client-side; tidak memegang kunci server. |

## Alur data chatbot

```
Telegram
  │ update (POST /api/telegram-webhook)
  ▼
auth: chat id + secret token + dedup update_id
  ▼
router
  ├─ slash command → handler deterministik → teks balasan
  └─ teks bebas → handleAsk()
        ├─ rate limit (30s/chat)
        ├─ riwayat chat (Supabase, N terakhir)
        ├─ scanContext(): Supabase + struktur live + funding/CVD + rekam jejak
        ├─ prompt + TELEGRAM_SYSTEM_PROMPT → callLLM()
        └─ simpan giliran user + assistant
  ▼
sendTelegramMessage() → Telegram Bot API
```

### Kontrak `scanContext()`

Menghasilkan string yang dibaca model sebagai **fakta**, bukan saran. Urutan tetap:

1. Source & waktu scan (WIB)
2. Index + regime + alasan detektor disetel
3. Jumlah koin & sinyal
4. STRONG BUY / BUY / STRONG SELL / SELL
5. Alasan & risiko per koin (dari engine, termasuk umur trigger)
6. Struktur & pola (dihitung live dari candle 4h/1d)
7. Sektor early / terkonfirmasi
8. Funding & CVD spot (data live, dilabeli bukan bagian scan)
9. Rekam jejak live (hanya angka kalau sampel cukup)

Semua blok yang gagal diambil dilewati, bukan membuat error. Ini yang membuat balasan tetap punya jangkar walaupun satu sumber data mati.

## batas LLM

- `callLLM()` di `lib/quant/marketNarrator.ts` adalah satu-satunya jalur keluar ke LLM untuk obrolan Telegram.
- Model: `LLM_BASE_URL` + `LLM_MODEL` (default DeepSeek di lingkungan ini). `NVIDIA_API_KEY` dipakai jalur terpisah untuk `/api/explain` di dashboard.
- Balasan dipotong 3500 karakter; push lain 3900–4000 karakter.
- Persona, scope guard, dan aturan anti-halusinasi ada di `lib/telegramPersona.ts` — dipakai bareng oleh webhook dan `scripts/probe-ai-scope.ts` supaya tes tidak menyalin prompt.

## Persistensi

- Tabel utama: `signal_ledger` (append-only), `correlation_*`, `scan_history`, `telegram_chat_memory`.
- RLS: sebagian tabel mengizinkan anon read/write karena cron memakai anon key; integritas dijaga trigger database, lihat `012_signal_ledger.sql` dan `020_ai_arena_write_lock.sql`.
- Memory chat sengaja dibatasi ukurannya dan dihapus per chat saat melebihi batas — bukan arsip percakapan.

## Error handling

| Keadaan | Perilaku |
|---|---|
| Token/chat id belum ada | Webhook balas 200 `ok:false`, tidak mengirim apa pun |
| Chat bukan owner | Diabaikan tanpa balasan (tidak mengonfirmasi bot ke orang lain) |
| LLM error | Balasan error + saran perintah deterministik |
| Supabase mati | `handleAsk` bilang Supabase tidak terjangkau; blok konteks lain tetap jalan |
| Data live gagal | Dilewati, balasan memakai data scan saja |
| Webhook gagal | Telegram retry; handler tetap 200 agar tidak dobel jawab |

## Titik ekspansi

- **Multi-user:** ganti `TELEGRAM_CHAT_ID` tunggal dengan tabel allowlist di Supabase.
- **Rate limit lintas instance:** pindahkan `aiLastAsk` ke Postgres/Redis (lihat ADR 0003).
- **Multi-bahasa:** persona dipisah ke modul; tinggal menambah varian prompt.
- **Kanal lain (Discord/Slack):** router perintah already terpisah dari `sendTelegramMessage`, tinggal adapter baru.

## Cara verifikasi

```bash
npm run typecheck && npm run lint && npm test && npm run build
npx tsx scripts/telegram-setup.ts https://<domain>
curl https://<domain>/api/health
npx tsx scripts/smoke-telegram.ts
```
