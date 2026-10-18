# Design: Market Structure & Pattern Engine (S/R + pola multi-timeframe)

Tanggal: 2026-10-18
Status: menunggu persetujuan
Rencana induk: A (ledger, sedang dibangun) → **dokumen ini** → B (kalibrasi) → E paralel → C terakhir

## Kenapa ini ada

Engine sekarang tahu **seberapa kuat** sebuah koin relatif terhadap benchmark
(RS z-score, konfluensi, regime), tapi tidak tahu **di mana harga berada**
relatif terhadap harga sebelumnya, dan tidak tahu **bentuk apa** yang sedang
terbentuk. Itu dua hal berbeda:

- "Koin ini kuat" — engine sudah bisa.
- "Koin ini kuat, dan kekuatannya muncul tepat di support lama, setelah double
  bottom di 4h, sementara 1d masih downtrend structure" — engine belum bisa.

Akibatnya AI menyusun alasan yang benar tapi buta terhadap konteks harga:
tidak bisa menyebut level, tidak bisa menyebut bentuk, tidak bisa menyebut
jarak ke support/resistance, dan tidak bisa menyatakan **di mana setup ini
salah** (invalidation) dalam satuan harga. Itu persis yang membuat user
"telat masuk dan tidak percaya".

Dokumen ini juga **membuka jalan untuk B**: R-multiple mustahil tanpa jarak
stop, dan jarak stop datang dari struktur (level yang membatalkan setup).

## Sasaran

1. Engine mendeteksi **support/resistance dari price action sebelumnya**
   (pivot/swing), bukan dari indikator, dan mengukur jarak harga sekarang ke
   level terdekat dalam satuan ATR.
2. Engine mendeteksi **struktur tren** (higher-high/higher-low vs
   lower-high/lower-low vs range) per timeframe — terpisah dari tren indikator
   yang sudah ada (dan ketidaksepakatan keduanya justru informasi).
3. Engine mendeteksi **sejumlah pola yang bisa didefinisikan** (daftar di
   bawah), per timeframe 1h/4h/1d, tanpa merata-ratakan konflik antar timeframe.
4. Setiap pola **bisa disalahkan**: ia membawa pivot pembentuknya dan level yang
   membatalkannya. Bukan skor misterius.
5. Hasilnya masuk ke (a) konteks AI, (b) daftar tradeable sebagai konteks
   struktur, (c) baris ledger — supaya catatan menunjukkan apa yang engine lihat.

## Bukan sasaran

- Mengubah detektor decoupling, rumus konfluensi, atau gate tradeable.
- Mengklaim pola yang tidak bisa didefinisikan (lihat anti-sasaran).
- Menghitung R-multiple → itu B.
- Menambah panggilan API baru (semua dari candle yang sudah di-fetch).

## Anti-sasaran (kalau ini terjadi, fitur ini merusak, bukan membantu)

- **AI menyebut pola yang tidak terdeteksi.** AI tidak boleh "melihat" sendiri;
  ia hanya boleh mengutip pola yang keluar dari engine. Ini aturan keras di
  prompt.
