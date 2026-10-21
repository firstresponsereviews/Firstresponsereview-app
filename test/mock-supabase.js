// A small stand-in for Supabase used only by the tests: Auth endpoints, the REST API
// filters the app uses, the three client functions, and row-level security rules
// that mirror supabase/schema.sql.
import http from 'node:http';
import crypto from 'node:crypto';

export const ANON = 'test-anon-key';
export const SERVICE = 'test-service-key';

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const uuid = () => crypto.randomUUID();

export function createMock() {
  const state = {
    users: [], // {id,email,password,user_metadata}
    access: new Map(), // token -> userId
    refresh: new Map(),
    invites: [],
    recovers: [],
    tables: { profiles: [], businesses: [], memberships: [], reviews: [], reports: [] },
  };

  const issue = (userId, ttl = 3600) => {
    const token = `${b64({ alg: 'HS256' })}.${b64({ sub: userId, exp: Math.floor(Date.now() / 1000) + ttl })}.${crypto.randomBytes(8).toString('hex')}`;
    const rt = crypto.randomBytes(16).toString('hex');
    state.access.set(token, userId);
    state.refresh.set(rt, userId);
    return { access_token: token, refresh_token: rt, expires_in: ttl, token_type: 'bearer', user: publicUser(userId) };
  };
  const publicUser = (id) => { const u = state.users.find((x) => x.id === id); return { id: u.id, email: u.email, user_metadata: u.user_metadata || {} }; };

  function addUser(email, password, meta = {}, role = 'client') {
    const u = { id: uuid(), email, password, user_metadata: meta };
    state.users.push(u);
    state.tables.profiles.push({ id: u.id, full_name: meta.full_name || null, role, created_at: new Date().toISOString() });
    return u;
  }

  // Row-level security, mirroring the SQL policies.
  const role = (uid) => (state.tables.profiles.find((p) => p.id === uid) || {}).role;
  const isStaff = (uid) => role(uid) === 'staff';
  const isMember = (uid, bid) => state.tables.memberships.some((m) => m.user_id === uid && m.business_id === bid);
  const canRead = {
    profiles: (uid, r) => r.id === uid || isStaff(uid),
    businesses: (uid, r) => isMember(uid, r.id) || isStaff(uid),
    memberships: (uid, r) => r.user_id === uid || isStaff(uid),
    reviews: (uid, r) => isMember(uid, r.business_id) || isStaff(uid),
    reports: (uid, r) => (isMember(uid, r.business_id) && r.status === 'sent') || isStaff(uid),
  };
  const canWrite = { businesses: isStaff, reviews: isStaff, reports: isStaff, profiles: () => false, memberships: () => false };

  function match(row, col, expr) {
    const i = expr.indexOf('.');
    const op = expr.slice(0, i);
    const val = expr.slice(i + 1);
    const v = row[col];
    if (op === 'eq') return String(v) === val;
    if (op === 'in') return val.replace(/^\(|\)$/g, '').split(',').includes(String(v));
    if (op === 'gte') return new Date(v) >= new Date(val);
    if (op === 'lte') return new Date(v) <= new Date(val);
    throw new Error(`unsupported op ${op}`);
  }

  function applyFilters(rows, params) {
    let out = rows;
    for (const [k, v] of params) {
      if (['select', 'order', 'limit'].includes(k)) continue;
      if (k === 'and') {
        const parts = v.replace(/^\(|\)$/g, '').split(',');
        for (const p of parts) { const j = p.indexOf('.'); out = out.filter((r) => match(r, p.slice(0, j), p.slice(j + 1))); }
      } else out = out.filter((r) => match(r, k, v));
    }
    const order = params.get('order');
    if (order) {
      const [col, dir] = order.split('.');
      out = [...out].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (dir === 'desc' ? -1 : 1));
    }
    const limit = Number(params.get('limit'));
    if (limit) out = out.slice(0, limit);
    return out;
  }

  const defaults = {
    businesses: () => ({ id: uuid(), status: 'onboarding', guidelines: null, guidelines_submitted_at: null, guidelines_approved_at: null, created_at: new Date().toISOString() }),
    reviews: () => ({ id: uuid(), status: 'new', flag: null, reply: null, replied_at: null, replied_by: null, posted_at: new Date().toISOString(), created_at: new Date().toISOString() }),
    reports: () => ({ id: uuid(), status: 'draft', approved_by: null, sent_at: null, created_at: new Date().toISOString() }),
    memberships: () => ({ role: 'owner', created_at: new Date().toISOString() }),
    profiles: () => ({}),
  };

  const rpc = {
    submit_guidelines(uid, { bid, g }) {
      if (!(isMember(uid, bid) || isStaff(uid))) return [403, { message: 'not allowed' }];
      const b = state.tables.businesses.find((x) => x.id === bid);
      Object.assign(b, { guidelines: g, guidelines_submitted_at: new Date().toISOString(), guidelines_approved_at: null, name: (g.business && g.business.name) || b.name, status: b.status === 'onboarding' ? 'in_review' : b.status });
      return [200, null];
    },
    approve_reply(uid, { rid, reply_text }) { return reply(uid, rid, reply_text, 'approved'); },
    mark_reply_posted(uid, { rid, reply_text }) { return reply(uid, rid, reply_text, 'posted'); },
    link_business_owner(uid, { bid }) {
      if (!isStaff(uid)) return [403, { message: 'not allowed' }];
      const b = state.tables.businesses.find((x) => x.id === bid);
      const u = b && state.users.find((x) => x.email === String(b.owner_email || '').toLowerCase());
      if (!u) return [200, false];
      if (!state.tables.memberships.some((m) => m.user_id === u.id && m.business_id === bid)) state.tables.memberships.push({ user_id: u.id, business_id: bid, role: 'owner', created_at: new Date().toISOString() });
      return [200, true];
    },
  };
  function reply(uid, rid, text, status) {
    const r = state.tables.reviews.find((x) => x.id === rid);
    if (!r || !(isMember(uid, r.business_id) || isStaff(uid))) return [403, { message: 'not allowed' }];
    if (!String(text || '').trim()) return [400, { message: 'reply must be 1 to 4000 characters' }];
    if (status === 'approved' && r.status === 'posted') return [200, null];
    Object.assign(r, { reply: text, status, replied_at: r.replied_at || new Date().toISOString(), replied_by: uid });
    return [200, null];
  }

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : {};
    const url = new URL(req.url, 'http://mock');
    const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(obj == null ? '' : JSON.stringify(obj)); };
    const apikey = req.headers.apikey;
    if (apikey !== ANON && apikey !== SERVICE) return send(401, { message: 'No API key found in request' });
    const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const service = bearer === SERVICE;
    const uid = state.access.get(bearer);
    const p = url.pathname;

    // Auth
    if (p === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
      const u = state.users.find((x) => x.email === String(body.email).toLowerCase() && x.password && x.password === body.password);
      return u ? send(200, issue(u.id)) : send(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
    }
    if (p === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
      const id = state.refresh.get(body.refresh_token);
      if (!id) return send(400, { error_description: 'Invalid Refresh Token' });
      state.refresh.delete(body.refresh_token);
      return send(200, issue(id));
    }
    if (p === '/auth/v1/user' && req.method === 'GET') return uid ? send(200, publicUser(uid)) : send(401, { message: 'invalid JWT' });
    if (p === '/auth/v1/user' && req.method === 'PUT') {
      if (!uid) return send(401, { message: 'invalid JWT' });
      const u = state.users.find((x) => x.id === uid);
      if (body.password) u.password = body.password;
      return send(200, publicUser(uid));
    }
    if (p === '/auth/v1/logout') { state.access.delete(bearer); return send(204, null); }
    if (p === '/auth/v1/recover') { state.recovers.push({ email: body.email, redirect_to: url.searchParams.get('redirect_to') }); return send(200, {}); }
    if (p === '/auth/v1/invite') {
      if (!service) return send(403, { message: 'User not allowed' });
      if (state.failInvite) return send(state.failInvite, { msg: 'email rate limit exceeded' });
      if (state.users.some((x) => x.email === body.email)) return send(422, { msg: 'A user with this email address has already been registered' });
      const u = addUser(body.email, null, body.data || {});
      state.invites.push({ email: body.email, redirect_to: url.searchParams.get('redirect_to') });
      return send(200, publicUser(u.id));
    }

    // REST
    const rpcMatch = p.match(/^\/rest\/v1\/rpc\/(\w+)$/);
    if (rpcMatch) {
      if (!uid && !service) return send(401, { message: 'JWT required' });
      const fn = rpc[rpcMatch[1]];
      if (!fn) return send(404, { message: 'no function' });
      const [status, out] = fn(service ? '__service__' : uid, body);
      return send(status === 200 ? 200 : status, out);
    }
    const t = p.match(/^\/rest\/v1\/(\w+)$/);
    if (t && state.tables[t[1]]) {
      const name = t[1];
      if (!uid && !service) return send(401, { message: 'JWT required' });
      const visible = service ? state.tables[name] : state.tables[name].filter((r) => canRead[name](uid, r));
      if (req.method === 'GET') return send(200, applyFilters(visible, url.searchParams));
      if (req.method === 'POST') {
        if (!service && !canWrite[name](uid)) return send(403, { message: 'new row violates row-level security policy' });
        const rows = [].concat(body).map((r) => ({ ...defaults[name](), ...r }));
        if (name === 'reports' && rows.some((r) => state.tables.reports.some((x) => x.business_id === r.business_id && x.period_start === r.period_start))) return send(409, { message: 'duplicate key' });
        state.tables[name].push(...rows);
        return send(201, rows);
      }
      if (req.method === 'PATCH') {
        if (!service && !canWrite[name](uid)) return send(200, []);
        const rows = applyFilters(visible, url.searchParams);
        rows.forEach((r) => Object.assign(r, body));
        return send(200, rows);
      }
    }
    send(404, { message: `mock: no route ${req.method} ${p}` });
  });

  return { server, state, addUser, issue };
}
