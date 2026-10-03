/**
 * Coin category taxonomy for narrative context.
 *
 * Purpose: a trader reading a ranking needs to know WHAT a coin is before
 * acting on a signal. "SHIB strong_buy" and "AAVE strong_buy" carry very
 * different risk — one is a reflexive meme asset, the other a DeFi protocol
 * with real TVL and usually unlocks. The numeric score cannot express that, so
 * each coin is tagged with its sector/narrative bucket.
 *
 * Design notes:
 * - Categories are curated, not inferred from price action. A data-mined
 *   category would drift with the market and could not be audited.
 * - A coin can legitimately sit in several buckets (an L2 that is also DeFi),
 *   so PRIMARY_CATEGORY is the single dominant label shown in the table and
 *   SECONDARY holds cross-tags.
 * - Unknown symbols fall back to "other" rather than a guess. A wrong label is
 *   worse than admitting ignorance.
 *
 * NOTE: keys are bare tickers (quote suffix stripped). One entry per ticker —
 * duplicate keys would silently overwrite each other, which is how a previous
 * version of this file lost several mappings.
 */

export type CategoryId =
  | 'l1'
  | 'l2'
  | 'defi'
  | 'stablecoin'
  | 'meme'
  | 'ai'
  | 'gaming'
  | 'infra'
  | 'oracle'
  | 'rwa'
  | 'privacy'
  | 'exchange'
  | 'payments'
  | 'perps'
  | 'liquid_staking'
  | 'storage'
  | 'nft'
  | 'other';

export interface CategoryMeta {
  id: CategoryId;
  label: string;
  /** Emoji for the compact table column. */
  icon: string;
  color: string;
  /** One-line description shown as a tooltip. */
  blurb: string;
}

export const CATEGORIES: Record<CategoryId, CategoryMeta> = {
  l1: {
    id: 'l1', label: 'Layer 1', icon: '⛓', color: '#60a5fa',
    blurb: 'Base settlement layer. Revenue depends on chain activity and fees.',
  },
  l2: {
    id: 'l2', label: 'Layer 2', icon: '🧱', color: '#818cf8',
    blurb: 'Scaling chain on a host L1. Typically remits sequencer fees to the host.',
  },
  defi: {
    id: 'defi', label: 'DeFi', icon: '🏦', color: '#22d3ee',
    blurb: 'Lending, DEXs and yield markets. Driven by TVL, fees and emissions.',
  },
  perps: {
    id: 'perps', label: 'Perps / DEX', icon: '📊', color: '#2dd4bf',
    blurb: 'Perpetual and spot DEXs. Revenue is fee- and volume-driven, highly cyclical.',
  },
  liquid_staking: {
    id: 'liquid_staking', label: 'Liquid Staking', icon: '🌊', color: '#7dd3fc',
    blurb: 'Staked-asset market. Tracks staking yield plus its own protocol token.',
  },
  stablecoin: {
    id: 'stablecoin', label: 'Stablecoin', icon: '💵', color: '#94a3b8',
    blurb: 'Pegged to fiat or a crypto basket. Trades on depeg risk, not direction.',
  },
  meme: {
    id: 'meme', label: 'Meme', icon: '🐸', color: '#f472b6',
    blurb: 'Community/reflexive asset. No cash-flow anchor; moves on attention and liquidity.',
  },
  ai: {
    id: 'ai', label: 'AI / Compute', icon: '🤖', color: '#a78bfa',
    blurb: 'AI compute, data or agent networks. Narrative-led with thin real revenue.',
  },
  gaming: {
    id: 'gaming', label: 'Gaming / Metaverse', icon: '🎮', color: '#fb923c',
    blurb: 'Play-to-earn and metaverse assets. Depends on sustained active users.',
  },
  infra: {
    id: 'infra', label: 'Infrastructure', icon: '🛠', color: '#94a3b8',
    blurb: 'Indexing, interoperability and tooling the chain itself needs.',
  },
  oracle: {
    id: 'oracle', label: 'Oracle / Data', icon: '📡', color: '#38bdf8',
    blurb: 'Price feeds and data delivery. Real utility, small addressable market.',
  },
  rwa: {
    id: 'rwa', label: 'RWA / Yield', icon: '🏛', color: '#34d399',
    blurb: 'Tokenised real-world assets and on-chain yield products.',
  },
  privacy: {
    id: 'privacy', label: 'Privacy', icon: '🥷', color: '#a3a3a3',
    blurb: 'Focus on transaction privacy and fungibility.',
  },
  exchange: {
    id: 'exchange', label: 'Exchange Token', icon: '💱', color: '#fbbf24',
    blurb: 'Exchange equity proxy. Tracks that venue: fees, volumes, token burns.',
  },
  payments: {
    id: 'payments', label: 'Payments', icon: '💳', color: '#34d399',
    blurb: 'Payments and consumer transfer rails. Competes on cost and speed.',
  },
  storage: {
    id: 'storage', label: 'Storage', icon: '💾', color: '#c084fc',
    blurb: 'Decentralised storage. Revenue depends on long-term retention contracts.',
  },
  nft: {
    id: 'nft', label: 'NFT / Consumer', icon: '🎨', color: '#f9a8d4',
    blurb: 'Digital collectibles and consumer crypto apps.',
  },
  other: {
    id: 'other', label: 'Other', icon: '•', color: '#6b7280',
    blurb: 'Not classified — check the project before sizing a position.',
  },
};

