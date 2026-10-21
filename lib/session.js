// Sessions live in two HttpOnly cookies holding the Supabase access and refresh tokens.
// Every request re-checks the access token with Supabase, so a forged cookie gets nowhere.
import { config } from './config.js';
import { auth, db, qs } from './supabase.js';
import { addCookie, cookie, parseCookies } from './http.js';

export const COOKIES = { access: 'fr_at', refresh: 'fr_rt', business: 'fr_biz' };

function decodeJwt(token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')); } catch { return null; }
}

export function setSession(res, s) {
  addCookie(res, cookie(COOKIES.access, s.access_token, { maxAge: s.expires_in || 3600, secure: config.secureCookies }));
  addCookie(res, cookie(COOKIES.refresh, s.refresh_token, { maxAge: 60 * 60 * 24 * 30, secure: config.secureCookies }));
}

export function clearSession(res) {
  for (const name of Object.values(COOKIES)) addCookie(res, cookie(name, '', { maxAge: 0, secure: config.secureCookies }));
}

export function setBusinessCookie(res, id) {
  addCookie(res, cookie(COOKIES.business, id, { maxAge: 60 * 60 * 24 * 365, secure: config.secureCookies }));
}

// Returns { token, id, email, name } or null.
export async function loadUser(req, res) {
  const c = parseCookies(req.headers.cookie);
  let token = c[COOKIES.access];
  const refreshToken = c[COOKIES.refresh];
  if (!token && !refreshToken) return null;
  const payload = token ? decodeJwt(token) : null;
  const expiring = !payload || !payload.exp || payload.exp * 1000 - Date.now() < 60_000;
  if (expiring && refreshToken) {
    try {
      const s = await auth.refresh(refreshToken);
      setSession(res, s);
      token = s.access_token;
    } catch {
      clearSession(res);
      return null;
    }
  }
  if (!token) return null;
  try {
    const u = await auth.getUser(token);
    return { token, id: u.id, email: u.email, name: (u.user_metadata && u.user_metadata.full_name) || '' };
  } catch (e) {
    if (e.status === 401 || e.status === 403) { clearSession(res); return null; }
    throw e;
  }
}

// Loads the signed-in user's role, businesses and the one they're currently viewing.
export async function loadContext(req, user) {
  const d = db(user.token);
  const [profiles, memberships] = await Promise.all([
    d.select('profiles', qs({ id: `eq.${user.id}`, select: 'id,full_name,role' })),
    d.select('memberships', qs({ user_id: `eq.${user.id}`, select: 'business_id,role' })),
  ]);
  const ids = memberships.map((m) => m.business_id);
  const businesses = ids.length
    ? await d.select('businesses', qs({ id: `in.(${ids.join(',')})`, select: '*', order: 'name.asc' }))
    : [];
  const wanted = parseCookies(req.headers.cookie)[COOKIES.business];
  const current = businesses.find((b) => b.id === wanted) || businesses[0] || null;
  const role = (profiles[0] && profiles[0].role) || 'client';
  return { user, role, isStaff: role === 'staff', businesses, current };
}
