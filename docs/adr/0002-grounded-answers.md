# ADR 0002 — Jawaban AI harus di-ground ke data engine

- Status: accepted
- Tanggal: 2026-11-22
- Terkait: `lib/telegramPersona.ts`, `pages/api/telegram-webhook.ts`, `lib/calibration.ts`

## Konteks

Bot ini bicara soal pasar dan risiko. LLM yang dibiarkan bebas akan mengarang angka, katalis, atau pola yang tidak ada di data — dan di domain ini hal itu lebih berbahaya daripada jawaban yang terlalu pendek.

## Keputusan

Setiap jawaban dibangun dari `scanContext()`: hasil scan tersimpan di Supabase sebagai jangkar, dilengkapi data live yang **dilabeli secara eksplisit** sebagai bukan bagian scan. Model tidak boleh menyebut angka, berita, atau pola di luar konteks. Kalau tidak ada data, model diperintahkan mengatakannya.

Pengaman berlapis:

1. Prompt lock — persona, batas topik, larangan JSON, larangan mengarang.
2. Input guard — konteks disusun oleh kode, bukan oleh model.
3. Kalibrasi — `calibrationLines()` hanya mengeluarkan angka bila sampel cukup (`n` + CI); jika tidak, hanya teks.
4. Struktur — pola hanya dibaca dari blok "STRUKTUR & POLA" yang dihitung `analyzeStructure()`; model tidak boleh mencari pola sendiri.
5. Format — balasan teks biasa, dipotong panjangnya, selalu dengan disclaimer.

## Alternatif yang ditimbang

| Opsi | Kenapa tidak dipilih |
|---|---|
| LLM bebas + prompt "jangan berbohong" | Prompt saja bukan jaminan; tidak ada cara membuktikan angka itu dari data. |
| RAG embedding dari arsip berita | Mahal, lambat, dan tetap bisa bermetode; tidak menjawab "angka ini dari scan yang mana?". |
| Tidak pakai LLM sama sekali | Hilangnya kemampuan menjelaskan dan berdiskusi — padahal itu nilai produk chatbot-nya. |

## Konsekuensi

- Jawaban kalah "kreatif" dari chatbot umum, tapi bisa diaudit: setiap klaim bisa ditelusur ke blok konteks.
- Konteks bisa panjang; perlu batas ukuran dan pemotongan balasan.
- Saat scan belum ada, bot jujur bilang "jalankan scan dari web dulu" — ini perilaku yang diharapkan, bukan bug.
- Perubahan pada prompt persona harus diuji dengan `scripts/probe-ai-scope.ts`, yang memakai konstanta yang sama dengan webhook.

## Verifikasi

`npm test` (test persona & webhook), `npx tsx scripts/probe-ai-scope.ts`, `npx tsx scripts/smoke-calibration.ts`.