/** Primary category by bare ticker. One entry per ticker. */
const PRIMARY: Record<string, CategoryId> = {
  // ---- Layer 1 ----
  BTC: 'l1', ETH: 'l1', SOL: 'l1', BNB: 'l1', ADA: 'l1', AVAX: 'l1',
  DOT: 'l1', ATOM: 'l1', ALGO: 'l1', NEAR: 'l1', ICP: 'l1', APT: 'l1',
  SUI: 'l1', HBAR: 'l1', VET: 'l1', XLM: 'l1', EOS: 'l1', XTZ: 'l1',
  FLOW: 'l1', SEI: 'l1', TIA: 'l1', MON: 'l1', KAS: 'l1', TRX: 'l1',
  BCH: 'l1', ETC: 'l1', DASH: 'l1', XLM2: 'l1', HNT: 'l1', KAVA: 'l1',
  CELO: 'l1', ROSE: 'l1', MINA: 'l1', QNT: 'l1', XDC: 'l1', CFX: 'l1',
  AR: 'l1', WAVES: 'l1', ONE: 'l1', NEBL: 'l1', ZIL: 'l1', ONT: 'l1',
  IOTA: 'l1', FLUX: 'l1', DGB: 'l1', NKN: 'l1', ACA: 'l1', ASTR: 'l1',
  DYM: 'l1', KAVA3: 'l1', CHR: 'l1', MOVR: 'l1', GLMR: 'l1', ASTR2: 'l1',
  TWT: 'l1', ROSE2: 'l1', COTI: 'l1', SYS: 'l1', DCR: 'l1',

  // ---- Layer 2 ----
  ARB: 'l2', OP: 'l2', MNT: 'l2', STRK: 'l2', METIS: 'l2', ZK: 'l2',
  SCR: 'l2', BLAST: 'l2', ZRO: 'l2', LINEA: 'l2', SCROLL: 'l2', MANTA: 'l2',
  TAO: 'l2', CYBER: 'l2', ZETA: 'l2', ZKSYNC: 'l2', SKL: 'l2',

  // ---- DeFi core ----
  UNI: 'defi', AAVE: 'defi', CAKE: 'defi', CRV: 'defi', PENDLE: 'defi',
  SUSHI: 'defi', MKR: 'defi', COMP: 'defi', SNX: 'defi', BAL: 'defi',
  YFI: 'defi', ZRX: 'defi', REN: 'defi', RUNE: 'defi', KNC: 'defi',
  BAND: 'defi', MORPHO: 'defi', AERO: 'defi', GMX: 'defi', RDNT: 'defi',
  SPELL: 'defi', METEO: 'defi', DEXE: 'defi', FLUID: 'defi', SYRUP: 'defi',
  DRV: 'defi', ENA: 'defi', EIGEN: 'defi', EIGEN2: 'defi', RESOLV: 'defi',
  LBTC: 'defi', WBTC: 'defi', BBTC: 'defi', BNSOL: 'defi', SOLVBTC: 'defi',
  PAXG: 'rwa', XAUT: 'rwa', JLP: 'defi', CARV: 'defi', PNP: 'defi',
  DF: 'defi', VELO: 'defi', WING: 'defi', TRUMP2: 'defi', ASTER: 'perps',
  LQTY: 'defi', CVX: 'defi', FXS: 'defi', TICKER: 'defi', SPOT: 'defi',
  AXL: 'defi', ACA2: 'defi', BAL2: 'defi', UMA: 'defi', OHM: 'defi',
  GNS: 'defi', QNT3: 'defi', RDN: 'defi', EQ: 'defi', PT: 'defi',
  SUPER: 'defi', MOO: 'defi', BISON: 'defi', VEDICTA: 'defi',

  // ---- Perp / spot DEXs ----
  DYDX: 'perps', JUP: 'perps', RAY: 'perps', ORCA: 'perps', JTO: 'perps',
  DRIFT: 'perps', WLD: 'perps', ETHFI: 'perps', DYM2: 'perps', AEVO: 'perps',
  HYPER: 'perps', VELO2: 'perps', GMX2: 'perps', PYX: 'perps', JUP2: 'perps',
  LIGHT: 'perps', WARP: 'perps', VANRY: 'perps', APEX: 'perps', AURORA: 'defi',

  // ---- Liquid staking / LST ----
  STETH: 'liquid_staking', RPL: 'liquid_staking', LDO: 'liquid_staking',
  WSTETH: 'liquid_staking', WEETH: 'liquid_staking', EZETH: 'liquid_staking',
  RSETH: 'liquid_staking', METH: 'liquid_staking', JLP2: 'liquid_staking',
  SBTC: 'liquid_staking', LBTC2: 'liquid_staking',

  // ---- Stablecoins & tokenised funds ----
  USDT: 'stablecoin', USDC: 'stablecoin', DAI: 'stablecoin', USDE: 'stablecoin',
  PYUSD: 'stablecoin', FDUSD: 'stablecoin', TUSD: 'stablecoin', USDP: 'stablecoin',
  GHO: 'stablecoin', LUSD: 'stablecoin', FRAX: 'stablecoin', USDD: 'stablecoin',
  USD1: 'stablecoin', USDG: 'stablecoin', RLUSD: 'stablecoin', USYC: 'stablecoin',
  BFUSD: 'stablecoin', USD0: 'stablecoin', USDY: 'stablecoin', USDAI: 'stablecoin',
  OUSD: 'stablecoin', USDF: 'stablecoin', BUIDL: 'stablecoin', USTB: 'stablecoin',
  KAU: 'stablecoin', USDGO: 'stablecoin', SYRUP2: 'stablecoin',
  EURC: 'stablecoin', USDE2: 'stablecoin', USDG2: 'stablecoin',

  // ---- Meme ----
  DOGE: 'meme', SHIB: 'meme', PEPE: 'meme', WIF: 'meme', BONK: 'meme',
  FLOKI: 'meme', MEME: 'meme', TRUMP: 'meme', PENGU: 'meme', PUMP: 'meme',
  MOG: 'meme', POPCAT: 'meme', NEIRO: 'meme', TURBO: 'meme', BOME: 'meme',
  MEW: 'meme', MOODENG: 'meme', CHILLGUY: 'meme', PNUT: 'meme', SNAI: 'meme',
  RETARDIO: 'meme', POP: 'meme', M: 'meme', AI: 'meme', FWOG: 'meme',
  PONY: 'meme', SIGMA: 'meme', S: 'meme', BULLY: 'meme', BANANA: 'meme',
  GRIFFAIN: 'meme', SLERF: 'meme', MYRO: 'meme', POPCAT2: 'meme', G: 'meme',
  PIVX: 'meme', KEANU: 'meme', FROG: 'meme', NINJA: 'meme', MUMU: 'meme',
  BULL: 'meme', SPX: 'meme', TREASURE: 'meme', NEWT: 'meme', MUBARAK: 'meme',

  // ---- AI / compute ----
  FET: 'ai', RENDER: 'ai', OCEAN: 'ai', AKT: 'ai', NMR: 'ai', GRT: 'ai',
  PHB: 'ai', ARKM: 'ai', VIRTUAL: 'ai', AI16Z: 'ai', VANA: 'ai', IQ: 'ai',
  NOS: 'ai', SAGA: 'ai', TAO2: 'ai', BOME2: 'ai', KITE: 'ai',

  // ---- Gaming / metaverse ----
  SAND: 'gaming', MANA: 'gaming', AXS: 'gaming', GALA: 'gaming', ENJ: 'gaming',
  THE: 'gaming', MAGIC: 'gaming', BIGTIME: 'gaming', PIXEL: 'gaming', YGG: 'gaming',
  DYP: 'gaming', ILV: 'gaming', PYR: 'gaming', MAVIA: 'gaming', PORTAL: 'gaming',
  BEAM: 'gaming', JASMY: 'gaming', ALICE: 'gaming', TLM: 'gaming', WEMIX: 'gaming',
  UST: 'gaming', RLC: 'gaming', SPELL2: 'gaming',

  // ---- NFT / consumer ----
  APE: 'nft', BLUR: 'nft', RARE: 'nft', IMX: 'nft', LOOKS: 'nft',
  SUPER2: 'nft', CYBER3: 'nft', WOO: 'nft', HIFI: 'nft',

  // ---- Oracle / data ----
  PYTH: 'oracle', API3: 'oracle', TRB: 'oracle', DIA: 'oracle', GLM: 'oracle',
  BAND2: 'oracle', UMA2: 'oracle', PHB2: 'oracle', ANKR: 'infra',

  // ---- Infrastructure / indexing / interop ----
  LINK: 'infra', ENS: 'infra', GRT2: 'infra', FIL: 'storage', ARB2: 'infra',
  LRC: 'infra', ZRX2: 'infra', SYN: 'infra', POWR: 'infra', FLM: 'infra',
  GLM2: 'infra', API: 'infra', W: 'infra', CYBER2: 'infra', HASH: 'infra',
  LIT: 'infra', NTRN: 'infra', DEGEN: 'infra', DYM3: 'infra', ZETA2: 'infra',
  RONIN: 'infra', AXL2: 'infra', SAFE: 'infra', SAFE2: 'infra',
  ARKM2: 'infra', GPS: 'infra', AI3: 'infra', COOKIE: 'infra', HFT: 'infra',
  KMD: 'infra', SXP: 'infra', CVC: 'infra', ID: 'infra', RSS3: 'infra',
  YOYO: 'infra', BMTP: 'infra', TNSR: 'infra', ZNS: 'infra',

  // ---- Storage ----
  ARWEAVE: 'storage', SIA: 'storage', BLAN: 'storage', SC2: 'storage',
  FIL2: 'storage', AKT2: 'storage',

  // ---- Privacy ----
  XMR: 'privacy', ZEC: 'privacy', SCRT: 'privacy', KEEP: 'privacy', ZEN: 'privacy',
  DASH2: 'privacy', XMR2: 'privacy', ZEC2: 'privacy',

  // ---- RWA / yield ----
  ONDO: 'rwa', CFG: 'rwa', MPL: 'rwa', TRU: 'rwa', OUSG: 'rwa',
  JTRSY: 'rwa', YLDS: 'rwa', EUTBL: 'rwa', PROPS: 'rwa', SPONGE: 'rwa',
  RWA: 'rwa', OAX: 'rwa', ROSE3: 'rwa', VILA: 'rwa',

  // ---- Exchange tokens ----
  OKB: 'exchange', CRO: 'exchange', BGB: 'exchange', KCS: 'exchange',
  GT: 'exchange', HT: 'exchange', MX: 'exchange', LEVER: 'exchange',
  COCOS: 'exchange', PHB3: 'exchange',

  // ---- Payments ----
  XRP: 'payments', LTC: 'payments', STX: 'payments', XVG: 'payments',
  XMR3: 'payments', BCH2: 'payments',

  // ---- Notable live majors ----
  HYPE: 'perps', INJ: 'defi', POL: 'l1', SKY: 'defi', FLR: 'oracle',
  NEXO: 'exchange', PAXG2: 'rwa', JST: 'defi', USTBL: 'rwa',
  PI: 'l1', BTT: 'storage', XPL: 'l2', BSV: 'l1', NIGHT: 'l1',
  GRASS: 'ai', LEO: 'exchange', HTX: 'exchange', WLFI: 'defi',
  CC: 'l1', VVV: 'defi', GRAM: 'l1', BTW: 'l1', RAIN: 'meme',
  PRL: 'defi', UB: 'defi', WBT: 'exchange', KAS2: 'l1',
  PENGU3: 'meme', FIGR: 'defi', USDE3: 'stablecoin', AKEDO: 'meme',
  AKE: 'meme', MARSCOIN: 'meme', NIGHT2: 'l1', MARS: 'meme',
};

