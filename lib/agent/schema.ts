/** Small hand-rolled argument validator — the repo avoids new dependencies. */

import { createHash } from 'node:crypto';
import type { ParamDef, ToolDefinition } from './types';

export interface ValidationResult {
  ok: boolean;
  args: Record<string, unknown>;
  errors: string[];
}

function coerce(value: unknown, def: ParamDef): { ok: boolean; value?: unknown; error?: string } {
  if (def.type === 'string[]') {
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
      return { ok: false, error: 'harus array of string' };
    }
    return { ok: true, value: value as string[] };
  }
  if (def.type === 'string') {
    if (typeof value !== 'string') return { ok: false, error: 'harus string' };
    return { ok: true, value };
  }
  if (def.type === 'number') {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return { ok: false, error: 'harus angka' };
    if (def.min != null && n < def.min) return { ok: false, error: `minimal ${def.min}` };
    if (def.max != null && n > def.max) return { ok: false, error: `maksimal ${def.max}` };
    return { ok: true, value: n };
  }
  if (def.type === 'boolean') {
    if (typeof value === 'boolean') return { ok: true, value };
    if (value === 'true' || value === 1) return { ok: true, value: true };
    if (value === 'false' || value === 0) return { ok: true, value: false };
    return { ok: false, error: 'harus boolean' };
  }
  return { ok: false, error: `tipe tidak dikenal: ${String(def.type)}` };
}

/** Parse and validate a raw JSON string argument from the model. */
export function validateToolArgs(
  raw: string,
  tool: ToolDefinition
): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || '{}');
  } catch {
    return { ok: false, args: {}, errors: ['argumen bukan JSON valid'] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, args: {}, errors: ['argumen harus objek'] };
  }
  const input = parsed as Record<string, unknown>;
  const args: Record<string, unknown> = {};
  const errors: string[] = [];

  for (const [key, def] of Object.entries(tool.params)) {
    const present = Object.prototype.hasOwnProperty.call(input, key) && input[key] != null;
    if (!present) {
      if (def.required) errors.push(`${key} wajib diisi`);
      continue;
    }
    const result = coerce(input[key], def);
    if (!result.ok) {
      errors.push(`${key}: ${result.error}`);
      continue;
    }
    const value = result.value as string | number | boolean | string[];
    if (def.enum && typeof value === 'string' && !def.enum.includes(value)) {
      errors.push(`${key} harus salah satu dari ${def.enum.join(', ')}`);
      continue;
    }
    args[key] = value;
  }

  const allowed = new Set(Object.keys(tool.params));
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) errors.push(`argumen tidak dikenal: ${key}`);
  }

  return { ok: errors.length === 0, args, errors };
}

/** Stable key so a retried webhook cannot execute the same write twice. */
export function idempotencyKey(
  chatId: string,
  toolName: string,
  args: Record<string, unknown>
): string {
  const stable = JSON.stringify(args, Object.keys(args).sort());
  return createHash('sha256')
    .update(`${chatId}\u0000${toolName}\u0000${stable}`)
    .digest('hex')
    .slice(0, 32);
}

/** Deterministic string used in audit logs and confirmation prompts. */
export function describeCall(toolName: string, args: Record<string, unknown>): string {
  const parts = Object.keys(args)
    .sort()
    .map((k) => `${k}=${JSON.stringify(args[k])}`);
  return parts.length ? `${toolName}(${parts.join(', ')})` : toolName;
}
