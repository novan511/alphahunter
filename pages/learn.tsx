import React, { useMemo, useState } from 'react';
import Layout from '../components/Layout/Layout';

type SectionId =
  | 'overview'
  | 'map'
  | 'params'
  | 'signals'
  | 'agent'
  | 'lab'
  | 'metrics'
  | 'glossary'
  | 'faq';

const SECTIONS: { id: SectionId; label: string; icon: string }[] = [
  { id: 'overview', label: '1. Big Picture', icon: '🗺' },
  { id: 'map', label: '2. Peta Halaman', icon: '🧭' },
  { id: 'params', label: '3. Parameter', icon: '🎛' },
  { id: 'signals', label: '4. Sinyal & AI', icon: '📡' },
  { id: 'agent', label: '5. Paper Agent', icon: '🤖' },
  { id: 'lab', label: '6. Quant Lab', icon: '⚗' },
  { id: 'metrics', label: '7. Cara Baca Angka', icon: '📊' },
  { id: 'glossary', label: '8. Kamus', icon: '📖' },
  { id: 'faq', label: '9. FAQ', icon: '❓' },
];

const PARAMS: {
  name: string;
  what: string;
  why: string;
  example: string;
  risk: string;
}[] = [
  {
    name: 'Risk / trade',
    what: 'Berapa persen modal yang “dipertaruhkan” untuk satu trade kalau kena stop loss.',
    why: 'Ini rem utama. Kecil = selamat lebih lama; besar = cepat cuan atau cepat habis.',
    example: '0.5% dari $1.000 = maksimal rugi ~$5 per trade (sebelum fee).',
    risk: 'Terlalu besar (mis. 5%) → 20 lose streak bisa menghapus sebagian besar modal.',
  },
  {
    name: 'Max positions',
    what: 'Berapa posisi boleh terbuka bersamaan di 1 meja (desk).',
    why: 'Mencegah “taruh semua telur di keranjang” saat banyak sinyal muncul sekaligus.',
    example: 'Max 4 → paling banyak 4 aset dipegang bareng.',
    risk: 'Terlalu banyak → market berbalik serempak, semua merah bersamaan.',
  },
  {
    name: 'Max exposure',
    what: 'Total nilai posisi / modal, maksimal berapa persen.',
    why: 'Sekalipun risk per trade kecil, banyak posisi bisa bikin leverage psikologis.',
    example: '40% → dari $1.000, total nilai posisi tidak boleh > $400.',
    risk: 'Dekati 100% = hampir full invest, DD bisa besar.',
  },
  {
    name: 'DD halt (drawdown halt)',
    what: 'Jika equity turun dari puncak melewati batas %, semua posisi ditutup & stop entry.',
    why: 'Rem darurat. Lebih baik rugi terkendali daripada “hope recovery”.',
    example: '8% → dari peak $1.050, kalau equity ≤ $966, agent berhenti.',
    risk: 'Terlalu longgar → DD menggila; terlalu ketat → sering kena rem padahal noise.',
  },
  {
    name: 'Min signal (min signal strength)',
    what: 'Sinyal lemah dari nilai 0–10 diabaikan.',
    why: 'Filter kualitas setup — cuma ambil yang “cukup yakin”.',
    example: 'minStr 3.5 → sinyal strength 3.1 tidak dieksekusi.',
    risk: 'Terlalu tinggi → jarang entry, FOMO manual; terlalu rendah → noise banyak.',
  },
  {
    name: 'SL ATR (stop loss)',
    what: 'Stop di jarak X × ATR dari entry. ATR = ukuran “berapa bar biasanya gerak”.',
    why: 'Stop menyesuaikan volatilitas, bukan angka tetap $ yang kaku.',
    example: 'SL 2 ATR, ATR=1 → stop 2 unit harga dari entry.',
    risk: 'Terlalu ketat → kena noise; terlalu lebar → loss per trade besar.',
  },
  {
    name: 'TP ATR (take profit)',
    what: 'Target profit juga dalam satuan ATR.',
    why: 'Risk:reward yang jelas sebelum masuk.',
    example: 'SL 2 / TP 3 → target 1.5× jarak risiko.',
    risk: 'TP terlalu jauh → sering “hampir TP” lalu balik (time_stop).',
  },
  {
    name: 'Max hold',
    what: 'Maksimal posisi ditahan berapa bar (candle) sebelum ditutup paksa.',
    why: 'Menghindari posisi “nyangkut” tanpa arah.',
    example: 'Max hold 24 di 4h = maksimal ~4 hari.',
    risk: 'Terlalu panjang → modal terpakai lama di setup mati.',
  },
  {
    name: 'Interval (timeframe)',
    what: 'Candle yang dipakai: 15m, 1h, 4h, 1d, 1w, dll.',
    why: 'Timeframe beda = gaya beda (scalp vs swing vs position).',
    example: 'Crypto 4h = lebih cepat dari Gold 1d.',
    risk: 'Pindah interval tanpa paham → SL/TP/hold tidak nyambung.',
  },
  {
    name: 'Allow short',
    what: 'Bolehkah membuka posisi jual (short).',
    why: 'Komoditas/metals sering tren turun; crypto paper default long-only lebih sederhana.',
    example: 'Short silver saat downtrend momentum+volume.',
    risk: 'Short tanpa pengalaman → liquidasi cepat di market liar.',
  },
  {
    name: 'Fee & slippage',
    what: 'Biaya tukar + selisih harga eksekusi vs harapan.',
    why: 'Backtest tanpa ini terlihat terlalu bagus.',
    example: 'Fee 0.1% + slip 0.05% per sisi.',
    risk: 'Diabaikan → lab profitable, live merah.',
  },
];

