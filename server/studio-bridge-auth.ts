import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export function studioBridgeToken(): string {
  return process.env.OPENCUT_STUDIO_TOKEN ?? '';
}

export function studioGrantSecret(): string {
  return process.env.STUDIO_GRANT_SECRET ?? '';
}

export function bearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization ?? '';
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
}

export function studioBridgeAuthorized(req: IncomingMessage, token = studioBridgeToken()): boolean {
  const presented = bearerToken(req);
  if (!presented || !token) return false;
  const left = Buffer.from(presented);
  const right = Buffer.from(token);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Shape-gate exception: the studio service has no browser Origin. */
export function studioBridgeRequestAllowed(req: IncomingMessage): boolean {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/api/studio-bridge/pairings/confirm' && studioBridgeAuthorized(req, process.env.STUDIO_SERVICE_TOKEN ?? '')) return true;
  return url.pathname.startsWith('/api/studio-bridge/') && studioBridgeAuthorized(req);
}

export function sha256Buffer(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
