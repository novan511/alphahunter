# Design: Kalibrasi Sinyal — dari skor ke keputusan (R-multiple)

Tanggal: 2026-10-18
Status: menunggu persetujuan
Rencana induk: A (ledger, selesai) → struktur & pola (selesai) → **dokumen ini (B)** → E paralel → C terakhir

## Kenapa ini ada

A sudah mencatat sinyal dan menilai alpha pada horizon tetap (1/3/7 hari).
Alpha menjawab "apakah koin ini mengalahkan benchmark", tapi tidak menjawab
pertanyaan yang sebenarnya dipakai untuk mengambil keputusan: **"kalau aku masuk
sekarang, berapa peluangnya, dan berapa besar untung-rugi yang wajar?"**

Jawaban yang diinginkan: "setup ini historisnya 57% kena target, expectancy
+0,4R". Itu kalimat yang mengubah skor jadi keputusan — dan sekaligus mengisi
halaman rekam jejak dengan angka yang berarti.

## Masalah kejujuran yang harus dipecahkan lebih dulu

Ada jebakan di inti ide ini, dan kalau tidak dijawab, seluruh fitur jadi alat
pembohong:

1. **Win rate ditentukan oleh stop yang kita pilih.** Stop lebar → win rate naik,
   R turun. Kalau stop dituning sampai angkanya bagus, win rate itu tidak
   mengukur apa pun selain selera kita sendiri.
   → **Solusi:** target **selalu 2R** (jarak tetap, tidak pernah dituning) dan
   **stop ditentukan struktur**, bukan oleh kita. Dengan target 2R tetap:
   `expectancy = 3p − 1`. Win rate jadi bermakna karena pembandingnya tetap.
2. **Angka utama harus expectancy (R), bukan win rate.** Win rate 57% dengan
   R rata-rata −0,2 adalah sistem rugi. Karena itu win rate **wajib** selalu
   tercetak bersama R dan ukuran sampel; tidak boleh muncul sendiri.
3. **Backtest yang dipresentasikan sebagai peluang adalah klaim ramalan.**
   `lib/quant/` yang ada adalah simulasi portfolio (bukan base-rate per setup),
   dan angka hasil backtest sangat mudah overfit. Menempelkannya ke sinyal live
   sebagai "57% win" berarti menjanjikan masa depan dari data masa lalu.
   → **Keputusan saya: v1 forward-only**, memakai baris ledger A yang dinilai
   dengan R. Hasil backtest terpisah boleh menyusul sebagai tampilan berlabel,
   bukan sebagai angka yang tampil di sinyal.

## Sasaran

1. Setiap sinyal yang tercatat punya **level harga**: `stop` dan `target` (2R).
2. Hasil dinilai dengan **first-touch** pada candle 4h: kena target, kena stop,
   atau masih terbuka setelah batas tahan.
3. Ada **agregat per setup** (bucket) dengan **gerbang ukuran sampel**: di bawah
   n=30 angkanya **tidak ditampilkan sama sekali** — yang keluar "sampel belum
   cukup (12/30)", bukan angka.
4. Angka itu masuk konteks AI dan halaman `/record`, selalu dengan n dan dengan
   label bahwa ini hasil live, bukan janji.

## Bukan sasaran

