/**
 * Shareable-URL helpers for the home page.
 *
 * The homepage keeps a lot of view state in React only, so a refresh or a link
 * pasted into Telegram threw away everything the user had set up. These helpers
 * map that state to query params and back.
 *
 * Values are kept as plain strings here so the module stays free of component
 * imports; index.tsx does the typed conversion.
 */

export interface HomeUrlState {
  /** `autonomous` | `manual` */
  mode?: string;
  /** Selected asset symbol, e.g. `ETHUSDT` */
  asset?: string;
  /** Focused narrative sector id */
  cat?: string;
  /** Scan coverage depth */
  depth?: string;
  /** Universe ordering */
  order?: string;
  /** Ranking signal filter */
  filter?: string;
  /** Ranking sort, `conf.desc,rsz.asc` */
  sort?: string;
}

const ALLOWED_MODES = new Set(['autonomous', 'manual']);
const ALLOWED_DEPTHS = new Set(['all', '100', '500']);
const ALLOWED_ORDERS = new Set(['cap', 'volume']);

/** Read known keys off a Next.js query object, ignoring arrays/junk. */
export function readUrlState(query: Record<string, string | string[] | undefined>): HomeUrlState {
  const pick = (key: string): string | undefined => {
    const v = query[key];
    if (typeof v === 'string' && v.length > 0 && v.length <= 64) return v;
    return undefined;
  };

  const mode = pick('mode');
  const depth = pick('depth');
  const order = pick('order');

  return {
    // Unknown values fall back to defaults rather than being passed through,
    // so a malformed link can't put the toolbar into an impossible state.
    mode: mode && ALLOWED_MODES.has(mode) ? mode : undefined,
    asset: pick('asset')?.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20) || undefined,
    cat: pick('cat') || undefined,
    depth: depth && ALLOWED_DEPTHS.has(depth) ? depth : undefined,
    order: order && ALLOWED_ORDERS.has(order) ? order : undefined,
    filter: pick('filter') || undefined,
    sort: pick('sort') || undefined,
  };
}

/**
 * Serialize state back to a query object. Empty/default values are omitted so
 * the canonical URL stays short — `/` for a fresh page, not `/?mode=…&depth=…`.
 */
export function writeUrlState(state: HomeUrlState): Record<string, string> {
  const q: Record<string, string> = {};
  if (state.mode && state.mode !== 'autonomous') q.mode = state.mode;
  if (state.asset) q.asset = state.asset;
  if (state.cat) q.cat = state.cat;
  if (state.depth && state.depth !== 'all') q.depth = state.depth;
  if (state.order && state.order !== 'cap') q.order = state.order;
  if (state.filter && state.filter !== 'all') q.filter = state.filter;
  if (state.sort) {
    // A single-key sort in default direction is not worth a param.
    const trimmed = state.sort
      .split(',')
      .filter(Boolean)
      .filter((pair) => !/^(conf|signal)\.desc$/.test(pair))
      .join(',');
    if (trimmed) q.sort = trimmed;
  }
  return q;
}

/**
 * True when the live query already round-trips to `target`, so we can skip the
 * replace and avoid a needless history entry / re-render.
 *
 * Both sides are normalized through read→write, so `?depth=3` and a missing
 * `depth` correctly compare equal (both normalize to the default).
 */
export function sameQuery(
  current: Record<string, string | string[] | undefined>,
  target: Record<string, string>
): boolean {
  const normalized = writeUrlState(readUrlState(current));
  const aKeys = Object.keys(normalized);
  const bKeys = Object.keys(target);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => normalized[k] === target[k]);
}
