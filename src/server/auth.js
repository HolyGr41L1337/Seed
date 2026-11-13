// Access control for the local server.
//
// The agent can run commands, so the API is never open: every request needs
// the access token, either as "Authorization: Bearer <token>" (programs) or
// as a session cookie (the web UI, which logs in once with the token from
// the start-up URL). Cookie requests must also come from the app's own
// origin, so another site open in the same browser cannot use the session.
import crypto from 'node:crypto';

export const COOKIE = 'seed_session';

/**
 * Key that is part of the URL of extension files served to pages. A page learns
 * it from the (authenticated) manifest; <script> and <link> requests cannot carry
 * a token header, and cookies are not always available (embedded previews).
 */
export function assetKey(token) {
  return crypto.createHash('sha256').update(`seed-assets:${token}`).digest('hex').slice(0, 32);
}

export function sessionValue(token) {
  return crypto.createHash('sha256').update(`seed-session:${token}`).digest('hex');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function cookieOf(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** True when a browser request was made by a page of this app itself. */
function fromOwnOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';
  const origin = req.headers.origin;
  if (!origin) return true; // not a browser
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** @returns {{ ok: boolean, via: 'bearer' | 'cookie' | null, reason?: string }} */
export function authenticate(req, token) {
  const header = req.headers.authorization || '';
  if (/^bearer /i.test(header)) {
    return safeEqual(header.slice(7).trim(), token) ? { ok: true, via: 'bearer' } : { ok: false, via: null, reason: 'Invalid access token.' };
  }
  const cookie = cookieOf(req, COOKIE);
  if (cookie && safeEqual(cookie, sessionValue(token))) {
    if (!fromOwnOrigin(req)) return { ok: false, via: null, reason: 'Cross-origin requests cannot use the session cookie. Use the access token.' };
    return { ok: true, via: 'cookie' };
  }
  return { ok: false, via: null, reason: 'Access token required.' };
}

export function checkToken(candidate, token) {
  return typeof candidate === 'string' && safeEqual(candidate.trim(), token);
}

export function sessionCookie(token) {
  return `${COOKIE}=${sessionValue(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;
}