const FLOW_STEPS: { title: string; body: string; page: string }[] = [
  {
    title: '1. Kamu pilih market desk',
    body: 'Crypto, Commodities, atau Gold & Silver. Masing-masing punya modal, param, dan agent terpisah.',
    page: '/quant-crypto',
  },
  {
    title: '2. (Opsional) Quant Lab cari param terbaik',
    body: 'Lab menjalankan puluhan kombinasi param, ranking berdasarkan OOS (data luar contoh latihan), lalu bisa push param terbaik ke desk.',
    page: '/quant-lab',
  },
  {
    title: '3. Paper Agent mulai “trading”',
    body: 'Agent baca chart multi-timeframe, filter sinyal, buka/tutup posisi palsu (paper) dengan risk param yang aktif.',
    page: '/quant-crypto',
  },
  {
    title: '4. Meta + Bandit + Guard jalan otomatis',
    body: 'Bobot capital antar desk, pilih gaya sinyal (decoupling/momentum/spike), cegah 1 simbol dibuka 2 desk, filter event.',
    page: '/quant-crypto',
  },
  {
    title: '5. Command Center supervisi',
    body: '/quant menampilkan equity 3 desk, chart, dan briefing bahasa manusia (AI/rule).',
    page: '/quant',
  },
];

const GLOSSARY: { term: string; def: string }[] = [
  { term: 'ATR', def: 'Average True Range — ukuran volatilitas rata-rata per bar. Dipakai untuk SL/TP yang adaptif.' },
  { term: 'RS / Relative Strength', def: 'Perbandingan kekuatan aset vs index (mis. alt vs BTC). RS naik = alt outperform.' },
  { term: 'Decoupling', def: 'Aset bergerak beda arah dari index (mis. BTC turun, alt diam/naik) + volume konfirmasi.' },
  { term: 'Momentum', def: 'Harga cenderung melanjutkan arah gerak baru-baru ini (dipakai bersama volume).' },
  { term: 'Spike', def: 'Lonjakan volume tajam + kecepatan harga — ditafsirkan sebagai jejak aliran institusi (sederhana).' },
  { term: 'Z-score', def: 'Seberapa “jauh” nilai saat ini dari rata-rata, dalam satuan standar deviasi.' },
  { term: 'PF (Profit Factor)', def: 'Total profit / total loss. PF 1.5 = profit 1.5× loss.' },
  { term: 'Sharpe', def: 'Return per unit volatilitas. Lebih tinggi = lebih “halus” per unit untung.' },
  { term: 'Max DD', def: 'Drawdown terbesar dari puncak equity ke lembah sebelumnya.' },
  { term: 'OOS', def: 'Out-of-Sample — data yang tidak dipakai saat “latihan”; uji apakah edge bertahan.' },
  { term: 'Walk-forward', def: 'Uji bertahap: latih di jendela lama, uji di jendela berikutnya, ulangi.' },
  { term: 'Composite score', def: 'Skor ranking Lab: menekankan OOS PF + Sharpe − DD, bukan PF full-sample.' },
  { term: 'Credible', def: 'Label Lab: sample OOS cukup besar + mayoritas window positif — layak dipertimbangkan apply.' },
  { term: 'Paper trading', def: 'Simulasi trading dengan harga asli, uang palsu. Tidak kirim order ke bursa.' },
  { term: 'MetaAllocator', def: 'Pembagi bobot modal antar 3 desk berdasarkan performa (paper-only).' },
  { term: 'Bandit (UCB)', def: 'Algoritma pilih “senjata”/strategi yang lagi sering berhasil (decoupling/momentum/spike).' },
  { term: 'ConflictGuard', def: 'Satu simbol hanya boleh open di satu desk agar tidak double-count risk.' },
  { term: 'Event filter', def: 'Hari tertentu (macro/weekend) → kurangi ukuran atau blok entry baru.' },
  { term: 'KPI', def: 'Target performa. Di sini mis. pace bulanan; cap keras 50%/bulan untuk paper.' },
  { term: 'Live desk', def: 'Halaman crypto/comm/gold yang menampilkan param aktif + paper agent.' },
];

