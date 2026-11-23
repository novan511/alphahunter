# ADR 0001 — Webhook, bukan polling

- Status: accepted
- Tanggal: 2026-11-22
- Terkait: `pages/api/telegram-webhook.ts`, `scripts/telegram-setup.ts`

## Konteks

Telegram menyediakan dua cara menerima pesan: `getUpdates` (polling) atau webhook (Telegram memanggil URL kita). Bot ini di-deploy di Vercel dengan function yang bangun saat dipanggil.

## Keputusan

Memakai **webhook** di `/api/telegram-webhook`, didaftarkan lewat `setWebhook` dengan `secret_token`.

## Alternatif yang ditimbang

| Opsi | Kenapa tidak dipilih |
|---|---|
| Polling via cron | Vercel Hobby hanya cron harian; polling tiap detik tidak mungkin tanpa worker berjalan terus. |
| Polling via worker khusus | Biaya & kompleksitas ops naik hanya untuk menerima pesan. |
| Webhook tanpa secret | Siapa pun bisa POST ke endpoint kita; auth chat id saja tidak cukup untuk melindungi endpoint. |

## Konsekuensi

- Handler wajib membalas **200 cepat** — Telegram mencoba ulang apa pun selain 2xx, yang bisa menyebabkan balasan dobel. Semua pekerjaan berat terjadi sebelum kirim balasan, tapi tetap dalam satu request.
- Endpoint perlu auth dua lapis: secret token (melindungi endpoint) dan chat id (melindungi konten).
- Webhook tidak bisa dibaca dengan `getUpdates` saat aktif (Telegram mengembalikan 409). Script setup menangani ini dengan pesan yang jelas dan menyarankan @userinfobot.
- `maxDuration` dinaikkan ke 60 detik karena laporan pagi melakukan fetch data + LLM round trip.

## Verifikasi

`npx tsx scripts/telegram-setup.ts https://<domain>` lalu cek `getWebhookInfo` — URL, `secret_token_hinted`, `pending_update_count`, dan `last_error_message`.
