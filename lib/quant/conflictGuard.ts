/**
 * Global symbol conflict guard (paper §6.4 / §7.2).
 * One symbol, one open paper position across all desks.
 */

export interface OpenClaim {
  agentId: string;
  symbol: string;
  side: 'long' | 'short';
  strength: number;
  claimedAt: number;
}

const claims = new Map<string, OpenClaim>();

function key(symbol: string): string {
  return symbol.toUpperCase();
}

export function claimSymbol(
  agentId: string,
  symbol: string,
  side: 'long' | 'short',
  strength: number
): { ok: boolean; reason?: string; winner?: OpenClaim } {
  const k = key(symbol);
  const existing = claims.get(k);
  if (existing && existing.agentId !== agentId) {
    return {
      ok: false,
      reason: `symbol already open on ${existing.agentId}`,
      winner: existing,
    };
  }
  claims.set(k, {
    agentId,
    symbol: k,
    side,
    strength,
    claimedAt: Date.now(),
  });
  return { ok: true };
}

export function releaseSymbol(symbol: string, agentId?: string): void {
  const k = key(symbol);
  const existing = claims.get(k);
  if (!existing) return;
  if (agentId && existing.agentId !== agentId) return;
  claims.delete(k);
}

export function releaseAgent(agentId: string): void {
  claims.forEach((v, k) => {
    if (v.agentId === agentId) claims.delete(k);
  });
}

export function listClaims(): OpenClaim[] {
  return Array.from(claims.values());
}

export function isSymbolFree(symbol: string): boolean {
  return !claims.has(key(symbol));
}

/** Clear all — for tests / reset. */
export function resetClaims(): void {
  claims.clear();
}
