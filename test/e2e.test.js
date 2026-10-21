// End-to-end: the real app server talking to the stand-in Supabase.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, browser, signWebflow, WEBFLOW, CRON, URL_KEY, ANSWERS, formOf } from './helpers.js';

let stack;
let client;
let staff;
const S = () => stack.mock.state;

before(async () => {
  stack = await startStack();
  stack.mock.addUser('kaitlyn@beyondsmm.com', 'staff-pass-123', { full_name: 'Kaitlyn' }, 'staff');
});
after(() => stack.stop());

test('signed-out visitors are sent to log in', async () => {
  const b = browser(stack.appUrl);
  const r = await b.get('/inbox');
  assert.equal(r.status, 303);
  assert.equal(r.location, '/login?next=%2Finbox');
  const page = await b.get('/login');
  assert.equal(page.status, 200);
  assert.match(page.text, /Log in to your dashboard/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('webhook rejects unsigned and stale requests', async () => {
  const body = { triggerType: 'form_submission', payload: { name: 'Free Trial', data: { Email: 'x@y.com' } } };
  const unsigned = await fetch(`${stack.appUrl}/api/webflow/form`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(unsigned.status, 401);
  const old = signWebflow(body, Date.now() - 20 * 60 * 1000);
  const stale = await fetch(`${stack.appUrl}/api/webflow/form`, { method: 'POST', headers: old.headers, body: old.raw });
  assert.equal(stale.status, 401);
  assert.equal(S().tables.businesses.length, 0);
});

test('a Webflow free-trial signup creates the business and emails an invite', async () => {
  const body = {
    triggerType: 'form_submission',
    payload: { name: 'Free Trial', siteId: 's1', data: { Name: 'Maria Delgado', Email: 'Maria@CasaLuna.example', Business: 'Casa Luna Taquería', City: 'San Diego, CA', Phone: '(619) 555-0142', Locations: '1', Plan: 'Pro', 'Review sites': 'Google, Yelp' }, submittedAt: new Date().toISOString(), id: 'sub1' },
  };
  const { raw, headers } = signWebflow(body);
  const res = await fetch(`${stack.appUrl}/api/webflow/form`, { method: 'POST', headers, body: raw });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.invited, true);
  const biz = S().tables.businesses[0];
  assert.equal(biz.name, 'Casa Luna Taquería');
  assert.equal(biz.owner_email, 'maria@casaluna.example');
  assert.equal(biz.status, 'onboarding');
  assert.equal(S().invites[0].email, 'maria@casaluna.example');
  assert.equal(S().invites[0].redirect_to, `${stack.appUrl}/auth/callback`);
  const user = S().users.find((u) => u.email === 'maria@casaluna.example');
  assert.ok(S().tables.memberships.some((m) => m.user_id === user.id && m.business_id === biz.id));

  // Webflow retries the same submission: no second account, still answers 200.
  const again = signWebflow(body);
  const r2 = await fetch(`${stack.appUrl}/api/webflow/form`, { method: 'POST', headers: again.headers, body: again.raw });
  assert.equal(r2.status, 200);
  assert.equal(S().users.filter((u) => u.email === 'maria@casaluna.example').length, 1);
});

test('webhook URL key works as an alternative to the signature', async () => {
  const body = JSON.stringify({ triggerType: 'form_submission', payload: { name: 'Contact', data: { Name: 'Lee' } } });
  const wrong = await fetch(`${stack.appUrl}/api/webflow/form?key=nope`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal(wrong.status, 401);
  const right = await fetch(`${stack.appUrl}/api/webflow/form?key=${URL_KEY}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal(right.status, 200);
});

test('contact form submissions are accepted', async () => {
  const { raw, headers } = signWebflow({ triggerType: 'form_submission', payload: { name: 'Contact', data: { Name: 'Sam', Email: 'sam@x.com', Message: 'Hi' } } });
  const res = await fetch(`${stack.appUrl}/api/webflow/form`, { method: 'POST', headers, body: raw });
  assert.equal(res.status, 200);
});

test('invite link signs the new client in and lets them set a password', async () => {
  const user = S().users.find((u) => u.email === 'maria@casaluna.example');
  const session = stack.mock.issue(user.id);
  client = browser(stack.appUrl);
  const cb = await client.get('/auth/callback');
  assert.match(cb.text, /callback\.js/);
  const evil = browser(stack.appUrl);
  const blocked = await evil.post('/auth/session', { json: { ...session, type: 'invite' }, origin: 'https://evil.example' });
  assert.equal(blocked.status, 403);
  const ok = await client.post('/auth/session', { json: { access_token: session.access_token, refresh_token: session.refresh_token, expires_in: 3600, type: 'invite' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse(ok.text), { next: '/set-password' });
  assert.ok(client.jar.has('fr_at'));
  const short = await client.post('/set-password', { form: { password: 'short', confirm: 'short' } });
  assert.equal(short.status, 400);
  const mismatch = await client.post('/set-password', { form: { password: 'tacotuesday26', confirm: 'tacotuesday27' } });
  assert.match(mismatch.text, /don’t match/);
  const set = await client.post('/set-password', { form: { password: 'tacotuesday26', confirm: 'tacotuesday26' } });
  assert.equal(set.status, 303);
  assert.equal(user.password, 'tacotuesday26');
});

test('the Webflow login form logs people in; other sites cannot', async () => {
  const outsider = browser(stack.appUrl);
  const bad = await outsider.post('/auth/login', { form: { email: 'maria@casaluna.example', password: 'tacotuesday26' }, origin: 'https://evil.example' });
  assert.equal(bad.location, '/login?error=origin');
  assert.ok(!outsider.jar.has('fr_at'));

  const wrong = await outsider.post('/auth/login', { form: { email: 'maria@casaluna.example', password: 'nope' }, origin: WEBFLOW });
  assert.equal(wrong.location, '/login?error=invalid&email=maria%40casaluna.example');

  client = browser(stack.appUrl);
  const ok = await client.post('/auth/login', { form: { email: 'Maria@CasaLuna.example', password: 'tacotuesday26' }, origin: WEBFLOW });
  assert.equal(ok.status, 303);
  assert.equal(ok.location, '/');
  const setCookie = ok.headers.getSetCookie().join('\n');
  assert.match(setCookie, /fr_at=.*HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  const home = await client.get('/');
  assert.equal(home.location, '/onboarding', 'new clients start with the questionnaire');
});

test('next= cannot send people to another site after login', async () => {
  const b = browser(stack.appUrl);
  const r = await b.post('/auth/login', { form: { email: 'maria@casaluna.example', password: 'tacotuesday26', next: 'https://evil.example' }, origin: WEBFLOW });
  assert.equal(r.location, '/');
});

test('the questionnaire validates, then saves guidelines for team review', async () => {
  const page = await client.get('/onboarding');
  assert.equal(page.status, 200);
  assert.match(page.text, /Casa Luna Taquería/);
  assert.match(page.text, /value="Google" checked/);
  const missing = await client.post('/onboarding', { form: [['business_name', 'Casa Luna']] });
  assert.equal(missing.status, 400);
  assert.match(missing.text, /Add who follows up/);
  const saved = await client.post('/onboarding', { form: formOf(ANSWERS) });
  assert.equal(saved.location, '/guidelines?submitted=1');
  const biz = S().tables.businesses[0];
  assert.equal(biz.status, 'in_review');
  assert.equal(biz.guidelines.contact.phone, '(619) 555-0142');
  const g = await client.get('/guidelines?submitted=1');
  assert.match(g.text, /In review by our team/);
  assert.match(g.text, /call or text Maria directly/);
});

test('clients cannot open the team console or other businesses', async () => {
  const r = await client.get('/team');
  assert.equal(r.status, 404);
  const other = await client.post('/switch-business', { form: { business_id: '00000000-0000-0000-0000-000000000000' } });
  assert.equal(other.status, 303);
  assert.ok(!client.jar.has('fr_biz'));
});

test('staff approve guidelines and add reviews; rules decide what posts', async () => {
  staff = browser(stack.appUrl);
  await staff.post('/auth/login', { form: { email: 'kaitlyn@beyondsmm.com', password: 'staff-pass-123' } });
  const home = await staff.get('/');
  assert.equal(home.location, '/team');
  const team = await staff.get('/team');
  assert.match(team.text, /Guidelines to review \(1\)/);
  const biz = S().tables.businesses[0];
  const approve = await staff.post(`/team/b/${biz.id}/approve-guidelines`);
  assert.equal(approve.location, `/team/b/${biz.id}?done=approved`);
  assert.equal(biz.status, 'active');

  const add = (form) => staff.post(`/team/b/${biz.id}/reviews`, { form });
  await add({ platform: 'Google', rating: '5', author: 'Jordan M.', body: 'Best carnitas in North Park! Staff remembered my order.' });
  await add({ platform: 'Google', rating: '1', author: 'Dana R.', body: 'Waited 40 minutes and nobody checked on us.' });
  await add({ platform: 'Google', rating: '5', author: 'Lee P.', body: 'Loved it but I got sick later' });
  await add({ platform: 'Yelp', rating: '5', author: 'Priya S.', body: 'Fresh salsas and great horchata.' });
  const [jordan, dana, lee, priya] = S().tables.reviews;
  assert.equal(jordan.status, 'approved', '5★ Google auto-approved by the client’s rules');
  assert.match(jordan.reply, /Jordan, thank you so much!/);
  assert.equal(dana.status, 'new', '1★ waits for the client');
  assert.equal(lee.status, 'new', 'flagged health mention waits even at 5★');
  assert.match(lee.flag, /illness/);
  assert.equal(priya.status, 'new', 'Yelp is never auto-posted');
});

test('clients approve replies in the inbox; never-say phrases are blocked', async () => {
  const dana = S().tables.reviews.find((r) => r.author === 'Dana R.');
  const inbox = await client.get(`/inbox?r=${dana.id}`);
  assert.equal(inbox.status, 200);
  assert.match(inbox.text, /Dana R\./);
  assert.match(inbox.text, /the long wait/);
  assert.match(inbox.text, /class="count">3</);
  const banned = await client.post(`/inbox/${dana.id}`, { form: { reply: 'We are sorry you feel that way.', action: 'approve', back: `?r=${dana.id}` } });
  assert.match(banned.location, /error=banned/);
  assert.equal(dana.status, 'new');
  const ok = await client.post(`/inbox/${dana.id}`, { form: { reply: 'Dana, thank you for telling us. Please call me. — Maria, Owner', action: 'approve', back: `?r=${dana.id}` } });
  assert.equal(ok.location, `/inbox?r=${dana.id}&saved=approved`);
  assert.equal(dana.status, 'approved');

  const priya = S().tables.reviews.find((r) => r.author === 'Priya S.');
  const yelp = await client.get(`/inbox?r=${priya.id}`);
  assert.match(yelp.text, /Copy reply/);
  await client.post(`/inbox/${priya.id}`, { form: { reply: 'Thank you, Priya!', action: 'posted' } });
  assert.equal(priya.status, 'posted');

  const filtered = await client.get('/inbox?status=new');
  assert.match(filtered.text, /Lee P\./);
  assert.doesNotMatch(filtered.text, /Priya S\./);
  const xss = await client.get('/inbox?q=%3Cscript%3E');
  assert.doesNotMatch(xss.text, /<script>alert|value="<script>/);
});

test('staff mark approved replies as posted', async () => {
  const jordan = S().tables.reviews.find((r) => r.author === 'Jordan M.');
  const r = await staff.post(`/team/reviews/${jordan.id}/posted`);
  assert.equal(jordan.status, 'posted');
  assert.match(r.location, /done=posted/);
});

test('monthly reports: drafted, hidden from client, edited and sent by staff', async () => {
  const biz = S().tables.businesses[0];
  // Put the reviews in last month so the draft has data.
  const { previousMonth } = await import('../lib/reports.js');
  const pm = previousMonth();
  S().tables.reviews.forEach((r) => { r.posted_at = `${pm.start}T18:00:00.000Z`; if (r.replied_at) r.replied_at = `${pm.start}T18:12:00.000Z`; });

  const denied = await fetch(`${stack.appUrl}/api/cron/monthly-reports`, { method: 'POST', headers: { authorization: 'Bearer wrong' } });
  assert.equal(denied.status, 401);
  const cron = await fetch(`${stack.appUrl}/api/cron/monthly-reports`, { method: 'POST', headers: { authorization: `Bearer ${CRON}` } });
  assert.deepEqual((await cron.json()).created, 1);
  const report = S().tables.reports[0];
  assert.equal(report.status, 'draft');
  assert.equal(report.stats.reviews, 4);

  const clientView = await client.get('/reports');
  assert.match(clientView.text, /first report arrives/, 'drafts stay hidden from clients');

  const editor = await staff.get(`/team/reports/${report.id}`);
  assert.match(editor.text, /Waiting for team approval/);
  const form = { summary: 'Edited by our team.', title0: 'Weekend waits are the top complaint.', evidence0: '2 of 4 reviews.', rec0: 'Check in at 10 minutes.', action: 'send' };
  const sent = await staff.post(`/team/reports/${report.id}`, { form });
  assert.equal(sent.location, `/team/reports/${report.id}?done=sent`);
  assert.equal(report.status, 'sent');
  assert.equal(report.summary, 'Edited by our team.');

  const after = await client.get('/reports');
  assert.match(after.text, /Edited by our team\./);
  assert.match(after.text, /Check in at 10 minutes\./);

  const again = await fetch(`${stack.appUrl}/api/cron/monthly-reports`, { method: 'POST', headers: { authorization: `Bearer ${CRON}` } });
  assert.equal((await again.json()).created, 0, 'no duplicate drafts');
  assert.equal(biz.status, 'active');
});

test('expired access tokens refresh silently; logout clears the session', async () => {
  const at = client.jar.get('fr_at');
  S().access.delete(decodeURIComponent(at));
  // Pretend the token is about to expire by replacing it with an expired one.
  client.jar.set('fr_at', encodeURIComponent('e30.eyJleHAiOjF9.x'));
  const r = await client.get('/inbox');
  assert.equal(r.status, 200, 'refresh token got a new session');
  const out = await client.post('/auth/logout');
  assert.equal(out.location, `${WEBFLOW}/login`);
  assert.ok(!client.jar.has('fr_at'));
  const gone = await client.get('/inbox');
  assert.equal(gone.status, 303);
});

test('static files cannot escape the public folder', async () => {
  const r = await fetch(`${stack.appUrl}/static/..%2Fserver.js`);
  assert.equal(r.status, 404);
  const css = await fetch(`${stack.appUrl}/static/app.css`);
  assert.equal(css.status, 200);
});

test('forgot password never reveals whether an account exists', async () => {
  const b = browser(stack.appUrl);
  const a = await b.post('/forgot-password', { form: { email: 'nobody@nowhere.example' } });
  const c = await b.post('/forgot-password', { form: { email: 'maria@casaluna.example' } });
  assert.equal(a.location, '/login?reset=sent');
  assert.equal(c.location, '/login?reset=sent');
  assert.equal(S().recovers.at(-1).redirect_to, `${stack.appUrl}/auth/callback`);
});