/**
 * Cross-tags. The table shows the primary label; these appear on hover and in
 * the detail panel so an L2 that is also a DEX is not misread.
 */
const SECONDARY: Record<string, CategoryId[]> = {
  ARB: ['defi'], OP: ['defi'], MNT: ['defi'], STRK: ['defi'],
  BLAST: ['defi'], ZRO: ['infra'],
  BNB: ['exchange'], CRO: ['l1'], GT: ['l1'], KCS: ['l1'], OKB: ['l1'],
  CAKE: ['exchange'], UNI: ['exchange'], AERO: ['defi'],
  GMX: ['perps'], ASTER: ['perps'], DYDX: ['perps'], PENDLE: ['perps'],
  LDO: ['liquid_staking'], RPL: ['liquid_staking'],
  STETH: ['liquid_staking'], WSTETH: ['liquid_staking'], WEETH: ['liquid_staking'],
  EZETH: ['liquid_staking'], RSETH: ['liquid_staking'],
  SAND: ['nft'], MANA: ['nft'], AXS: ['nft'], GALA: ['nft'], IMX: ['nft'],
  APE: ['nft'],
  XMR: ['privacy'], ZEC: ['privacy'], SCRT: ['privacy'], DASH: ['privacy'],
  PAXG: ['rwa'], XAUT: ['rwa'], ONDO: ['rwa'],
  RNDR: ['ai'], RENDER: ['ai'], TAO: ['ai'], FET: ['ai'], OCEAN: ['ai'],
  FIL: ['infra'], AR: ['storage'],
  MORPHO: ['defi'], EIGEN: ['defi'], JTO: ['perps'],
  SOLVBTC: ['liquid_staking'], BNSOL: ['liquid_staking'],
};

