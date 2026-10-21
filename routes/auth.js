// Log in, log out, invite / reset links and setting a password.
import { config } from '../lib/config.js';
import { auth } from '../lib/supabase.js';
import { esc, notice, publicPage } from '../lib/html.js';
import { redirect, sendHtml, sendJson, safeNext } from '../lib/http.js';
import { clearSession, loadUser, setSession } from '../lib/session.js';
import { clientIp, limited } from '../lib/ratelimit.js';

const LOGIN_ERRORS = {
  invalid: 'That email and password don’t match. Try again, or reset your password.',
  limited: 'Too many attempts. Please wait 10 minutes and try again.',
  expired: 'Your session ended. Please log in again.',
  origin: 'For your security, please log in from this page.',
  unconfirmed: 'Please finish setting up your account using the link in your welcome email.',
  link: 'That link has expired or was already used. Request a new one below.',
  error: 'Something went wrong on our side. Please try again in a minute.',
};

// Which site sent this request (from the Origin header, or the Referer as a fallback).
export function requestOrigin(req) {
  if (req.headers.origin && req.headers.origin !== 'null') return req.headers.origin;
  try { return new URL(req.headers.referer).origin; } catch { return null; }
}

export const isSameOrigin = (req) => requestOrigin(req) === config.appOrigin;

function loginView({ error, email = '', next = '', info = '' }) {
  return publicPage({
    title: 'Log in',
    body: `<section class="authcard">
      <h1>Log in to your dashboard</h1>
      <p class="sub">See your reviews, approve replies, and read your guidelines and monthly reports.</p>
      ${notice('error', LOGIN_ERRORS[error] || '')}${notice('ok', info)}
      <form method="post" action="/auth/login" class="stack">
        <input type="hidden" name="next" value="${esc(next)}">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="username" required value="${esc(email)}">
        <div class="row between"><label for="password">Password</label><a class="linkish" href="/forgot-password">Forgot password?</a></div>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
        <button class="btn primary wide" type="submit">Log in</button>
      </form>
      <p class="fine">New to First Response? <a href="${esc(config.marketingSite)}/start-free-trial">Start your free trial</a></p>
    </section>`,
  });
}

export async function getLogin(req, res, { query }) {
  const user = await loadUser(req, res);
  if (user && !query.error) return redirect(res, safeNext(query.next, '/'));
  sendHtml(res, 200, loginView({ error: query.error, email: query.email, next: query.next, info: query.reset === 'sent' ? 'If that email has an account, a reset link is on its way.' : query.done === 'password' ? 'Your password is updated. Log in with it now.' : '' }));
}

// The login form on this app and the one on the Webflow site both post here.
export async function postLogin(req, res, { body }) {
  const origin = requestOrigin(req);
  const back = (code, email = '') => redirect(res, `/login?error=${code}${email ? `&email=${encodeURIComponent(email)}` : ''}`);
  if (!origin || !config.allowedLoginOrigins.includes(origin)) return back('origin');
  const email = String(body.email || '').trim().toLowerCase().slice(0, 200);
  const password = String(body.password || '').slice(0, 200);
  if (!email || !password) return back('invalid', email);
  if (limited(`login:${clientIp(req)}`, 10) || limited(`login:${email}`, 10)) return back('limited', email);
  try {
    const session = await auth.signIn(email, password);
    setSession(res, session);
    return redirect(res, safeNext(body.next, '/'));
  } catch (e) {
    if (e.status === 400 && /confirm/i.test(e.message)) return back('unconfirmed', email);
    if (e.status === 400 || e.status === 401 || e.status === 422) return back('invalid', email);
    if (e.status === 429) return back('limited', email);
    console.error('[login] supabase error', e.status, e.message);
    return back('error', email);
  }
}

export async function postLogout(req, res) {
  if (!isSameOrigin(req)) return redirect(res, '/');
  const user = await loadUser(req, res).catch(() => null);
  if (user) await auth.logout(user.token).catch(() => {});
  clearSession(res);
  redirect(res, `${config.marketingSite}/login`);
}

