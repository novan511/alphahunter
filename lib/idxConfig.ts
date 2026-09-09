export interface IDXStockCategory {
  name: string;
  stocks: IDXStockConfig[];
}

export interface IDXStockConfig {
  ticker: string;
  name: string;
  sector: string;
}

export const IHSG_INDEX_SYMBOL = '^JKSE';

export const IDX_STOCK_CATEGORIES: IDXStockCategory[] = [
  {
    name: 'Blue Chips',
    stocks: [
      { ticker: 'BBCA', name: 'Bank Central Asia', sector: 'Finance' },
      { ticker: 'BBRI', name: 'Bank Rakyat Indonesia', sector: 'Finance' },
      { ticker: 'BMRI', name: 'Bank Mandiri', sector: 'Finance' },
      { ticker: 'BBNI', name: 'Bank Negara Indonesia', sector: 'Finance' },
      { ticker: 'TLKM', name: 'Telkom Indonesia', sector: 'Telco' },
      { ticker: 'ASII', name: 'Astra International', sector: 'Auto' },
      { ticker: 'UNVR', name: 'Unilever Indonesia', sector: 'Consumer' },
      { ticker: 'HMSP', name: 'HM Sampoerna', sector: 'Consumer' },
      { ticker: 'GGRM', name: 'Gudang Garam', sector: 'Consumer' },
      { ticker: 'SMGR', name: 'Semen Indonesia', sector: 'Industry' },
    ],
  },
  {
    name: 'Bank',
    stocks: [
      { ticker: 'BBCA', name: 'Bank Central Asia', sector: 'Finance' },
      { ticker: 'BBRI', name: 'Bank Rakyat Indonesia', sector: 'Finance' },
      { ticker: 'BMRI', name: 'Bank Mandiri', sector: 'Finance' },
      { ticker: 'BBNI', name: 'Bank Negara Indonesia', sector: 'Finance' },
      { ticker: 'BRIS', name: 'Bank Syariah Indonesia', sector: 'Finance' },
      { ticker: 'MEGA', name: 'Bank Mega', sector: 'Finance' },
      { ticker: 'NISP', name: 'Bank OCBC NISP', sector: 'Finance' },
      { ticker: 'BTPN', name: 'Bank BTPN', sector: 'Finance' },
      { ticker: 'PNBN', name: 'Bank Pan Indonesia', sector: 'Finance' },
      { ticker: 'ARTO', name: 'Bank Jago', sector: 'Finance' },
      { ticker: 'BNGA', name: 'Bank CIMB Niaga', sector: 'Finance' },
      { ticker: 'BDMN', name: 'Bank Danamon', sector: 'Finance' },
      { ticker: 'PNBS', name: 'Bank Panin Syariah', sector: 'Finance' },
    ],
  },
  {
    name: 'Telco & Tech',
    stocks: [
      { ticker: 'TLKM', name: 'Telkom Indonesia', sector: 'Telco' },
      { ticker: 'EXCL', name: 'XL Axiata', sector: 'Telco' },
      { ticker: 'ISAT', name: 'Indosat Ooredoo', sector: 'Telco' },
      { ticker: 'EMTK', name: 'Telkomsel', sector: 'Telco' },
      { ticker: 'GOTO', name: 'GoTo Gojek Tokopedia', sector: 'Tech' },
      { ticker: 'BUKA', name: 'Bukalapak', sector: 'Tech' },
      { ticker: 'BALI', name: 'Bali Bintang Sejahtera', sector: 'Tech' },
    ],
  },
  {
    name: 'Consumer',
    stocks: [
      { ticker: 'UNVR', name: 'Unilever Indonesia', sector: 'Consumer' },
      { ticker: 'ICBP', name: 'Indofood CBP', sector: 'Consumer' },
      { ticker: 'INDF', name: 'Indofood Sukses Makmur', sector: 'Consumer' },
      { ticker: 'KLBF', name: 'Kalbe Farma', sector: 'Health' },
      { ticker: 'SIDO', name: 'Sido Muncul', sector: 'Health' },
      { ticker: 'HMSP', name: 'HM Sampoerna', sector: 'Consumer' },
      { ticker: 'GGRM', name: 'Gudang Garam', sector: 'Consumer' },
      { ticker: 'MYOR', name: 'Mayora Indah', sector: 'Consumer' },
      { ticker: 'INDR', name: 'Indofood Agri', sector: 'Consumer' },
      { ticker: 'GOOD', name: 'Goodrich', sector: 'Consumer' },
      { ticker: 'CINT', name: 'Citra Swasana', sector: 'Consumer' },
    ],
  },
  {
    name: 'Health',
    stocks: [
      { ticker: 'KLBF', name: 'Kalbe Farma', sector: 'Health' },
      { ticker: 'SIDO', name: 'Sido Muncul', sector: 'Health' },
      { ticker: 'MIKA', name: 'Mitra Keluarga Karyasehat', sector: 'Health' },
      { ticker: 'SILO', name: 'Siloam International Hospitals', sector: 'Health' },
      { ticker: 'HEAL', name: 'Prodia Wiharma Tbk', sector: 'Health' },
      { ticker: 'PRDA', name: 'Prodia Erabiotech', sector: 'Health' },
      { ticker: 'ENRG', name: 'Energi Mega Persada', sector: 'Health' },
    ],
  },
  {
    name: 'Mining & Energy',
    stocks: [
      { ticker: 'ADRO', name: 'Adaro Energy', sector: 'Mining' },
      { ticker: 'PTBA', name: 'Bukit Asam', sector: 'Mining' },
      { ticker: 'ITMG', name: 'Indo Tambangraya Megah', sector: 'Mining' },
      { ticker: 'ANTM', name: 'Aneka Tambang', sector: 'Mining' },
      { ticker: 'MDKA', name: 'Merdeka Copper Gold', sector: 'Mining' },
      { ticker: 'INDY', name: 'Indika Energy', sector: 'Energy' },
      { ticker: 'PGAS', name: 'Perusahaan Gas Negara', sector: 'Energy' },
      { ticker: 'AKRA', name: 'Akra Dimas Pratama', sector: 'Energy' },
      { ticker: 'MEDC', name: 'Medco Energi International', sector: 'Energy' },
      { ticker: 'ELSA', name: 'Elnusa', sector: 'Energy' },
      { ticker: 'RAJA', name: 'Rukun Raharja', sector: 'Energy' },
      { ticker: 'BSSI', name: 'Bank Syariah Indonesia', sector: 'Energy' },
      { ticker: 'PTPP', name: 'Pembangunan Perumahan', sector: 'Energy' },
    ],
  },
  {
    name: 'Plantation',
    stocks: [
      { ticker: 'LSIP', name: 'Sawit Lestari', sector: 'Plantation' },
      { ticker: 'SSMS', name: 'Sinar Sawit Subur', sector: 'Plantation' },
      { ticker: 'DSNG', name: 'Darma Henwa', sector: 'Plantation' },
      { ticker: 'AALI', name: 'Astra Agro Lestari', sector: 'Plantation' },
      { ticker: 'SSIA', name: 'Sri System', sector: 'Plantation' },
      { ticker: 'DSNG', name: 'Darma Henwa', sector: 'Plantation' },
    ],
  },
  {
    name: 'Property & Real Estate',
    stocks: [
      { ticker: 'BSDE', name: 'Bumi Serdam Damai', sector: 'Property' },
      { ticker: 'CTRA', name: 'Ciputra Development', sector: 'Property' },
      { ticker: 'SMRA', name: 'Summarecon Agung', sector: 'Property' },
      { ticker: 'PWON', name: 'Puri Wirja Damantara', sector: 'Property' },
      { ticker: 'LPKR', name: 'Lippo Cikarang', sector: 'Property' },
      { ticker: 'DILD', name: 'Duta Landindo', sector: 'Property' },
      { ticker: 'ASRI', name: 'Alam Sutera Realty', sector: 'Property' },
      { ticker: 'PANI', name: 'Persada Agung Niaga', sector: 'Property' },
      { ticker: 'CTRS', name: 'Ciputra Serpong Jaya', sector: 'Property' },
    ],
  },
  {
    name: 'Industry',
    stocks: [
      { ticker: 'SMGR', name: 'Semen Indonesia', sector: 'Industry' },
      { ticker: 'INTP', name: 'Indocement Tunggal Prakarsa', sector: 'Industry' },
      { ticker: 'TPIA', name: 'Chandra Asri Petrochemical', sector: 'Industry' },
      { ticker: 'BRPT', name: 'Barito Pacific', sector: 'Industry' },
      { ticker: 'INKP', name: 'Indah Kiat Pulp & Paper', sector: 'Industry' },
      { ticker: 'TOWR', name: 'Tower Bersama Infrastructure', sector: 'Industry' },
      { ticker: 'SPMA', name: 'Semen Padang', sector: 'Industry' },
      { ticker: 'BTON', name: 'Beton Perkasa Waskita', sector: 'Industry' },
    ],
  },
  {
    name: 'Infrastructure & Transport',
    stocks: [
      { ticker: 'TOWR', name: 'Tower Bersama Infrastructure', sector: 'Infrastructure' },
      { ticker: 'TBIG', name: 'Tower Bersama Infrastructure', sector: 'Infrastructure' },
      { ticker: 'JSMR', name: 'Jasa Marga', sector: 'Infrastructure' },
      { ticker: 'WTON', name: 'Waskita Beton Precast', sector: 'Infrastructure' },
      { ticker: 'ADHI', name: 'Adhi Karya', sector: 'Infrastructure' },
      { ticker: 'PTPP', name: 'Pembangunan Perumahan', sector: 'Infrastructure' },
      { ticker: 'WSKT', name: 'Waskita Karya', sector: 'Infrastructure' },
      { ticker: 'WIKA', name: 'Wijaya Karya', sector: 'Infrastructure' },
    ],
  },
  {
    name: 'Auto & Industry',
    stocks: [
      { ticker: 'ASII', name: 'Astra International', sector: 'Auto' },
      { ticker: 'AUTO', name: 'Astra Otoparts', sector: 'Auto' },
      { ticker: 'SMSM', name: 'Selamat Sempurna', sector: 'Auto' },
      { ticker: 'GJTL', name: 'Gajah Tunggal', sector: 'Auto' },
      { ticker: 'IMAS', name: 'Indomobil Sukses International', sector: 'Auto' },
      { ticker: 'CARS', name: 'JACCS Indonesia', sector: 'Auto' },
    ],
  },
  {
    name: 'Consumer Retail',
    stocks: [
      { ticker: 'ACES', name: 'Ace Hardware Indonesia', sector: 'Retail' },
      { ticker: 'MAPI', name: 'Mitra Adiperkasa', sector: 'Retail' },
      { ticker: 'RALS', name: 'Ramayana Lestari Sentosa', sector: 'Retail' },
      { ticker: 'LPPF', name: 'Lippo Department Store', sector: 'Retail' },
      { ticker: 'ERAA', name: 'Erajaya Swasembada', sector: 'Retail' },
      { ticker: 'AMRT', name: 'Sumber Alfaria Trijaya', sector: 'Retail' },
      { ticker: 'MAPI', name: 'Mitra Adiperkasa', sector: 'Retail' },
      { ticker: 'CNKO', name: 'MNC Asia Holding', sector: 'Retail' },
    ],
  },
];

export const ALL_IDX_TICKERS: string[] = Array.from(
  new Set(IDX_STOCK_CATEGORIES.flatMap((cat) => cat.stocks.map((s) => s.ticker)))
);

export const IDX_YAHOO_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';

export interface IDXIntervalConfig {
  yahooInterval: string;
  yahooRange: string;
  label: string;
}

export function getYahooParams(interval: string): IDXIntervalConfig {
  switch (interval) {
    case '1d':
      return { yahooInterval: '1d', yahooRange: '6mo', label: '1 Day' };
    case '1w':
      return { yahooInterval: '1wk', yahooRange: '2y', label: '1 Week' };
    case '1mo':
      return { yahooInterval: '1mo', yahooRange: '5y', label: '1 Month' };
    default:
      return { yahooInterval: '1d', yahooRange: '6mo', label: '1 Day' };
  }
}