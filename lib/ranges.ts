/** Compact encode/decode of integer position sets: "10-20,25,30-40". */

export function parseRanges(raw: string | string[] | undefined): Set<number> {
  const out = new Set<number>();
  if (!raw) return out;
  const text = Array.isArray(raw) ? raw.join(',') : raw;
  for (const part of text.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const dash = trimmed.indexOf('-');
    if (dash === -1) {
      const n = parseInt(trimmed, 10);
      if (Number.isFinite(n)) out.add(n);
      continue;
    }
    const from = parseInt(trimmed.slice(0, dash), 10);
    const to = parseInt(trimmed.slice(dash + 1), 10);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) continue;
    // Guard against absurd ranges from malformed input
    if (to - from > 100_000) continue;
    for (let i = from; i <= to; i++) out.add(i);
  }
  return out;
}

export function buildRanges(positions: Iterable<number>): string {
  const sorted = Array.from(positions).sort((a, b) => a - b);
  if (sorted.length === 0) return '';
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const cur = sorted[i];
    if (i < sorted.length && cur === prev + 1) {
      prev = cur;
      continue;
    }
    parts.push(start === prev ? String(start) : `${start}-${prev}`);
    if (i < sorted.length) {
      start = cur;
      prev = cur;
    }
  }
  return parts.join(',');
}