export function getForgot(req, res, { query }) {
  sendHtml(res, 200, publicPage({
    title: 'Reset your password',
    body: `<section class="authcard">
      <h1>Reset your password</h1>
      <p class="sub">Enter the email you use for First Response and we’ll send you a link to set a new password.</p>
      ${notice('error', LOGIN_ERRORS[query.error] || '')}
      <form method="post" action="/forgot-password" class="stack">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="email" required value="${esc(query.email || '')}">
        <button class="btn primary wide" type="submit">Send reset link</button>
      </form>
      <p class="fine"><a href="/login">Back to log in</a></p>
    </section>`,
  }));
}

export async function postForgot(req, res, { body }) {
  if (!isSameOrigin(req)) return redirect(res, '/forgot-password?error=origin');
  const email = String(body.email || '').trim().toLowerCase().slice(0, 200);
  if (limited(`reset:${clientIp(req)}`, 5)) return redirect(res, '/forgot-password?error=limited');
  if (email) {
    // Always show the same message so nobody can probe which emails have accounts.
    await auth.recover(email, `${config.appUrl}/auth/callback`).catch((e) => console.error('[reset]', e.status, e.message));
  }
  redirect(res, '/login?reset=sent');
}

// Invite and reset emails land here with the session in the URL fragment,
// which only the browser can read; /static/js/callback.js hands it to /auth/session.
export function getCallback(req, res) {
  sendHtml(res, 200, publicPage({
    title: 'Signing you in',
    body: `<section class="authcard" id="callback">
      <h1>Signing you in…</h1>
      <p class="sub" id="callback-msg">One moment.</p>
      <noscript><p class="notice error">Please turn on JavaScript to finish signing in.</p></noscript>
    </section>
    <script src="/static/js/callback.js" type="module"></script>`,
  }));
}

export async function postSession(req, res, { body }) {
  if (!isSameOrigin(req)) return sendJson(res, 403, { error: 'origin' });
  const accessToken = String(body.access_token || '');
  const refreshToken = String(body.refresh_token || '');
  if (!accessToken || !refreshToken) return sendJson(res, 400, { error: 'missing tokens' });
  try {
    await auth.getUser(accessToken);
  } catch {
    return sendJson(res, 401, { error: 'invalid' });
  }
  setSession(res, { access_token: accessToken, refresh_token: refreshToken, expires_in: Math.min(Number(body.expires_in) || 3600, 3600) });
  const type = String(body.type || '');
  sendJson(res, 200, { next: type === 'invite' || type === 'recovery' ? '/set-password' : '/' });
}

function setPasswordView({ error = '', email = '' }) {
  return publicPage({
    title: 'Set your password',
    body: `<section class="authcard">
      <h1>Set your password</h1>
      <p class="sub">You’ll use this with <strong>${esc(email)}</strong> to log in.</p>
      ${notice('error', error)}
      <form method="post" action="/set-password" class="stack">
        <label for="password">New password</label>
        <input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required>
        <span class="hint">At least 8 characters.</span>
        <label for="confirm">Type it again</label>
        <input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="8" required>
        <button class="btn primary wide" type="submit">Save password</button>
      </form>
    </section>`,
  });
}

export async function getSetPassword(req, res) {
  const user = await loadUser(req, res);
  if (!user) return redirect(res, '/login?error=link');
  sendHtml(res, 200, setPasswordView({ email: user.email }));
}

export async function postSetPassword(req, res, { body }) {
  if (!isSameOrigin(req)) return redirect(res, '/set-password');
  const user = await loadUser(req, res);
  if (!user) return redirect(res, '/login?error=link');
  const password = String(body.password || '');
  if (password.length < 8) return sendHtml(res, 400, setPasswordView({ email: user.email, error: 'Use at least 8 characters.' }));
  if (password !== String(body.confirm || '')) return sendHtml(res, 400, setPasswordView({ email: user.email, error: 'Those passwords don’t match.' }));
  try {
    await auth.updateUser(user.token, { password });
  } catch (e) {
    return sendHtml(res, 400, setPasswordView({ email: user.email, error: e.status === 422 ? 'Pick a stronger password (mix letters and numbers, avoid common words).' : 'We couldn’t save that password. Please try again.' }));
  }
  redirect(res, '/');
}
