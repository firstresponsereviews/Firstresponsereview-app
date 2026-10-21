// Free-trial signup: the person creates their login right away and goes straight to the questionnaire.
// The Webflow "Free Trial" form posts here (step 1: business details), then they pick a password (step 2).
import { config } from '../lib/config.js';
import { auth, db } from '../lib/supabase.js';
import { esc, notice, publicPage } from '../lib/html.js';
import { redirect, sendHtml } from '../lib/http.js';
import { setBusinessCookie, setSession, loadUser } from '../lib/session.js';
import { clientIp, limited } from '../lib/ratelimit.js';
import { emailShell, fieldsTable, sendEmail } from '../lib/email.js';
import { requestOrigin } from './auth.js';

const LOCATIONS = ['1', '2–4', '5–9', '10+'];
const PLANS = ['Starter', 'Pro', 'Concierge', 'Not sure yet'];
const SITES = ['Google', 'Yelp', 'Trustpilot', 'G2'];

const ERRORS = {
  email: 'Please enter a valid email address.',
  business: 'Please enter your business name.',
  password: 'Choose a password with at least 8 characters.',
  match: 'Those passwords don’t match.',
  exists: 'That email already has an account. Log in instead, or reset your password if you’ve forgotten it.',
  limited: 'Too many signups from this connection. Please wait 10 minutes and try again.',
  origin: 'For your security, please start from our website.',
  error: 'Something went wrong on our side. Please try again in a minute.',
};

// Accepts Webflow's field names ("Review sites", "Review-sites") and ours ("review_sites").
function pick(body, ...names) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const want = names.map(norm);
  for (const k of Object.keys(body)) {
    if (want.includes(norm(k))) {
      const v = body[k];
      return (Array.isArray(v) ? v.filter(Boolean).join(', ') : String(v || '')).trim().slice(0, 300);
    }
  }
  return '';
}

export function detailsFrom(body) {
  return {
    name: pick(body, 'name', 'full_name'),
    email: pick(body, 'email').toLowerCase(),
    business: pick(body, 'business', 'business_name'),
    city: pick(body, 'city'),
    phone: pick(body, 'phone'),
    locations: pick(body, 'locations'),
    plan: pick(body, 'plan'),
    review_sites: pick(body, 'review sites', 'review_sites', 'sites'),
  };
}

const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

function hidden(d) {
  return Object.entries(d).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
}

