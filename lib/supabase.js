// Thin client for Supabase Auth (GoTrue) and the database REST API (PostgREST).
// Uses the built-in fetch, so the app has no package dependencies.
import { config } from './config.js';

export class SupabaseError extends Error {
  constructor(status, message, body) { super(message); this.status = status; this.body = body; }
}

async function call(url, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && (data.error_description || data.msg || data.message || data.error)) || `Supabase error ${res.status}`;
    throw new SupabaseError(res.status, String(msg), data);
  }
  return data;
}

const authUrl = (p) => `${config.supabaseUrl}/auth/v1${p}`;
const anon = () => ({ apikey: config.anonKey });
const asUser = (t) => ({ apikey: config.anonKey, Authorization: `Bearer ${t}` });
const asService = () => ({ apikey: config.serviceKey, Authorization: `Bearer ${config.serviceKey}` });

export const auth = {
  signIn: (email, password) => call(authUrl('/token?grant_type=password'), { method: 'POST', headers: anon(), body: { email, password } }),
  refresh: (refreshToken) => call(authUrl('/token?grant_type=refresh_token'), { method: 'POST', headers: anon(), body: { refresh_token: refreshToken } }),
  getUser: (token) => call(authUrl('/user'), { headers: asUser(token) }),
  updateUser: (token, attrs) => call(authUrl('/user'), { method: 'PUT', headers: asUser(token), body: attrs }),
  logout: (token) => call(authUrl('/logout'), { method: 'POST', headers: asUser(token) }),
  recover: (email, redirectTo) => call(authUrl(`/recover?redirect_to=${encodeURIComponent(redirectTo)}`), { method: 'POST', headers: anon(), body: { email } }),
  invite: (email, data, redirectTo) => call(authUrl(`/invite?redirect_to=${encodeURIComponent(redirectTo)}`), { method: 'POST', headers: asService(), body: { email, data } }),
};

// db(token) runs as that signed-in user, so row-level security applies.
// db('service') bypasses it and is only used by trusted server jobs (webhook, cron).
export function db(token) {
  const headers = token === 'service' ? asService() : asUser(token);
  const base = `${config.supabaseUrl}/rest/v1`;
  return {
    select: (table, query = '') => call(`${base}/${table}?${query}`, { headers }),
    insert: (table, row) => call(`${base}/${table}`, { method: 'POST', headers: { ...headers, Prefer: 'return=representation' }, body: row }),
    update: (table, query, patch) => call(`${base}/${table}?${query}`, { method: 'PATCH', headers: { ...headers, Prefer: 'return=representation' }, body: patch }),
    rpc: (fn, args = {}) => call(`${base}/rpc/${fn}`, { method: 'POST', headers, body: args }),
  };
}

// Build a PostgREST query string. Values are URL-encoded.
export function qs(params) {
  return Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