/** Categories where the asset tracks a peg or a yield rather than a direction. */
const NON_DIRECTIONAL: ReadonlySet<CategoryId> = new Set<CategoryId>(['stablecoin']);

/**
 * Strip the venue prefix and quote suffix to get a bare ticker.
 *
 * The suffix strip must be conditional: several assets are NAMED after their
 * quote (USDT, USDC, USDD), so blindly removing a trailing "USDT" turned USDT
 * into an empty string and lost the mapping.
 */
function bareTicker(sym: string): string {
  const cleaned = sym.replace(/^[a-z]+:/i, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const stripped = cleaned.replace(/(USDT|USDC|BUSD|FDUSD)$/, '');
  // If stripping consumed the whole ticker, the asset IS the quote asset.
  return stripped.length > 0 ? stripped : cleaned;
}

/**
 * Resolve a category. Unknown symbols return 'other' rather than a guess —
 * a wrong label is worse than an honest "unclassified".
 */
export function categoryFor(symbol: string): CategoryId {
  return PRIMARY[bareTicker(symbol)] ?? 'other';
}

export function secondaryCategoriesFor(symbol: string): CategoryId[] {
  return SECONDARY[bareTicker(symbol)] ?? [];
}

export function categoryMeta(id: CategoryId): CategoryMeta {
  return CATEGORIES[id] ?? CATEGORIES.other;
}

/** True when the asset is expected to trade on peg/flow rather than direction. */
export function isNonDirectional(id: CategoryId): boolean {
  return NON_DIRECTIONAL.has(id);
}

/** Short sentence describing the category and its dominant risk. */
export function categoryNarrative(id: CategoryId): string {
  return CATEGORIES[id]?.blurb ?? CATEGORIES.other.blurb;
}

export function allCategoryIds(): CategoryId[] {
  return Object.keys(CATEGORIES) as CategoryId[];
}

/** Exposed for tests: the raw mapping, so coverage can be measured. */
export const _PRIMARY_MAP = PRIMARY;
