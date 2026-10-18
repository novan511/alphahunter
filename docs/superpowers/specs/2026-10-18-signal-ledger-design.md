# Design: Signal Ledger — track record yang bisa dipercaya

Tanggal: 2026-10-18
Status: menunggu persetujuan
Rencana induk: A dari A/B/C/E (A sekarang, B menumpang data A, E paralel, C terakhir)

## Kenapa ini ada

Althunter bisa mengeluarkan sinyal, tapi tidak punya cara membuktikan sinyalnya
benar. Penghalang utama monetisasi bukan harga, bukan fitur — tapi ketiadaan
bukti. Semua orang bisa mengklaim "engine saya akurat". Tanpa catatan yang
direkam **saat sinyal keluar** dan dinilai **belakangan**, klaim apa pun tidak
bisa dibantah maupun dipercaya, dan kita sendiri tidak tahu sinyal mana yang
layak dipertahankan.

Tujuan A: mengubah sinyal dari pendapat menjadi **rekam jejak**.

## Sasaran

1. Setiap sinyal yang dipancarkan tercatat permanen: aset, arah, waktu, harga
   referensi saat itu, dan konteks engine-nya.
2. Hasil tiap sinyal dinilai otomatis pada horizon tetap, dan angkanya **tidak
   bisa diubah setelahnya**.
3. Ada satu halaman/endpoint publik yang menampilkan catatan ini apa adanya
   (termasuk yang rugi).

## Bukan sasaran (A)

- R-multiple berbasis stop/target → itu B (butuh stop distance yang belum ada).
- Kalibrasi parameter engine atau mengubah detektor/skoring/gate. A mencatat,
  tidak mengubah keputusan.
- Akun user, kuota, billing → itu C.
- Backfill sinyal lama ke catatan publik.

## Anti-sasaran (kalau ini terjadi, A gagal walau jalan)

- Mencampur backtest dengan catatan live seolah keduanya sama.
- Menampilkan "win rate 80%" dari sampel 5 sinyal tanpa menyebut ukuran sampel.
- Angka hasil yang bisa di-edit belakangan tanpa jejak.

## Kendala nyata (dari kode, bukan asumsi)

- `MultiTimeframeResult` **tidak menyimpan harga**, hanya skor dan sinyal
  (sinyal punya `price`, tapi sinyal tipe continuation tidak). Jadi harga
  referensi saat emit tidak tersedia hari ini → harus ditambahkan.
- `top_signals` tidak punya file migrasi (dibuat manual di Supabase) dan
  mencampur isi sinyal dengan status dedup (`sent_to_telegram`). Karena itu
  ledger dibuat sebagai **tabel baru**, bukan menumpang `top_signals`.
- Scheduler yang ada: GitHub Actions (scan tiap 15–30 menit) + Vercel Hobby
  (1 cron/hari, sudah dipakai `quant-lab-cron`). Tidak ada worker yang selalu
  nyala.
- Migrasi di repo ini dijalankan manual di Supabase SQL Editor. Semakin banyak
  objek DB (trigger/function), semakin besar risiko lupa apply → jaga tetap
  sedikit.
- Tabel-tabel yang ada memakai pola RLS: `anon` boleh `select`, tulis via
  service key.

## Keputusan

### Saya yang putuskan (bisa dibantah)

1. **Tabel baru `signal_ledger`, append-only.** Tidak menambah kolom ke
   `top_signals`.
2. **Dicatat saat emit**, dari `pages/api/scan-cron.ts` — persis momen user
   bisa melihat/menindakinya. Bukan saat scan selesai, bukan saat dibaca bot.
3. **Pencatatan TIDAK bergantung pada Telegram.** `recordSignals()` dipanggil
   di luar `sendConfidentSignals()` (fungsi itu `return` lebih awal kalau env
   Telegram kosong — kalau dicatat di dalamnya, catatan ikut mati saat Telegram
   bermasalah, padahal engine tetap memancarkan sinyal). Flag `pushed` diisi
   dari hasil pengiriman.
4. **Rekam semua sinyal yang lolos gate confident**, plus dua flag:
   `pushed` (benar-benar dikirim) dan `deduped` (ditahan dedup 24 jam).
   Halaman publik menampilkan **dua pandangan terpisah**: "semua sinyal
   confident" (sampel statistik) dan "yang benar-benar dikirim" (yang bisa
   ditindak user). Tidak boleh dicampur.
5. **Satu baris per (aset, arah, hari emit)** — unique index. Mengikuti
   dedup 24 jam yang sudah ada, dan membatasi ledger tetap wajar. Re-emit di
   hari berikutnya = baris baru; di hari yang sama = tidak ada baris baru.
6. **Harga referensi = snapshot harga live saat emit** (close elemen terakhir
   seri 4h). Disimpan apa adanya bersama `price_at` (waktu emit) dan `price_tf`.
   Snapshot, bukan close bar yang sudah settle — supaya angkanya sama dengan
   yang dilihat user saat itu, dan tetap reproducible karena nilainya tersimpan.
   Kalau seri 4h kosong → fallback 1h → 1d.