function select(name, options, value) {
  return `<select id="${name}" name="${name}">${options.map((o) => `<option${o === value ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
}

const passwordFields = `
  <label for="password">Create a password</label>
  <input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required>
  <p class="fine">At least 8 characters.</p>
  <label for="password2">Confirm password</label>
  <input id="password2" name="password2" type="password" autocomplete="new-password" minlength="8" required>`;

const loginLink = `<p class="fine">Already have an account? <a href="/login">Log in</a></p>`;

// Step 2 only: details came from the website form, now pick a password.
function passwordView(d, error) {
  return publicPage({
    title: 'Create your login',
    body: `<section class="authcard">
      <p class="eyebrow">Step 2 of 3 · Free trial</p>
      <h1>Create your login</h1>
      <p class="sub">Thanks${d.name ? `, ${esc(d.name.split(' ')[0])}` : ''}! Choose a password for <strong>${esc(d.email)}</strong>. Next you’ll answer a few questions so we can reply in ${esc(d.business || 'your business')}’s voice.</p>
      ${notice('error', ERRORS[error] || '')}
      <form method="post" action="/signup" class="stack">
        <input type="hidden" name="step" value="password">
        ${hidden(d)}
        ${passwordFields}
        <button class="btn primary wide" type="submit">Create login and continue</button>
      </form>
      ${loginLink}
    </section>`,
  });
}

// Everything on one page (when someone lands on /signup directly).
function fullView(d, error) {
  const sites = String(d.review_sites || '').split(/,\s*/);
  return publicPage({
    title: 'Start your free trial',
    body: `<section class="authcard">
      <p class="eyebrow">14-day free trial · No card needed</p>
      <h1>Start your free trial</h1>
      <p class="sub">Create your login, then tell us how you want reviews answered.</p>
      ${notice('error', ERRORS[error] || '')}
      <form method="post" action="/signup" class="stack">
        <label for="name">Your name</label><input id="name" name="name" autocomplete="name" value="${esc(d.name)}">
        <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required value="${esc(d.email)}">
        <label for="business">Business name</label><input id="business" name="business" required value="${esc(d.business)}">
        <label for="city">City</label><input id="city" name="city" value="${esc(d.city)}">
        <label for="phone">Phone</label><input id="phone" name="phone" type="tel" autocomplete="tel" value="${esc(d.phone)}">
        <label for="locations">Locations</label>${select('locations', LOCATIONS, d.locations)}
        <label for="plan">Plan</label>${select('plan', PLANS, d.plan || 'Pro')}
        <fieldset class="checks"><legend>Review sites</legend>${SITES.map((s) => `<label><input type="checkbox" name="review_sites" value="${s}"${sites.includes(s) ? ' checked' : ''}> ${s}</label>`).join('')}</fieldset>
        ${passwordFields}
        <button class="btn primary wide" type="submit">Create my account</button>
      </form>
      ${loginLink}
    </section>`,
  });
}

export async function getSignup(req, res, { query }) {
  const user = await loadUser(req, res).catch(() => null);
  if (user) return redirect(res, '/');
  sendHtml(res, 200, fullView(detailsFrom(query), query.error));
}

async function notifyTeam(d, businessId) {
  if (!config.teamEmail) return;
  await sendEmail({
    to: config.teamEmail,
    replyTo: d.email,
    subject: `New free trial: ${d.business}`,
    html: emailShell(`New free trial: ${d.business}`, `${fieldsTable({ Name: d.name, Email: d.email, Business: d.business, City: d.city, Phone: d.phone, Locations: d.locations, Plan: d.plan, 'Review sites': d.review_sites })}
      <p>They created their login and are filling in the questionnaire now.</p>
      <p><a href="${esc(config.appUrl)}/team/b/${esc(businessId)}">Open in the team console</a></p>`),
  });
}

export async function postSignup(req, res, { body }) {
  const d = detailsFrom(body);
  const password = String(body.password || '');
  const hasPassword = 'password' in body;
  // Coming from the website form: details only, so ask for a password next.
  // This step creates nothing, so it's fine from any page (some browsers hide the sending site).
  if (!hasPassword) {
    if (!validEmail(d.email) || !d.business) return sendHtml(res, 200, fullView(d, !validEmail(d.email) ? 'email' : 'business'));
    return sendHtml(res, 200, passwordView(d));
  }
  const view = (err) => sendHtml(res, 200, body.step === 'password' ? passwordView(d, err) : fullView(d, err));
  // Creating the account only from our own pages or the marketing site.
  const origin = requestOrigin(req);
  if (!origin || !config.allowedLoginOrigins.includes(origin)) return sendHtml(res, 403, fullView(d, 'origin'));
  if (!validEmail(d.email)) return view('email');
  if (!d.business) return view('business');
  if (password.length < 8 || password.length > 200) return view('password');
  if (password !== String(body.password2 || '')) return view('match');
  if (limited(`signup:${clientIp(req)}`, 5)) return view('limited');

  let user;
  try {
    user = await auth.createUser(d.email, password, { full_name: d.name });
  } catch (e) {
    if (e.status === 422 || /already/i.test(e.message)) return view('exists');
    console.error('[signup] create user failed', e.status, e.message);
    return view('error');
  }
  try {
    const svc = db('service');
    const [biz] = await svc.insert('businesses', {
      name: d.business, city: d.city, phone: d.phone, locations: d.locations, plan: d.plan,
      review_sites: d.review_sites, owner_email: d.email, status: 'onboarding',
    });
    await svc.insert('memberships', { user_id: user.id, business_id: biz.id, role: 'owner' });
    const session = await auth.signIn(d.email, password);
    setSession(res, session);
    setBusinessCookie(res, biz.id);
    notifyTeam(d, biz.id).catch((e) => console.error('[signup] team email', e.message));
    return redirect(res, '/onboarding?welcome=1');
  } catch (e) {
    console.error('[signup] setup failed', e.status, e.message);
    return view('error');
  }
}