- Menuning stop/target supaya angkanya bagus.
- Backtest historis sebagai angka peluang di sinyal (lihat masalah #3).
- Mengubah detektor, gate, atau skor konfluensi.
- Eksekusi otomatis / papan peringkat setup untuk publik (itu C/E).

## Anti-sasaran (kalau terjadi, fitur ini merusak)

- Menampilkan win rate tanpa n, atau tanpa R.
- Menampilkan angka dari bucket dengan n kecil.
- Menyebut hasil backtest sebagai rekam jejak live.
- Mengubah stop setelah hasilnya diketahui (itu curve-fitting ke belakang).

## Kendala nyata (dari kode)

- `lib/quant/portfolioBacktest.ts` + `walkForward.ts` menghasilkan `expectancyR`
  **level portfolio** (satu angka untuk seluruh simulasi), bukan per setup.
  Tidak bisa dipakai langsung untuk "setup ini 57%".
- **Tidak ada** logika first-touch / R-multiple di repo (sudah dicek).
- Ledger A menyimpan `context` berisi struktur 4h & 1d per sinyal — termasuk
  `support`, `resistance`, `atr`, dan `patterns[].trigger/stop`. Level untuk B
  sebagian besar **sudah tersimpan** di situ.
- `lib/quant/derivatives.ts` dan `lib/universe.ts` sudah punya `fetchKlinesRouted`
  untuk menarik candle penilaian.
- Tidak ada test runner; verifikasi = `tsc` + `next build` + self-check.

## Keputusan

### Saya yang putuskan (bisa dibantah)

1. **Level harga diambil dari struktur, bukan dari ATR abstrak.** Aturan stop,
   berurutan: (a) `stop` pola kalau sinyal punya pola; (b) level struktur
   berlawanan terdekat (support untuk long) dikurangi buffer `0,5 × ATR`; (c)
   kalau tidak ada level dalam 6 ATR, `1,5 × ATR` dari harga entry. Arah lawan
   untuk short. `stop` dan `target` disimpan di baris (imutabel) supaya hasilnya
   bisa direproduksi dan tidak bisa digeser setelah kejadian.
2. **Target = 2R, selalu.** Tidak ada penuningan. `target = entry + 2 × (entry −
   stop)` untuk long, cermin untuk short.
3. **Entry = `price` yang sudah tersimpan di baris ledger** (snapshot saat emit).
   Tidak dihitung ulang.
4. **Hasil = first-touch pada candle 4h** dari `emitted_at` sampai `stop`/`target`
   tersentuh, dengan batas tahan **7 hari**. Tiga kemungkinan: `target`, `stop`,
   `open`. `open` setelah 7 hari dinilai pada close terakhir (R aktual) dan
   ditandai `open` — tidak dipaksa jadi menang/kalah.
5. **Candle 4h, bukan 1h.** Batas yang diakui: sentuhan di dalam satu bar 4h
   (harga menyentuh stop lalu berbalik ke target) tidak bisa dibedakan
   urutannya. Untuk kasus itu dipakai aturan pesimistis: **stop dianggap lebih
   dulu**. Lebih baik meremehkan diri sendiri daripada membanggakan diri.
6. **Bucket sengaja kasar**, karena bucket halus = sampel tipis = angka tak
   bermakna. Dua bucket: `finalSignal` (strong_buy/buy/strong_sell/sell) dan
   `finalSignal × ada-tidaknya-pola`. Tidak ada bucket per nama pola di v1.
7. **Gerbang sampel n ≥ 30.** Di bawah itu, tidak ada angka yang ditampilkan —
   hanya "sampel belum cukup". Ini berlaku di API, di AI, dan di halaman.
8. **Metrik utama = expectancy R**; win rate selalu berdampingan dengan R dan n.
9. **Skema: migrasi `015`** menambah `stop`, `target`, `r`, `outcome`,
   `scored_r_at`, `max_hold_days`. Kolom hasil bersifat write-once seperti
   horizon A (trigger yang sama, ditambahkan di 015). `stop`/`target` masuk
   kolom fakta imutabel.
10. **Penilaian menumpang tick scan-cron yang sama** (batch terbatas), bukan cron
    baru. Penilaian kedua (R) jalan setelah penilaian pertama (alpha) untuk baris
    yang sama; keduanya independen.
11. **Agregat dihitung saat dibaca** dari `r`/`outcome`, bukan tabel statistik.
12. **Tampil di:** konteks AI (satu baris per bucket relevan, di section
    "HISTORIS LIVE"), `/record` (kolom R per baris + tabel ringkas per bucket),
    dan — kalau nanti kamu mau — notifikasi. **Tidak** di `tradeable` v1.
13. **Tidak ada backtest di v1.** Kalau kamu mau, itu jadi dokumen terpisah
    dengan label tegas "BACKTEST" dan tidak pernah muncul di jalur sinyal live.

### Perlu keputusanmu

Hanya satu, dan ini soal klaim (bukan teknis):

Sampai ledger terkumpul, section "HISTORIS LIVE" akan **kosong / "sampel belum
cukup"** berminggu-minggu. Pilihannya:

- **(a) Forward-only** (rekomendasi saya) — tidak ada angka sampai nyata. Paling
  jujur, paling kecil, dan angka pertama yang keluar benar-benar terjadi.
- **(b) Tambah angka backtest berlabel** di halaman yang sama — terisi lebih
  cepat, tapi ada risiko besar orang membacanya sebagai peluang, dan itu justru
  jenis klaim yang membuat tool trading kehilangan kepercayaan.

### Amandemen setelah builder check

Amandemen ini **mengalahkan** poin di atas bila berbeda.

1. **Stop seragam, bukan campuran (mengganti #1).** Satu konvensi untuk **semua**
   baris: `stop = 1,5 × ATR(4h)` dari entry, `target = 2R`. Alasan: struktur hanya
   ada untuk sebagian sinyal (`MAX_STRUCTURE_TARGETS = 6` aset/tick + fetch bisa
   gagal), sehingga aturan "pakai stop struktur kalau ada" akan memberi **dua
   definisi risiko berbeda di dalam satu bucket** — angkanya lalu tidak sebanding
   dan sampelnya bias ke koin teratas. ATR(4h) sudah dihitung engine, jadi
   `atr` cukup ditambahkan ke hasil dan disimpan di baris: tanpa fetch tambahan,
   tanpa subset. Struktur tetap dipakai untuk penalaran AI; ia tidak dipakai untuk
   bucket v1.
2. **Gerbang = interval kepercayaan, bukan `n` (mengganti #7).** `n ≥ 30` hanya
   syarat minimum untuk **menampilkan**. Klaim "edge positif" hanya boleh keluar
   kalau **batas bawah CI 95% dari expectancy > 0**. Pada n=30 dengan p≈0,5,
   CI win rate itu ±18 poin — mempublikasikan "+0,4R" di situ adalah menyajikan
   derau sebagai base rate, persis yang spec ini ingin cegah. CI selalu dicetak.
   `expectancy = mean(r)` dari nilai **tersimpan**, **tidak pernah** `3p−1`
   (keduanya berbeda begitu ada gap dan time-exit).
3. **Bucket jatuh ke level kasar saat tipis (mengganti #6).** Kalau
   `finalSignal × pola` belum cukup sampel, tampilkan bucket `finalSignal` yang
   dipool. Yang tipis tidak ditampilkan sama sekali — bukan ditampilkan dengan
   peringatan.
4. **`level_convention` disimpan per baris (mengganti #9).** String versi (mis.
   `atr1.5-2R-v1`) sebagai fakta imutabel. Tanpa ini, satu perubahan konvensi
   diam-diam mencampur dua definisi risiko dalam satu bucket — dan itu
   membatalkan gunanya immutability.
5. **Semantik first-touch dipatok (mengganti #4).** Ini semua masuk ke angka, jadi
   tidak boleh ditebak:
   - Pemindaian mulai dari bar 4h pertama yang **open-nya ≥ `emitted_at`**; bar
     tempat entry diambil (setengah jalan) tidak dihitung — kalau tidak, low yang
     terjadi *sebelum* entry akan dihitung sebagai stop kena.
   - Kalau bar **terbuka melewati** level, eksekusi di **open** (pesimistis),
     bukan di level.
   - Stop **dan** target tersentuh di bar yang sama → dihitung **stop**.
   - Time-exit 7 hari memakai **close bar terakhir yang seluruhnya di dalam
     jendela**, bukan close terbaru yang tersedia (kalau tidak, baris yang sama
     memberi jawaban berbeda tergantung kapan cron jalan — dan write-once membuat
     jawaban pertama itu permanen).
   - Dinilai **begitu tersentuh**, tidak menunggu hari ke-7 — itu memangkas
     waktu sampai angka pertama keluar dari ~1 minggu jadi beberapa jam.
6. **Baris yang jendelanya tidak lagi lengkap ditandai `lost` (mengganti #10).**
   Candle hanya tersedia ~10 hari ke belakang; kalau candle tertua yang tersedia
   sudah lebih baru dari `emitted_at`, path-nya tidak lagi utuh → tandai terminal
   `lost`, **dikecualikan** dari bucket, dan jumlahnya **ditampilkan**. Tidak
   pernah dinilai dari path yang terpotong.
7. **Populasi dan baris `open` (mengganti #8).** Headline = pandangan **pushed**
   (yang benar-benar bisa ditindak user), terpisah dari all-confident seperti
   aturan A — kedua pandangan tidak boleh dicampur. Baris `open` dan `lost`
   **tidak masuk** win rate maupun expectancy; keduanya dihitung dan dicetak
   sebagai angka sendiri, supaya tidak ada campuran yang tak terlihat.
8. **Kolom fakta vs write-once (mengganti #9).** `atr`, `stop`, `target`,
   `level_convention` = fakta murni (update yang mengubahnya ditolak). `r`,
   `outcome`, `scored_r_at` = write-once. Baris yang dibuat **sebelum** 015 tidak
   punya level → **dikecualikan selamanya, tidak pernah di-backfill**: mengisi
   level setelah tahu hasilnya adalah pintu belakang untuk memalsukan rekam
   jejak.
9. **Framing diperbaiki (mengganti #2).** Dengan target 2R tetap, win rate dan
   expectancy adalah **dua pandangan dari satu angka yang sama**. Spec tidak boleh
   berpura-pura keduanya informasi independen; keduanya ditampilkan bersama CI,
   bukan sebagai dua bukti.

### Amandemen setelah recheck implementasi

Amandemen ini **mengalahkan** poin di atas bila berbeda.

10. **Satuan waktu: semua candle dalam DETIK.** `Candle.time` adalah detik
    (semua sumber membagi payload ms-nya dengan 1000). Versi pertama
    membandingkannya dengan `Date.parse()` (milidetik), sehingga `nearestCandle`
    (alpha, dokumen A) **dan** `firstTouch` tidak pernah cocok dengan satu bar
    pun — penilaian mati total tanpa error, dan fixture yang memakai ms membuat
    self-check hijau. Sekarang `nearestCandle`/`firstTouch` menerima detik,
    satuan didokumentasikan di `lib/types.ts`, dan smoke-check menegaskan bahwa
    target ber-milidetik memang tidak boleh cocok.
11. **`lost` diperluas: bukan hanya awal yang hilang.** Jalur yang tidak bisa
    ditelusuri utuh tidak boleh dinilai. `lost` sekarang juga dipakai kalau ada
    **bar bolong di tengah** (stop di bar itu tidak akan terlihat) atau kalau
    **seri candle berhenti sebelum jendela 7 hari habis** (delisting/pair halt) —
    dua-duanya akan memflatter rekam jejak kalau dibiarkan lewat.
12. **Baris tanpa data sama sekali ikut dipensiunkan.** Kalau tidak ada candle
    sama sekali dan jendela tahan sudah lewat, baris ditandai `lost`. Sebelum
    itu kegagalan fetch dianggap sementara. Tanpa ini, simbol mati menempati
    batch `scoreLedgerR` selamanya dan memblokir baris yang bisa dinilai.
13. **Angka tidak boleh dicetak sama sekali kalau belum konklusif.** Baris
    konteks AI untuk bucket yang belum lolos gerbang hanya berisi kata, alasan
    (sampel kurang **atau** interval masih menyentuh nol — dibedakan), dan
    hitungan waktu-habis/hilang/menunggu. Nomor yang kita pegang tidak masuk
    konteks, karena dari sana ia akan dikutip sebagai edge.
14. **Bucket dibatasi pada konvensi risiko yang berlaku sekarang.** Baris dari
    `level_convention` lain dikecualikan (bukan dipool), sehingga perubahan
    aturan stop/target tidak pernah menghasilkan satu win rate dari dua definisi
    risiko. Halaman `/record` menyebutkan ini.
15. **Level tetap tidak bisa di-backfill, dan `r` juga write-once.** Trigger 015
    memakai `is distinct from` (yang menghitung NULL→nilai sebagai perubahan),
    jadi klaim "pra-015 tidak pernah diisi" benar-benar ditegakkan; pemakaian
    `=` akan membuka pintu itu. `r` diberi penjagaan write-once sendiri, tidak
    bergantung pada aplikasi yang kebetulan menulisnya bersama `outcome`.

## Yang dibangun

1. `lib/algorithms/multiTimeframe.ts` — tambah `atr` (4h) ke hasil, aditif seperti
   `price`.
2. `supabase/migrations/015_signal_ledger_r.sql` — kolom `atr`, `stop`, `target`,
   `level_convention` (fakta murni) + `r`, `outcome`, `scored_r_at` (write-once),
   plus trigger yang mereproduksi seluruh penjagaan 012 dan menambah yang baru.
3. `lib/signalLevels.ts` — konvensi seragam `1,5 × ATR(4h)` / target 2R, **murni**
   (tanpa jaringan, bisa diuji).
4. `lib/signalLedger.ts` — simpan `atr`/`stop`/`target`/`level_convention` saat
   emit; `scoreLedgerR()` first-touch yang idempoten dan menandai `lost`.
5. `lib/calibration.ts` — agregat per bucket + CI 95% + gerbang sampel + aturan
   jatuh ke bucket kasar (**murni**, diuji).
6. `pages/api/track-record.ts` — sertakan bucket (dengan n, CI, `open`/`lost`) dan
   kolom R.
7. `pages/record.tsx` — kolom R per baris, tabel per bucket, status eksplisit
   "belum konklusif" sampai CI-nya mengecualikan nol.
8. `pages/api/telegram-webhook.ts` — section "HISTORIS LIVE" di konteks AI +
   aturan: jangan menyebut angka apa pun kalau n < 30 atau CI-nya belum
   mengecualikan nol.

## Verifikasi

- `npx tsc --noEmit` + `npx next build` lolos.
- Self-check `lib/signalLevels.ts` + `lib/calibration.ts` dengan assert:
  - jalur candle "kena target dulu" → `outcome=target`, `r=+2`
  - jalur "kena stop dulu" → `outcome=stop`, `r=−1`
  - jalur "tidak menyentuh apa pun" → `outcome=open` dan R dihitung dari close
    terakhir, bukan dipaksa
  - candle yang menyentuh stop **dan** target di bar yang sama → dihitung `stop`
  - agregat dengan n=29 → **tidak ada angka** yang keluar
  - agregat dengan n=30 → keluar, dengan n tercetak
- Uji di data nyata: sebuah baris ledger punya `stop < entry < target` (long) dan
  R-nya masuk akal.

## Batasan yang diakui

- Sentuhan di dalam bar 4h tidak terbaca; aturan pesimistis dipakai.
- Stop adalah konvensi kita (dari struktur). Ia masuk akal dan konsisten, tapi
  ia bukan satu-satunya pilihan yang benar — dan itu harus disebut di halaman.
- Sampel awal kosong, dan bahkan setelah terisi, satu bucket bisa butuh berbulan
  untuk mencapai n=30. Itu harga kejujuran, bukan bug.
