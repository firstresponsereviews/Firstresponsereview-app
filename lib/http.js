// Small HTTP helpers: bodies, cookies, responses and security headers.
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, 'That request was too large.');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export function parseBody(buf, type = '') {
  const s = buf.toString('utf8');
  if (type.includes('application/json')) {
    try { return JSON.parse(s || '{}'); } catch { throw new HttpError(400, 'Invalid JSON.'); }
  }
  const out = {};
  for (const [k, v] of new URLSearchParams(s)) {
    if (k in out) out[k] = [].concat(out[k], v);
    else out[k] = v;
  }
  return out;
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore bad cookie */ }
  }
  return out;
}

export function cookie(name, value, { maxAge, httpOnly = true, secure = false, sameSite = 'Lax', path = '/' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (maxAge != null) c += `; Max-Age=${maxAge}`;
  if (httpOnly) c += '; HttpOnly';
  if (secure) c += '; Secure';
  return c;
}

export function addCookie(res, c) {
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [].concat(prev || [], c));
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
].join('; ');

export const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
};

export function sendHtml(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(body);
}

export function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(JSON.stringify(obj));
}

export function redirect(res, location, status = 303) {
  res.writeHead(status, { Location: location, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end();
}

// Only allow redirects to paths inside this app.
export function safeNext(next, fallback = '/') {
  const s = String(next || '');
  return s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\') ? s : fallback;
}