- **Cup & handle dipaksakan.** "Rounded base" tidak bisa didefinisikan dari OHLC
  tanpa penghalusan yang subjektif. Salah satu pola palsu yang diucapkan dengan
  yakin akan merusak seluruh kredibilitas AI. Karena itu ditunda (lihat #6).
- Merata-ratakan pola 1h dan 1d jadi satu angka, sehingga "double bottom 4h
  melawan downtrend 1d" hilang menjadi "0,5".

## Kendala nyata (dari kode)

- Belum ada deteksi pivot/swing/support/resistance sama sekali di `lib/`
  (sudah dicek). Tidak ada duplikasi logika geometri.
- Tidak ada RSI di `lib/algorithms/indicators.ts`; yang ada `sma/ema/atr/zScore/
  wilderSmooth` dll. `wilderSmooth` sudah ada, jadi RSI ~10 baris.
- Sweep = ~260 koin × 3 timeframe. Beban harus tetap O(jumlah bar) per seri, dan
  **tanpa** panggilan jaringan tambahan.
- Tidak ada test runner di repo (`package.json` hanya build/lint/typecheck).
- `fetchKlinesRouted` (`lib/universe.ts`) adalah satu-satunya sumber candle;
  struktur dibangun dari candle **yang sudah ditutup saja** supaya reproducible.

## Keputusan

### Saya yang putuskan (bisa dibantah)

1. **Satu modul `lib/algorithms/marketStructure.ts` sebagai satu-satunya sumber
   geometri.** Pivot dideteksi sekali; S/R, struktur tren, dan pola semuanya
   memakannya. Tidak ada perhitungan pivot kedua di tempat lain — kalau ada,
   suatu hari keduanya akan berbeda dan tidak ada yang tahu mana yang benar.
2. **Pivot = fractal** dengan `N` bar di kiri dan kanan (default N=2), hanya dari
   candle yang sudah tutup. Deterministik dan bisa diuji.
3. **Level S/R = pengelompokan pivot berdasarkan kedekatan harga** (toleransi
   `0,5 × ATR`), diberi skor dari jumlah sentuhan + kebaruan + volume saat
   sentuhan. Output: support terdekat di bawah harga, resistance terdekat di
   atas harga, masing-masing dengan **jarak dalam ATR**. Level yang jaraknya
   tidak wajar untuk ditradingkan tetap dilaporkan tapi ditandai jauh.
4. **Struktur tren dari urutan pivot** (HH/HL vs LH/LL vs range), dilaporkan
   berdampingan dengan tren indikator yang sudah ada. Ketidaksepakatan diberi
   label sendiri (mis. `indicatorUp_structureLowerHighs` = distribusi), tidak
   dirata-ratakan.
5. **Divergence dihitung pada oscilllator milik engine sendiri + RSI:**
   harga membuat high lebih tinggi sementara **RS z-score** tidak (dan/atau RSI
   tidak). Memakai RS z-score bikin selaras dengan mesin desain koin ini; RSI
   ditambahkan karena itu bahasa yang dikenal trader. Yang keluar dilabeli
   oscilllator mana yang dipakai.
6. **Pola dibagi tiga tingkat kejujuran:**
   - **Tingkat 1 (deterministik, dikirim):** double top, double bottom,
     head & shoulders + inverse, range/konsolidasi, struktur tren (HH/HL vs
     LH/LL), divergence.
   - **Tingkat 2 (best-effort, dikirim dengan confidence eksplisit):** triangle
     & wedge (pivot yang menyempit), bull/bear flag (impuls + retrace dangkal).
   - **Tingkat 3 (TIDAK dikirim):** cup & handle. Tidak bisa didefinisikan dari
     OHLC tanpa subjektivitas; tingkat false-positive tinggi. Kalau kamu tetap
     mau, ia hanya boleh keluar dengan label "best-effort, confidence rendah" —
     dan saya sarankan tidak.
7. **Setiap pola membawa pivot pembentuk + level pembatalnya** (neckline/apex).
   Itu yang membuatnya bisa disalahkan, dan itu yang memberi B jarak stop.
8. **Multi-timeframe dilaporkan per timeframe, dengan alignment eksplisit**
   (mis. `aligned: 4h+1d`, `conflict: 1h vs 1d`). Tidak ada perata-rataan.
9. **Hasil masuk ke tiga tempat:** `scanContext` (AI), field `structure` di
   entry tradeable, dan baris ledger sebagai konteks.
10. **AI hanya boleh mengutip, bukan mengarang.** `TELEGRAM_SYSTEM_PROMPT` dan
    prompt narator diberi aturan: sebut pola/level **hanya** kalau ada di data;
    kalau tidak ada, katakan tidak ada. Kalau pola hanya muncul di 1h dan
    berlawanan dengan 1d, AI wajib menyebut konfliknya.
11. **Cek diri tanpa test runner:** assert berbasis candle sintetis (double top/
    bottom & pivot yang sudah diketahui jawabannya) diekspor sebagai
    `selfCheckMarketStructure()`, dipanggil dari `GET /api/structure-check`
    (digerbang `SCAN_CRON_SECRET`). Zero dependency. Setelah repo punya test
    runner, route ini dihapus.

### Perlu keputusanmu

Api struktur menghasilkan **entry/stop/invalidation dalam satuan harga** untuk
pertama kalinya. Itu perubahan produk, bukan cuma internal:

- **(a) Internal dulu** (rekomendasi saya) — level dipakai AI dan ledger, dan
  disiapkan untuk B, tapi tidak dicetak sebagai "entry/stop" di daftar tradeable
  maupun Telegram sampai rekam jejak A membuktikan levelnya layak. Konsisten
  dengan sikap hati-hati A, dan menunda eksposur nasihat finansial.
- **(b) Langsung tampil** — entry/stop/target dari struktur dicetak ke user
  sekarang. Lebih memuaskan dilihat, tapi kita mempublikasikan level yang belum
  pernah diukur akurasinya.

### Amandemen setelah builder check

Amandemen ini **mengalahkan** poin di atas bila berbeda.

1. **Konfirmasi dulu (mengganti #6).** Pola hanya dianggap **fakta** setelah
   batasnya ditembus candle tutup. Pola yang masih terbentuk tetap dilaporkan
   (justru ini yang bikin user tidak telat), tapi **selalu** berlabel `forming`
   + confidence, dan AI wajib menyebutnya "belum terkonfirmasi, menunggu tembus
   <level>". Tanpa aturan ini, dua puncak mirip di dalam range akan dikabarkan
   sebagai double top.
2. **`trigger` dan `stop` dipisah (memperbaiki #7).** Neckline bukan stop.
   Output tiap pola: `trigger` (level yang menembus = tempat masuk) dan `stop`
   (di balik ekstrem pola) sebagai **dua harga berbeda**. Kalau disamakan,
   R-multiple di B akan dihitung dengan stop = entry, dan angkanya omong kosong.
3. **Ambang geometri ditulis eksplisit (mengisi #7/#9).** Ini titik awal, bukan
   kebenaran — kalibrasinya pekerjaan B:
   - Pivot: N=2 (2 bar kiri/kanan), candle tutup saja.
   - S/R: klaster pivot dengan toleransi `0,5 × ATR(14)`; skor level =
     jumlah sentuhan × peluruhan kebaruan × faktor volume. Level > 6 ATR
     ditandai "jauh".
   - Double top: dua pivot high dalam `0,6 × ATR`; jarak 5–40 bar; lembah
     antaranya ≥ `0,8 × ATR`; konfirmasi = close di bawah lembah; `trigger` =
     lembah; `stop` = puncak tertinggi + `0,25 × ATR`. Double bottom = cermin.
   - H&S: tiga pivot high; head > bahu + `0,5 × ATR`; kedua bahu dalam
     `0,8 × ATR`; `trigger` = neckline lewat dua lembah; `stop` = bahu kanan +
     `0,25 × ATR`.
   - Range: ≥ 4 pivot bergantian dalam ≥ 30 bar; lebar ≤ `6 × ATR`; `trigger` =
     tembus batas; `stop` = batas lawan.
4. **Confidence adalah rubrik yang bisa dihitung, bukan perasaan (mengisi #10).**
   Confidence = (jumlah kriteria geometri yang terpenuhi) / (jumlah kriteria),
   dibulatkan 2 desimal. Untuk pola Tingkat 2 ada **ambang kirim 0,6** — di
   bawah itu tidak dilaporkan sama sekali. Pola Tingkat 1 (terkonfirmasi)
   dilaporkan apa pun, tapi angka confidence-nya tetap ditampilkan supaya mutu
   geometrinya terlihat, bukan disembunyikan.
5. **Jendela 200 bar diterima apa adanya (mengisi #5 dari builder).** Tidak ada
   pagination lebih dalam — itu melanggar "tanpa panggilan API baru" dan
   menggandakan beban fetch. Konsekuensinya jujur: pola yang butuh sejarah
   panjang mungkin **tidak terdeteksi** di 1h/4h. Tidak terdeteksi berarti
   dilaporkan tidak ada, **tidak pernah** ditebak.
6. **Struktur tidak masuk `MultiTimeframeResult` (mengisi #6).** Payload
   `scan_history` menyimpan seluruh hasil 260 koin; menaruh struktur di sana
   membengkakkan data dan mengabadikan pola yang salah di halaman publik.
   Struktur dihitung `analyzeStructure(candles)` **saat dipakai**: untuk kandidat
   tradeable, untuk konteks AI koin teratas, dan untuk baris ledger saja.
7. **Konteks struktur di ledger = migrasi terpisah `013`, bukan mengubah A
   (mengisi #6 dari builder).** A tetap bisa rilis sendiri; kolom `context
   jsonb` ditambahkan di 013 dan ikut dibekukan trigger.
8. **Prompt lama harus dibersihkan (memperbaiki #6/#11 dari builder).** Baris
   prompt di `pages/api/telegram-webhook.ts` yang saat ini **menyuruh** AI
   memakai "double top/bottom, head & shoulders, flag/pennant, wedge, cup &
   handle" harus **dihapus**, bukan sekadar ditambah aturan baru. Kalau
   dibiarkan, anti-sasaran sudah mati sebelum fitur ini lahir. Item 7 di daftar
   "Yang dibangun" karena itu wajib, bukan tambahan.
9. **Divergence: dua oscillator dilaporkan terpisah, hanya regular (mengisi #5
   dan #8 dari builder).** RS z-score dan RSI tidak akan selalu sepakat, jadi
   tidak ada yang dipilih sebagai pemenang — keluar dua deteksi terpisah dengan
   label oscillator-nya, dan AI diberi tahu bahwa kesepakatan keduanya = lebih
   kuat. Hidden divergence ditunda, disebut sebagai batasan.

## Yang dibangun

1. `lib/algorithms/indicators.ts` — tambah `rsi()` (memakai `wilderSmooth`).
2. `lib/algorithms/marketStructure.ts` — pivot, level S/R, struktur tren, pola
   tingkat 1–2, `selfCheckMarketStructure()`. Tipe hasil diekspor.
3. `lib/algorithms/tradeable.ts` — bawa `structure` (level terdekat + pola
   relevan + level pembatal) ke entry.
4. `lib/algorithms/multiTimeframe.ts` — sisipkan struktur/pola ke hasil (dan
   sertakan di `narrative`/`rationale` bila relevan).
5. `pages/api/scan-cron.ts` — struktur masuk `scanContext`; tulis ke baris ledger.
6. `pages/api/telegram-webhook.ts` — aturan "kutip, jangan mengarang" +
   kewajiban menyebut konflik timeframe di prompt.
7. `pages/api/structure-check.ts` — self-check bergerbang secret.
8. Kalau kamu pilih (b): permukaan tampilan di halaman + Telegram.

## Verifikasi

- `npx tsc --noEmit` + `npx next build` lolos.
- `GET /api/structure-check` (dengan secret) mengembalikan semua assert lolos:
  pola pada candle sintetis terdeteksi, dan **tidak** terdeteksi pada derau acak
  dengan frekuensi yang tidak wajar (uji false-positive).
- Uji dengan koin nyata: level S/R cocok dengan yang terlihat di chart, dan
  jaraknya masuk akal dalam ATR.
- **Uji paling penting:** tanya AI soal koin tanpa pola apa pun → AI harus bilang
  tidak ada/terbatas, bukan mengarang pola.

## Batasan yang diakui

- Deteksi pivot bergantung pada `N`. N kecil = terlalu banyak pivot palsu;
  N besar = telat. N=2 adalah titik awal, bukan kebenaran; ia harus dikalibrasi
  dari hasil (dan itu pekerjaan B).
- Pola tingkat 2 memang akan salah kadang-kadang. Itu sebabnya confidence
  eksplisit dan level pembatal wajib ada.
- Fitur ini menambah pertimbangan AI, **bukan** menambah sinyal. Jumlah sinyal
  tidak berubah — itu disengaja.
