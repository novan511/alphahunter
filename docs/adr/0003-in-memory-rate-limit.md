# ADR 0003 — Rate limit AI di memori (dengan sadar risikonya)

- Status: accepted, dengan rencana migrasi
- Tanggal: 2026-11-22
- Terkait: `pages/api/telegram-webhook.ts` (`aiLastAsk`, `AI_RATE_LIMIT_MS`)

## Konteks

Satu pertanyaan natural memicu satu panggilan LLM berbayar. Tanpa pembatasan, satu chat bisa menghabiskan kuota dalam hitungan detik. Kita butuh cooldown per chat sebelum ada tabel/Redis.

## Keputusan

Simpan timestamp terakhir per `chatId` di `Map` dalam modul webhook, cooldown 30 detik. Bersihkan entri lama saat ukuran map melebihi 500.

## Konsekuensi yang disadari

- **Per-instance:** di Vercel dengan banyak instance, setiap instance punya Map sendiri — batas 30 detik bisa dilewati hingga N× jumlah instance.
- **Tidak persisten:** deploy atau cold start menghilangkan state, jadi cooldown bisa reset lebih awal.
- Ini diterima karena deploy saat ini melayani satu owner; risikonya bersifat finansial kecil dan tidak merusak data.

## Rencana migrasi

Kalau bot melayani banyak user, pindahkan ke satu baris Postgres:

```sql
create table if not exists public.telegram_ai_rate (
  chat_id text primary key,
  last_ask_at timestamptz not null default now()
);
```

Dengan `insert ... on conflict do update` + `where now() - last_ask_at < interval '30 seconds'` sebagai atomic check. Ini juga memberi audit trail pemakaian token.

## Verifikasi

Kirim dua pertanyaan berturut-turut kurang dari 30 detik; yang kedua harus mendapat pesan "Tunggu sebentar dulu ya …". Test ini sengaja tidak dimasukkan CI karena bergantung pada waktu nyata — gunakan smoke manual.