export default function LearnPage() {
  const [section, setSection] = useState<SectionId>('overview');
  const [openParam, setOpenParam] = useState<number | null>(0);
  const [glossaryQ, setGlossaryQ] = useState('');
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  const filteredGlossary = useMemo(() => {
    const q = glossaryQ.trim().toLowerCase();
    if (!q) return GLOSSARY;
    return GLOSSARY.filter(
      (g) => g.term.toLowerCase().includes(q) || g.def.toLowerCase().includes(q)
    );
  }, [glossaryQ]);

  const faqs: { q: string; a: string }[] = [
    {
      q: 'Apakah ini menjamin profit?',
      a: 'Tidak. Semua paper + riset. Angka lab bisa overfit; OOS & credible hanya “kurang jelek”, bukan janji.',
    },
    {
      q: 'Kenapa modal masing-masing $1.000?',
      a: 'Konsistensi KPI dan perbandingan antar desk. Bisa diubah di profile/baseRisk, tapi default $1.000 agar ringan & sebanding.',
    },
    {
      q: 'Kenapa crypto default long-only?',
      a: 'Spot-style & lebih sederhana. Metals/comm boleh short karena tren turun lebih umum di instrumen macro.',
    },
    {
      q: 'Berapa lama paper agent harus jalan sebelum percaya sistem?',
      a: 'Minimal berminggu-minggu–berbulan-bulan, sample trade cukup, mayoritas window OOS positif. Bukan hitungan hari.',
    },
    {
      q: 'Kalau Lab apply param ke desk, apakah langsung live uang asli?',
      a: 'Tidak. Hanya mengubah parameter paper agent. Live exchange tidak tersentuh.',
    },
    {
      q: 'Kenapa sering “no signal” / flat?',
      a: 'Filter ketat + vol pasar sideways. Itu by design — lebih baik diam daripada entry sampah.',
    },
  ];

  return (
    <Layout>
      <div className="qm-page" style={{ maxWidth: 960 }}>
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#8b5cf6', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Education
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#f9fafb', margin: '4px 0 0' }}>
            Belajar Sistem Althunter
          </h1>
          <p style={{ fontSize: 13, color: '#9ca3af', margin: '8px 0 0', lineHeight: 1.55 }}>
            Penjelasan lengkap untuk orang awam: apa yang dibangun, parameter artinya apa,
            bagaimana alurnya, dan cara membaca angka di dashboard — tanpa jargon berlebihan.
            Ini <strong style={{ color: '#fbbf24' }}>edukasi riset paper-trading</strong>, bukan sinyal beli/jual uang asli.
          </p>
        </div>

        {/* Section nav */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 20 }}>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              style={{
                padding: '7px 12px',
                borderRadius: 8,
                border: `1px solid ${section === s.id ? '#8b5cf6' : '#374151'}`,
                background: section === s.id ? 'rgba(139,92,246,0.18)' : '#111827',
                color: section === s.id ? '#c4b5fd' : '#9ca3af',
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              {s.icon} {s.label}
            </button>
          ))}
        </div>

        {/* 1 Overview */}
        {section === 'overview' && (
          <div style={card}>
            <h2 style={h2}>Apa ini, sederhananya?</h2>
            <p style={p}>
              Althunter adalah <strong>laboratorium trading otomatis (paper)</strong>. Uangnya palsu,
              harga aslinya asli. Tujuannya: mencari <em>cara</em> yang secara historis masuk akal
              (risk terkendali, profit konsisten) — <strong>bukan</strong> “pasti kaya”.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px,1fr))', gap: 10, marginTop: 14 }}>
              <MiniCard title="3 Meja Terpisah" body="Crypto, Commodities, Gold & Silver — modal & param terisolasi." />
              <MiniCard title="Paper Agent" body="Bot yang baca chart, filter sinyal, buka/tutup posisi simulasi." />
              <MiniCard title="Quant Lab" body="Ratusan kombinasi param diuji, ranking OOS-first." />
              <MiniCard title="Supervisor AI" body="Briefing bahasa manusia di Command Center." />
            </div>
            <div style={{ marginTop: 16, padding: 12, borderRadius: 8, background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', fontSize: 12, color: '#fbbf24' }}>
              <strong>Realita:</strong> PF bagus di 10 trade belum berarti. Butuh sample besar, OOS hijau, dan disiplin risk.
              Target bulanan yang agresif di KPI adalah <em>aspirasi paper</em>, bukan janji.
            </div>
          </div>
        )}

        {/* 2 Map */}
        {section === 'map' && (
          <div style={card}>
            <h2 style={h2}>Peta halaman</h2>
            <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
              {[
                { href: '/quant', title: '/quant — Command Center', body: 'Monitor 3 desk + chart equity + Agentic Supervisor (briefing).' },
                { href: '/quant-lab', title: '/quant-lab — Discovery Lab', body: 'Eksperimen multi-param per market part. Ranking + apply ke desk.' },
                { href: '/quant-crypto', title: '/quant-crypto', body: 'Live desk crypto: param aktif + paper agent + watchlist.' },
                { href: '/quant-commodities', title: '/quant-commodities', body: 'Oil, gas, copper, dll. Trend lebih lambat, default short allowed.' },
                { href: '/quant-gold-silver', title: '/quant-gold-silver', body: 'Emas & perak / metals. Vol lebih rendah, hold lebih panjang.' },
                { href: '/', title: '/ — Crypto scanner klasik', body: 'Scanner decoupling harian (fitur lama), terpisah dari quant desk.' },
              ].map((r) => (
                <a key={r.href} href={r.href} style={{ ...linkRow }}>
                  <div style={{ fontWeight: 700, color: '#93c5fd', fontSize: 13 }}>{r.title}</div>
                  <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>{r.body}</div>
                </a>
              ))}
            </div>
          </div>
        )}

        {/* 3 Params */}
        {section === 'params' && (
          <div style={card}>
            <h2 style={h2}>Parameter — artinya apa?</h2>
            <p style={p}>
              Klik tiap parameter untuk penjelasan. Angka default di UI = baseline;
              meta/event/bandit bisa mengecilkan/membesarkan ukuran trade di paper agent.
            </p>
            <div style={{ marginTop: 12 }}>
              {PARAMS.map((param, i) => (
                <div key={param.name} style={{ border: '1px solid #374151', borderRadius: 8, marginBottom: 8, overflow: 'hidden' }}>
                  <button
                    onClick={() => setOpenParam(openParam === i ? null : i)}
                    style={{
                      width: '100%',
                      textAlign: 'left',
                      padding: '12px 14px',
                      background: openParam === i ? 'rgba(139,92,246,0.08)' : '#0a0e17',
                      border: 'none',
                      color: '#f9fafb',
                      fontWeight: 700,
                      fontSize: 13,
                      cursor: 'pointer',
                      display: 'flex',
                      justifyContent: 'space-between',
                    }}
                  >
                    <span>{param.name}</span>
                    <span style={{ color: '#6b7280' }}>{openParam === i ? '−' : '+'}</span>
                  </button>
                  {openParam === i && (
                    <div style={{ padding: '12px 14px', background: '#111827', fontSize: 12, color: '#d1d5db', lineHeight: 1.55 }}>
                      <Line label="Apa itu" text={param.what} />
                      <Line label="Kenapa penting" text={param.why} />
                      <Line label="Contoh" text={param.example} />
                      <Line label="Risiko kalau salah" text={param.risk} color="#f87171" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 4 Signals */}
        {section === 'signals' && (
          <div style={card}>
            <h2 style={h2}>Dari mana “sinyal” berasal?</h2>
            <p style={p}>
              Agent tidak nebak. Dia menghitung pola matematis di candle + volume, lalu memberi skor kekuatan.
            </p>
            <div style={{ display: 'grid', gap: 10, marginTop: 14 }}>
              <InfoBlock
                title="Decoupling (RS vs index)"
                body="Mis. BTC anjlok, ETH/SOL diam atau naik + volume naik → sinyal beli relatif. Cocok untuk crypto vs BTC."
              />
              <InfoBlock
                title="Momentum + volume"
                body="Harga di atas MA + pergerakan baru cukup kuat + volume di atas rata-rata. Dipakai juga untuk gold/oil."
              />
              <InfoBlock
                title="Spike volume"
                body="Volume loncat jauh di atas normal (z-score) + kecepatan harga. Ditandai [spike]. Mirip jejak big player (simplified)."
              />
              <InfoBlock
                title="Multi-timeframe confluence"
                body="Sinyal digabung dari 15m–1w dengan bobot. Daily/weekly lebih berbobot daripada 15m."
              />
              <InfoBlock
                title="Supervisor LLM"
                body="Bukan yang eksekusi trade. Dia membaca hasil paper 3 desk lalu menulis briefing bahasa manusia (atau rule snapshot)."
              />
            </div>
            <div style={{ marginTop: 14, fontSize: 12, color: '#9ca3af' }}>
              Urutan keras saat entry: <strong>DD halt</strong> → <strong>event block</strong> →{' '}
              <strong>conflict guard</strong> → <strong>max position/exposure</strong> →{' '}
              <strong>min signal</strong> → size = risk% × meta × event × arm boost.
            </div>
          </div>
        )}

        {/* 5 Agent */}
        {section === 'agent' && (
          <div style={card}>
            <h2 style={h2}>Paper Trading Agent — otak harian</h2>
            <p style={p}>
              Di tiap desk, agent (kalau <strong>Start</strong>) polling market berkala:
              ambil candle → hitung sinyal MTF → kelola posisi → update equity & log.
            </p>
            <ol style={{ ...p, paddingLeft: 20 }}>
              <li style={{ marginBottom: 6 }}><strong>MetaAllocator</strong> — bobot antar 3 desk; desk sehat dapat skala risk lebih besar.</li>
              <li style={{ marginBottom: 6 }}><strong>EventFilter</strong> — hari event/weekend → ukuran trade dikecilkan atau entry diblokir.</li>
              <li style={{ marginBottom: 6 }}><strong>Fetch multi-TF</strong> — 15m…1w (tergantung primary interval desk).</li>
              <li style={{ marginBottom: 6 }}><strong>Signal stack</strong> — decoupling + momentum + spike, di-confluence.</li>
              <li style={{ marginBottom: 6 }}><strong>ConflictGuard</strong> — satu simbol, satu desk open.</li>
              <li style={{ marginBottom: 6 }}><strong>Size & SL/TP</strong> — qty dari risk%; stop/target dari ATR.</li>
              <li style={{ marginBottom: 6 }}><strong>Exit</strong> — SL, TP, time-stop, DD halt.</li>
              <li style={{ marginBottom: 6 }}><strong>Bandit</strong> — update pilihan strategi dari hasil trade.</li>
              <li><strong>Simpan</strong> — equity history, Supabase trades, optional stress MC.</li>
            </ol>
            <div style={{ marginTop: 14, padding: 12, borderRadius: 8, background: '#0a0e17', fontSize: 12, color: '#9ca3af' }}>
              Agent hanya jalan optimal saat <strong>tab terbuka</strong> (polling client ~45s) atau setelah kamu Step.
              State tetap tersimpan di Supabase; buka lagi → restore.
            </div>
          </div>
        )}

        {/* 6 Lab */}
        {section === 'lab' && (
          <div style={card}>
            <h2 style={h2}>Quant Lab — cari parameter, bukan “hoki sekali”</h2>
            <p style={p}>
              Lab memecah masalah jadi 3 part terpisah (Crypto / Comm / Gold-Silver).
              Tiap part menjalankan banyak kombinasi param (Quick ~18 · Standard ~36 · Full ~54),
              ranking dengan <strong>composite OOS-first</strong>.
            </p>
            <h3 style={{ ...h2, fontSize: 15, marginTop: 16 }}>Kenapa bukan “PF tertinggi menang”?</h3>
            <p style={p}>
              PF 9 di 3 trade itu kebetulan. Composite menekankan:
              OOS Profit Factor + Sharpe − Drawdown, plus penalti sample tipis.
              Hanya combo <strong>credible</strong> (OOS trades cukup + mayoritas window positif) yang auto-apply.
            </p>
            <h3 style={{ ...h2, fontSize: 15, marginTop: 16 }}>Alur Lab</h3>
            <ol style={{ ...p, paddingLeft: 20 }}>
              <li>Pilih part (Crypto / Comm / AuAg) — jangan digabung jadi satu pool.</li>
              <li>Pilih grid size (Quick/Standard/Full).</li>
              <li>Run batch (server sequential) atau tunggu cron harian.</li>
              <li>Baca leaderboard: PnL $1k OOS, period, credible.</li>
              <li>Apply best credible → param desk live (paper).</li>
            </ol>
            <p style={{ ...p, marginTop: 10 }}>
              Link: <a href="/quant-lab" style={{ color: '#c4b5fd' }}>/quant-lab</a>
            </p>
          </div>
        )}

        {/* 7 Metrics */}
        {section === 'metrics' && (
          <div style={card}>
            <h2 style={h2}>Cara membaca angka di dashboard</h2>
            <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
              {[
                ['PF ≥ 1.2 (OOS)', 'Idealnya > 1.3–1.5 dengan sample besar. Di bawah 1 = loss > win secara agregat.'],
                ['Sharpe (Ann.)', '> 1 bagus; > 2 sangat baik. Di bawah 0 = vol menghancurkan return.'],
                ['Max DD%', 'Batas nyaman paper di sini ~6–10%. Di atas itu rem DD halt seharusnya sudah membatasi.'],
                ['PnL $1k (OOS)', 'Proyeksi dolar di modal $1.000 hanya dari window out-of-sample. Lebih jujur daripada full-sample.'],
                ['Period', 'Berapa lama window backtest. PnL besar dalam 30 hari ≠ PnL sama dalam 2 tahun.'],
                ['Credible', 'Sample OOS cukup + edge windows mayoritas positif. Kalau “thin”, jangan over-react.'],
                ['Running PnL', 'Unrealized PnL posisi open (mark price terakhir), bukan realized.'],
                ['Pace /mo', 'Estimasi laju bulanan dari hari berjalan. Di awal sering misleading.'],
              ].map(([k, v]) => (
                <div key={k} style={{ padding: '10px 12px', background: '#0a0e17', borderRadius: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: '#93c5fd' }}>{k}</div>
                  <div style={{ fontSize: 12, color: '#d1d5db', marginTop: 4, lineHeight: 1.5 }}>{v}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 8 Glossary */}
        {section === 'glossary' && (
          <div style={card}>
            <h2 style={h2}>Kamus singkat</h2>
            <input
              value={glossaryQ}
              onChange={(e) => setGlossaryQ(e.target.value)}
              placeholder="Cari istilah… (PF, ATR, OOS, dll)"
              style={{
                width: '100%',
                padding: '10px 12px',
                background: '#1f2937',
                border: '1px solid #374151',
                borderRadius: 8,
                color: '#f9fafb',
                fontSize: 13,
                marginBottom: 12,
                outline: 'none',
              }}
            />
            {filteredGlossary.length === 0 && (
              <div style={{ fontSize: 12, color: '#6b7280' }}>Tidak ada istilah cocok.</div>
            )}
            {filteredGlossary.map((g) => (
              <div key={g.term} style={{ padding: '10px 0', borderBottom: '1px solid #1f2937' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#c4b5fd' }}>{g.term}</div>
                <div style={{ fontSize: 12, color: '#d1d5db', marginTop: 3, lineHeight: 1.5 }}>{g.def}</div>
              </div>
            ))}
          </div>
        )}

        {/* 9 FAQ */}
        {section === 'faq' && (
          <div style={card}>
            <h2 style={h2}>FAQ</h2>
            {faqs.map((f, i) => (
              <div key={f.q} style={{ border: '1px solid #374151', borderRadius: 8, marginBottom: 8, overflow: 'hidden' }}>
                <button
                  onClick={() => setOpenFaq(openFaq === i ? null : i)}
                  style={{
                    width: '100%',
                    textAlign: 'left',
                    padding: '12px 14px',
                    background: openFaq === i ? 'rgba(139,92,246,0.08)' : '#0a0e17',
                    border: 'none',
                    color: '#f9fafb',
                    fontWeight: 600,
                    fontSize: 13,
                    cursor: 'pointer',
                  }}
                >
                  {f.q}
                </button>
                {openFaq === i && (
                  <div style={{ padding: '12px 14px', background: '#111827', fontSize: 12, color: '#d1d5db', lineHeight: 1.55 }}>
                    {f.a}
                  </div>
                )}
              </div>
            ))}
            <div style={{ marginTop: 16, fontSize: 11, color: '#6b7280', lineHeight: 1.5 }}>
              Halaman ini dokumentasi hidup sistem paper Althunter. Bukan nasihat keuangan.
              Kalau ada bagian UI yang membingungkan, mulai dari <em>Big Picture</em> lalu <em>Peta halaman</em>.
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}

function Line({ label, text, color }: { label: string; text: string; color?: string }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: color || '#6b7280', textTransform: 'uppercase', marginBottom: 2 }}>
        {label}
      </div>
      <div style={{ color }}>{text}</div>
    </div>
  );
}

function MiniCard({ title, body }: { title: string; body: string }) {
  return (
    <div style={{ background: '#0a0e17', borderRadius: 8, padding: 12, border: '1px solid #374151' }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#c4b5fd' }}>{title}</div>
      <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 4, lineHeight: 1.45 }}>{body}</div>
    </div>
  );
}

function InfoBlock({ title, body }: { title: string; body: string }) {
  return (
    <div style={{ padding: '12px 14px', background: '#0a0e17', borderRadius: 8, border: '1px solid #374151' }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: '#93c5fd' }}>{title}</div>
      <div style={{ fontSize: 12, color: '#d1d5db', marginTop: 4, lineHeight: 1.5 }}>{body}</div>
    </div>
  );
}

const card: React.CSSProperties = {
  background: '#111827',
  border: '1px solid #374151',
  borderRadius: 12,
  padding: 20,
};

const h2: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 700,
  color: '#f9fafb',
  margin: '0 0 8px',
};

const p: React.CSSProperties = {
  fontSize: 13,
  color: '#d1d5db',
  lineHeight: 1.6,
  margin: 0,
};

const linkRow: React.CSSProperties = {
  display: 'block',
  padding: '12px 14px',
  background: '#0a0e17',
  borderRadius: 8,
  border: '1px solid #374151',
  textDecoration: 'none',
};
