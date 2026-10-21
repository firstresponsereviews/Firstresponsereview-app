// Starts the stand-in Supabase and the real app server side by side for tests.
import http from 'node:http';
import crypto from 'node:crypto';
import { createMock, ANON, SERVICE } from './mock-supabase.js';

export const WEBFLOW = 'https://first-response-reviews.webflow.io';
export const WEBHOOK_SECRET = 'whsec_test_123';
export const CRON = 'cron_test_456_long_enough_secret';
export const URL_KEY = 'urlkey_test_0123456789abcdefghij';

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

export async function startStack() {
  const mock = createMock();
  const mockPort = await listen(mock.server);
  let handler = (req, res) => { res.statusCode = 503; res.end(); };
  const app = http.createServer((req, res) => handler(req, res));
  const appPort = await listen(app);
  const appUrl = `http://127.0.0.1:${appPort}`;
  Object.assign(process.env, {
    APP_URL: appUrl,
    SUPABASE_URL: `http://127.0.0.1:${mockPort}`,
    SUPABASE_ANON_KEY: ANON,
    SUPABASE_SERVICE_ROLE_KEY: SERVICE,
    WEBFLOW_SITE_URL: WEBFLOW,
    WEBFLOW_WEBHOOK_SECRET: WEBHOOK_SECRET,
    CRON_SECRET: CRON,
    WEBFLOW_WEBHOOK_KEY: URL_KEY,
    RESEND_API_KEY: '',
    TEAM_EMAIL: 'team@example.com',
    ANTHROPIC_API_KEY: '',
  });
  const { handle } = await import('../server.js');
  handler = handle;
  const stop = () => Promise.all([new Promise((r) => mock.server.close(r)), new Promise((r) => app.close(r))]);
  return { mock, appUrl, stop };
}

// A tiny browser: keeps cookies, doesn't follow redirects.
export function browser(appUrl) {
  const jar = new Map();
  const store = (res) => {
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1);
      const maxAge = attrs.find((a) => /max-age/i.test(a));
      if (maxAge && Number(maxAge.split('=')[1]) <= 0) jar.delete(name);
      else jar.set(name, value);
    }
  };
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  async function req(method, path, { form, json, origin = appUrl, headers = {} } = {}) {
    const h = { ...headers };
    if (jar.size) h.cookie = cookieHeader();
    let body;
    if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    if (json) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
    if (method !== 'GET' && origin) h.origin = origin;
    const res = await fetch(appUrl + path, { method, headers: h, body, redirect: 'manual' });
    store(res);
    const text = await res.text();
    return { status: res.status, location: res.headers.get('location'), text, headers: res.headers };
  }
  return { jar, get: (p, o) => req('GET', p, o), post: (p, o) => req('POST', p, o) };
}

export function signWebflow(body, ts = Date.now()) {
  const raw = JSON.stringify(body);
  const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${ts}:${raw}`).digest('hex');
  return { raw, headers: { 'content-type': 'application/json', 'x-webflow-timestamp': String(ts), 'x-webflow-signature': sig } };
}

// Answers a client would give in the onboarding questionnaire.
export const ANSWERS = {
  business_name: 'Casa Luna Taquería', industry: 'Restaurant or café', city: 'North Park, San Diego', locations: '1',
  platforms: ['Google', 'Yelp'], manager: 'Maria Delgado', role: 'Owner', phone: '(619) 555-0142', contact_email: 'hola@casaluna.example',
  callback: 'the same day', method: 'call', offers: ['free', 'refund'], pct: '', refund: '50', decide: 'manager',
  formality: '2', length: '3', words: ['warm', 'neighborly', 'playful'], sign: 'Maria, Owner', emoji: 'five',
  love: 'family recipes, see you soon', never: 'sorry you feel that way, cheap', r5: 'auto', r4: 'auto', r3: 'ask', r12: 'ask',
  escalate: ['Illness, injury or food safety', 'Legal threats', 'Discrimination', 'Refund requests'], thankStaff: 'on', starOnly: 'on',
};

export function formOf(obj) {
  const p = [];
  for (const [k, v] of Object.entries(obj)) for (const x of [].concat(v)) p.push([k, x]);
  return p;
}