7. **Benchmark alpha = `indexSymbol` saat emit**, dan **disimpan di baris**
   (`benchmark_symbol` + `benchmark_price`). Bukan BTC hardcoded — engine
   mengukur RS terhadap index yang dikonfigurasi, jadi menilai terhadap
   benchmark lain berarti mengklaim sesuatu yang tidak pernah diukur.
   Menyimpan harganya membuat re-score di masa depan bisa direproduksi.
8. **Penilaian = alpha terhadap benchmark**, bukan return absolut. Engine ini
   relative-strength; return absolut akan memuji semua orang saat pasar naik.
   Alpha = `ret_aset - ret_benchmark`, dibalik tanda untuk short.
9. **Horizon tetap 1d / 3d / 7d, dinilai independen satu per satu.** Setiap
   horizon punya kolomnya sendiri (`ret_1d/3d/7d`) dengan penanda terisinya
   sendiri (`scored_1d_at/3d_at/7d_at`). Horizon 1d terisi di hari ke-1, 3d di
   hari ke-3, 7d di hari ke-7 — jadi halaman terisi progresif, tidak menunggu
   hari ke-7. Setiap kolom horizon hanya boleh `null → nilai` **sekali**.
   (Ini memperbaiki ambiguitas `scored_at` tunggal yang membuat horizon 3d/7d
   mustahil terisi.)
10. **Immutability di level DB**: trigger `BEFORE UPDATE` menolak perubahan
    pada kolom fakta sinyal (aset, arah, waktu emit, harga emit, benchmark,
    harga benchmark, flag). Kolom horizon hanya boleh terisi sekali.
11. **Waktu horizon = kelipatan kalender dari `emitted_at`** (1d = 24 jam,
    3d = 72 jam, 7d = 168 jam). Penilaian boleh **telat** (mis. cron mati
    sehari): dipakai candle terdekat dengan waktu target dalam toleransi ±6
    jam, diambil dari `fetchKlinesRouted`. Tidak ada horizon yang hilang
    permanen — baris tetap bisa dinilai di tick berikutnya.
12. **Penilaian menumpang tick scan-cron yang sudah ada**, bukan cron baru
    (hemat kuota Actions). Dibatasi: hanya baris yang horizonnya sudah lewat
    dan belum dinilai, maksimal N per tick.
13. **Forward-only.** Catatan publik mulai dari nol sekarang. Riwayat
    `scan_history` boleh dipakai nanti sebagai backtest terpisah, **dilabeli
    jelas** beda dari catatan live.
14. **Agregat dihitung saat dibaca**, bukan tabel statistik. Jumlah baris kecil
    di awal.
15. **Halaman publik `/record`** + `GET /api/track-record`, RLS: `anon` boleh
    `select`.

### Perlu keputusanmu

Konsekuensi dari #13: halaman publik akan **kosong/nyaris kosong selama
beberapa minggu**, dan itu memang harga dari catatan yang jujur.

Pilihannya:
- **(a) Forward-only murni** (rekomendasi saya) — tidak ada bagian backtest di
  halaman publik dulu. Paling jujur, paling kecil, tapi sepi di awal.
- **(b) Forward-only + bagian backtest terpisah** yang dilabeli tegas
  "BACKTEST (bukan rekam jejak live)" dari `scan_history`. Halaman tidak sepi,
  tapi menambah pekerjaan (data `scan_history` tidak menyimpan harga emit, jadi
  perlu rekonstruksi) dan menambah risiko orang salah baca angkanya.

Ini mengubah cakupan A, jadi saya tunggu jawaban sebelum mulai menulis kode.

## Yang dibangun

1. `supabase/migrations/012_signal_ledger.sql` — tabel + index + RLS + trigger
   immutable.
2. `lib/signalLedger.ts` — `recordSignals()`, `scoreLedger()`, `readLedger()`
   (agregat).
3. `lib/algorithms/multiTimeframe.ts` — tambah `price` ke hasil.
4. `pages/api/scan-cron.ts` — panggil `recordSignals()` di
   `sendConfidentSignals()`; panggil `scoreLedger()` sekali per tick.
5. `pages/api/track-record.ts` — endpoint baca.
6. `pages/record.tsx` — halaman publik (tabel per sinyal + ringkasan),
   menampilkan ukuran sampel di samping setiap angka.

## Verifikasi

- `npx tsc --noEmit` + `npx next build` lolos.
- Uji migrasi di Supabase: insert satu baris → update kolom fakta harus
  **ditolak** oleh trigger.
- `scoreLedger()` idempotent: dua kali jalan tidak menggandakan/menimpa hasil.
- Halaman `/record` menampilkan baris rugi juga, bukan hanya yang menang.

## Batasan yang diakui

- Sampel awal kosong. Halaman akan terlihat sepi berminggu-minggu — itu harga
  dari kejujuran, dan justru itu yang membedakannya dari klaim kosong.
- Harga emit diambil dari candle terakhir saat scan; untuk koin yang sangat
  tipis, harga ini bisa tidak bisa dieksekusi (slippage). Ini harus disebut di
  halaman, bukan disembunyikan.
- Penilaian 7d butuh data 7 hari ke depan; tidak ada hasil instan.
