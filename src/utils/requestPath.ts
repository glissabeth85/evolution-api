import { createHash, timingSafeEqual } from 'crypto';
import { Request } from 'express';

/**
 * Real route path of the request (mount path + path), without the query string.
 * Normalized like Express' default routing: case-insensitive and ignoring a trailing slash.
 *
 * Never use `req.originalUrl.includes(...)` for authorization decisions: originalUrl contains
 * the query string, so `?x=/instance/create` would match any route.
 */
export function requestPath(req: Request): string {
  const path = `${req.baseUrl || ''}${req.path || ''}`.toLowerCase();
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

export const isInstanceCreateRoute = (req: Request) => requestPath(req) === '/instance/create';

export const isFetchInstancesRoute = (req: Request) => requestPath(req) === '/instance/fetchinstances';

/** Constant-time string comparison (hashing first so length differences don't leak). */
export function safeCompare(a?: string | null, b?: string | null): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
