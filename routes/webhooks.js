// Webflow form webhook (free trial signups and contact messages) and the monthly report job.
import crypto from 'node:crypto';
import { config } from '../lib/config.js';
import { auth, db, qs } from '../lib/supabase.js';
import { sendJson } from '../lib/http.js';
import { emailShell, fieldsTable, sendEmail } from '../lib/email.js';
import { esc } from '../lib/html.js';
import { generateDrafts } from './team.js';
import { monthLabel, previousMonth } from '../lib/reports.js';

// Webflow signs webhooks: HMAC-SHA256 of "<timestamp>:<raw body>", hex, in x-webflow-signature.
export function verifyWebflowSignature(rawBody, headers, secret, now = Date.now()) {
  const ts = String(headers['x-webflow-timestamp'] || '');
  const sig = String(headers['x-webflow-signature'] || '');
  if (!secret || !ts || !sig) return false;
  const tsMs = Number(ts) < 1e12 ? Number(ts) * 1000 : Number(ts);
  if (!Number.isFinite(tsMs) || Math.abs(now - tsMs) > 5 * 60 * 1000) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${ts}:${rawBody}`).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(sig, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const field = (data, ...names) => {
  for (const n of names) {
    const hit = Object.keys(data).find((k) => k.toLowerCase() === n.toLowerCase());
    if (hit && String(data[hit]).trim()) return String(data[hit]).trim().slice(0, 300);
  }
  return '';
};

async function handleTrial(data) {
  const email = field(data, 'Email').toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) return { ok: false, reason: 'missing email' };
  const name = field(data, 'Name');
  const business = {
    name: field(data, 'Business') || `${name || email}'s business`,
    city: field(data, 'City'),
    phone: field(data, 'Phone'),
    locations: field(data, 'Locations'),
    plan: field(data, 'Plan'),
    review_sites: field(data, 'Review sites', 'Review Sites'),
    owner_email: email,
    status: 'onboarding',
  };
  let user = null;
  let note = '';
  try {
    user = await auth.invite(email, { full_name: name }, `${config.appUrl}/auth/callback`);
  } catch (e) {
    note = e.status === 422 ? 'This email already has an account, so no new account was created. Add them to the business by hand if needed.' : `Account invite failed (${e.status}: ${e.message}).`;
    console.error('[trial] invite failed', e.status, e.message);
  }
  const d = db('service');
  const [row] = await d.insert('businesses', business);
  if (user && user.id) await d.insert('memberships', { user_id: user.id, business_id: row.id, role: 'owner' });
  if (config.teamEmail) {
    await sendEmail({
      to: config.teamEmail,
      replyTo: email,
      subject: `New free trial: ${business.name}`,
      html: emailShell(`New free trial: ${business.name}`, `${fieldsTable({ Name: name, Email: email, Business: business.name, City: business.city, Phone: business.phone, Locations: business.locations, Plan: business.plan, 'Review sites': business.review_sites })}
        <p>${user ? 'We emailed them a link to set their password and fill in the questionnaire.' : esc(note)}</p>
        <p><a href="${esc(config.appUrl)}/team/b/${esc(row.id)}">Open in the team console</a></p>`),
    });
  }
  return { ok: true, business_id: row.id, invited: Boolean(user) };
}

async function handleContact(data, formName) {
  if (!config.teamEmail) return { ok: true, forwarded: false };
  const email = field(data, 'Email');
  const r = await sendEmail({
    to: config.teamEmail,
    replyTo: /^\S+@\S+\.\S+$/.test(email) ? email : undefined,
    subject: `New website message from ${field(data, 'Name') || email || 'a visitor'}`,
    html: emailShell(`New message from the ${formName} form`, fieldsTable(data)),
  });
  return { ok: true, forwarded: r.sent };
}

// Constant-time comparison of two secrets.
export function sameSecret(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected || ''));
  return b.length >= 24 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function postWebflowForm(req, res, { rawBody, query }) {
  const trusted = verifyWebflowSignature(rawBody, req.headers, config.webflowSecret) || sameSecret(query.key, config.webflowUrlKey);
  if (!trusted) return sendJson(res, 401, { error: 'bad signature' });
  let event;
  try { event = JSON.parse(rawBody); } catch { return sendJson(res, 400, { error: 'bad json' }); }
  const p = event && (event.payload || event);
  const formName = String((p && p.name) || '');
  const data = (p && p.data) || {};
  if (event.triggerType && event.triggerType !== 'form_submission') return sendJson(res, 200, { ignored: true });
  if (/free trial/i.test(formName)) return sendJson(res, 200, await handleTrial(data));
  return sendJson(res, 200, await handleContact(data, formName || 'website'));
}

// Run on the 1st of each month (e.g. a Render cron job): creates report drafts and tells the team.
export async function postMonthlyReports(req, res) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!sameSecret(token, config.cronSecret)) {
    return sendJson(res, 401, { error: 'unauthorized' });
  }
  const d = db('service');
  const period = previousMonth();
  const active = await d.select('businesses', qs({ status: 'eq.active', select: '*' }));
  const created = await generateDrafts(d, active, period);
  if (created.length && config.teamEmail) {
    await sendEmail({
      to: config.teamEmail,
      subject: `${created.length} ${monthLabel(period.start)} report${created.length === 1 ? '' : 's'} ready for review`,
      html: emailShell(`${monthLabel(period.start)} reports are ready`, `<p>These drafts are waiting for your edits and approval. Clients won’t see them until you approve.</p><ul>${created.map((c) => `<li><a href="${esc(config.appUrl)}/team/reports/${esc(c.report.id)}">${esc(c.business.name)}</a></li>`).join('')}</ul>`),
    });
  }
  sendJson(res, 200, { period, created: created.length });
}
