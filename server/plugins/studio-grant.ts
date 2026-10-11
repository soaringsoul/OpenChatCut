import { createHmac, timingSafeEqual } from 'node:crypto';

const HEADER = { alg: 'HS256', typ: 'studio-grant', v: 1 } as const;

export interface StudioGrantPayload {
  v: 1;
  path: string;
  expiresAt: string;
  sha256: string | null;
  bytes: number | null;
}

function canonical(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => [key, sortValue(item)]));
  }
  return value;
}

function part(value: unknown): string {
  return Buffer.from(canonical(value)).toString('base64url');
}

export function verifyStudioGrant(secret: string, token: string, now = Date.now()): StudioGrantPayload | null {
  const pieces = token.split('.');
  if (pieces.length !== 3 || !secret) return null;
  const [header, payload, signature] = pieces;
  const expected = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as StudioGrantPayload;
    if (parsed.v !== 1 || typeof parsed.path !== 'string' || Date.parse(parsed.expiresAt) <= now) return null;
    void part(HEADER);
    return parsed;
  } catch {
    return null;
  }
}
