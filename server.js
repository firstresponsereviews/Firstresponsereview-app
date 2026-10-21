// First Response dashboard. Plain Node.js server, no dependencies.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, missingConfig } from './lib/config.js';
import { HttpError, SECURITY_HEADERS, parseBody, readBody, redirect, sendHtml, sendJson } from './lib/http.js';
import { SupabaseError } from './lib/supabase.js';
import { esc, publicPage } from './lib/html.js';
import * as A from './routes/auth.js';
import * as P from './routes/app.js';
import * as T from './routes/team.js';
import * as W from './routes/webhooks.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');

const routes = [
  ['GET', '/healthz', (req, res) => sendJson(res, 200, { ok: true })],
  ['GET', '/login', A.getLogin],
  ['POST', '/auth/login', A.postLogin],
  ['POST', '/auth/logout', A.postLogout],
  ['GET', '/forgot-password', A.getForgot],
  ['POST', '/forgot-password', A.postForgot],
  ['GET', '/auth/callback', A.getCallback],
  ['POST', '/auth/session', A.postSession],
  ['GET', '/set-password', A.getSetPassword],
  ['POST', '/set-password', A.postSetPassword],
  ['GET', '/', P.getHome],
  ['POST', '/switch-business', P.postSwitchBusiness],
  ['GET', '/onboarding', P.getOnboarding],
  ['POST', '/onboarding', P.postOnboarding],
  ['GET', '/inbox', P.getInbox],
  ['POST', '/inbox/:id', P.postReply],
  ['GET', '/guidelines', P.getGuidelines],
  ['GET', '/reports', P.getReports],
  ['GET', '/reports/:id', P.getReports],
  ['GET', '/team', T.getTeam],
  ['POST', '/team/reports/generate', T.postGenerateAll],
  ['GET', '/team/b/:id', T.getTeamBusiness],
  ['POST', '/team/b/:id/approve-guidelines', T.postApproveGuidelines],
  ['POST', '/team/b/:id/invite', T.postInvite],
  ['POST', '/team/b/:id/reviews', T.postAddReview],
  ['POST', '/team/b/:id/reports/generate', T.postGenerateOne],
  ['POST', '/team/reviews/:id/posted', T.postMarkPosted],
  ['GET', '/team/reports/:id', T.getReportEditor],
  ['POST', '/team/reports/:id', T.postReport],
  ['POST', '/api/webflow/form', W.postWebflowForm, { raw: true }],
  ['POST', '/api/cron/monthly-reports', W.postMonthlyReports, { raw: true }],
].map(([method, pattern, handler, opts = {}]) => {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
  return { method, re, keys, handler, opts };
});

const TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

async function serveStatic(req, res, pathname) {
  const rel = decodeURIComponent(pathname.slice('/static/'.length));
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) throw new HttpError(404, 'Not found.');
  let data;
  try { data = await fs.readFile(file); } catch { throw new HttpError(404, 'Not found.'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=3600', ...SECURITY_HEADERS });
  res.end(req.method === 'HEAD' ? undefined : data);
}

function errorPage(res, status, message) {
  if (res.headersSent) return res.end();
  sendHtml(res, status, publicPage({
    title: status === 404 ? 'Page not found' : 'Something went wrong',
    body: `<section class="authcard"><h1>${status === 404 ? 'Page not found' : 'Something went wrong'}</h1><p class="sub">${esc(message)}</p><p><a class="btn primary" href="/">Go to your dashboard</a></p></section>`,
  }));
}

export async function handle(req, res) {
  const url = new URL(req.url, config.appUrl);
  const { pathname } = url;
  try {
    if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith('/static/')) return await serveStatic(req, res, pathname);
    if (pathname === '/favicon.ico') return redirect(res, '/static/favicon.png', 301);
    const route = routes.find((r) => r.method === req.method && r.re.test(pathname));
    if (!route) {
      const exists = routes.some((r) => r.re.test(pathname));
      throw new HttpError(exists ? 405 : 404, exists ? 'That action isn’t allowed here.' : 'We couldn’t find that page.');
    }
    const m = pathname.match(route.re);
    const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    const query = Object.fromEntries(url.searchParams);
    let body = {};
    let rawBody = '';
    if (req.method === 'POST') {
      const buf = await readBody(req);
      rawBody = buf.toString('utf8');
      if (!route.opts.raw) body = parseBody(buf, req.headers['content-type'] || '');
    }
    await route.handler(req, res, { params, query, body, rawBody });
  } catch (e) {
    if (e instanceof HttpError) return errorPage(res, e.status, e.message);
    if (e instanceof SupabaseError && (e.status === 401 || e.status === 403)) {
      if (pathname.startsWith('/api/')) return sendJson(res, e.status, { error: 'unauthorized' });
      return redirect(res, '/login?error=expired');
    }
    console.error('[error]', req.method, pathname, e);
    if (pathname.startsWith('/api/')) return sendJson(res, 500, { error: 'server error' });
    return errorPage(res, 500, 'Please try again in a minute. If it keeps happening, contact us.');
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const missing = missingConfig();
  if (missing.length) {
    console.error(`Missing settings: ${missing.join(', ')}. Copy .env.example and fill them in.`);
    process.exit(1);
  }
  http.createServer(handle).listen(config.port, () => console.log(`First Response dashboard on ${config.appUrl} (port ${config.port})`));
}
