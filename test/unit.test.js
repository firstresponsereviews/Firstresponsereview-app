import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { draftForReview, flagFor, ruleFor, bannedPhrases, firstName, replyText, contactLine } from '../public/shared/replies.js';
import { normalizeGuidelines, validateGuidelines, renderGuidelines } from '../lib/guidelines.js';
import { buildReportDraft, reviewStats, previousMonth } from '../lib/reports.js';
import { verifyWebflowSignature } from '../routes/webhooks.js';
import { esc } from '../lib/html.js';
import { safeNext } from '../lib/http.js';
import { ANSWERS } from './helpers.js';

const g = normalizeGuidelines(ANSWERS);

test('questionnaire answers become clean guidelines', () => {
  assert.equal(g.business.name, 'Casa Luna Taquería');
  assert.deepEqual(g.business.platforms, ['Google', 'Yelp']);
  assert.deepEqual(g.offers.items, ['apology', 'free', 'refund']);
  assert.equal(g.voice.words.length, 3);
  assert.equal(g.rules.thankStaff, true);
  assert.equal(g.rules.spanish, false);
  assert.deepEqual(validateGuidelines(g), []);
});

test('bad questionnaire input is cleaned and flagged', () => {
  const bad = normalizeGuidelines({ business_name: '', platforms: ['MySpace'], words: ['warm', 'a', 'b', 'calm', 'upbeat', 'playful'], formality: '99', method: 'fax', phone: '12', contact_email: 'nope' });
  assert.equal(bad.voice.formality, 5);
  assert.equal(bad.contact.method, 'call');
  assert.deepEqual(bad.business.platforms, []);
  assert.equal(bad.voice.words.length, 3);
  const errs = validateGuidelines(bad);
  assert.ok(errs.length >= 5);
});

test('medical businesses get health-privacy mode automatically', () => {
  const m = normalizeGuidelines({ ...ANSWERS, industry: 'Medical or dental' });
  assert.equal(m.rules.healthPrivacy, true);
  const d = draftForReview({ author: 'Sam K.', rating: 1, body: 'I got sick after my visit' }, m);
  assert.match(d, /your experience/);
  assert.doesNotMatch(d, /sick/);
});

test('5-star reply thanks by name, signs off, uses emoji only when allowed', () => {
  const d = draftForReview({ author: 'Jordan M.', rating: 5, body: 'Best carnitas, staff remembered my order' }, g);
  assert.match(d, /^Jordan, thank you so much!/);
  assert.match(d, /Maria, Owner$/);
  assert.match(d, /🙌/);
  assert.match(d, /team hears this/);
});

test('1-star reply owns the problem and shares the manager contact', () => {
  const d = draftForReview({ author: 'Dana R.', rating: 1, body: 'Waited 40 minutes and nobody checked on us.' }, g);
  assert.match(d, /the long wait/);
  assert.match(d, /\(619\) 555-0142/);
  assert.doesNotMatch(d, /🙌/);
  assert.doesNotMatch(d, /refund|free/i, 'offers never appear in public replies');
});

test('unusable reviewer names are skipped', () => {
  assert.equal(firstName('Verified user, Accounting'), '');
  assert.match(replyText(g, { name: 'Verified user', rating: 5 }), /^Thank you so much!/);
});

test('contact line follows the chosen method', () => {
  assert.match(contactLine({ ...g, contact: { ...g.contact, method: 'email' } }), /email us at hola@casaluna.example/);
  assert.match(contactLine({ ...g, contact: { ...g.contact, method: 'number' } }), /send your phone number/);
});

test('sensitive reviews are flagged and never auto-posted', () => {
  const sick = { rating: 5, body: 'Great but I got food poisoning' };
  assert.match(flagFor(sick, g), /illness/);
  assert.equal(ruleFor(sick, g), 'ask');
  assert.equal(ruleFor({ rating: 5, body: 'Lovely!' }, g), 'auto');
  assert.equal(ruleFor({ rating: 2, body: 'Meh' }, g), 'ask');
  assert.equal(ruleFor({ rating: 4, body: 'Nice' }, { ...g, rules: { ...g.rules, r4: 'ask' } }), 'ask');
});

test('never-say phrases are caught', () => {
  assert.deepEqual(bannedPhrases('We are sorry you feel that way.', g.voice.never), ['sorry you feel that way']);
  assert.deepEqual(bannedPhrases('Thanks!', g.voice.never), []);
});

test('guidelines page escapes client text', () => {
  const html = renderGuidelines({ name: 'X', guidelines: { ...g, voice: { ...g.voice, sign: '<script>alert(1)</script>' } } });
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
  assert.equal(esc(`"'<>&`), '&quot;&#39;&lt;&gt;&amp;');
});

test('monthly report draft computes stats and three insights', () => {
  const t0 = '2026-09-10T18:00:00Z';
  const later = (min) => new Date(new Date(t0).getTime() + min * 60000).toISOString();
  const reviews = [
    { rating: 5, body: 'Delicious food and friendly staff', status: 'posted', posted_at: t0, replied_at: later(10) },
    { rating: 5, body: 'Fresh salsas, lovely patio', status: 'approved', posted_at: t0, replied_at: later(20) },
    { rating: 2, body: 'Waited forever, slow service', status: 'approved', posted_at: t0, replied_at: later(30) },
    { rating: 1, body: 'We waited 45 minutes', status: 'new', posted_at: t0 },
  ];
  const s = reviewStats(reviews);
  assert.deepEqual(s, { reviews: 4, avgRating: 3.3, answeredPct: 75, medianReplyMin: 20 });
  const draft = buildReportDraft({ id: 'b1', name: 'Casa Luna' }, reviews, { start: '2026-09-01', end: '2026-09-30' });
  assert.equal(draft.status, 'draft');
  assert.equal(draft.insights.length, 3);
  assert.match(draft.insights[0].title, /Wait times/);
  assert.match(draft.summary, /4 reviews/);
});

test('previous month boundaries', () => {
  assert.deepEqual(previousMonth(new Date('2026-11-01T10:00:00Z')), { start: '2026-10-01', end: '2026-10-31' });
  assert.deepEqual(previousMonth(new Date('2026-01-15T10:00:00Z')), { start: '2025-12-01', end: '2025-12-31' });
});

test('Webflow webhook signatures are checked', () => {
  const body = '{"triggerType":"form_submission"}';
  const ts = String(Date.now());
  const sig = crypto.createHmac('sha256', 's3cret').update(`${ts}:${body}`).digest('hex');
  assert.equal(verifyWebflowSignature(body, { 'x-webflow-timestamp': ts, 'x-webflow-signature': sig }, 's3cret'), true);
  assert.equal(verifyWebflowSignature(body + ' ', { 'x-webflow-timestamp': ts, 'x-webflow-signature': sig }, 's3cret'), false, 'tampered body');
  assert.equal(verifyWebflowSignature(body, { 'x-webflow-timestamp': ts, 'x-webflow-signature': sig }, 'other'), false, 'wrong secret');
  const old = String(Date.now() - 10 * 60 * 1000);
  const oldSig = crypto.createHmac('sha256', 's3cret').update(`${old}:${body}`).digest('hex');
  assert.equal(verifyWebflowSignature(body, { 'x-webflow-timestamp': old, 'x-webflow-signature': oldSig }, 's3cret'), false, 'replayed');
  assert.equal(verifyWebflowSignature(body, {}, 's3cret'), false);
});

test('redirects stay inside the app', () => {
  assert.equal(safeNext('/inbox?r=1'), '/inbox?r=1');
  assert.equal(safeNext('https://evil.example'), '/');
  assert.equal(safeNext('//evil.example'), '/');
  assert.equal(safeNext('/\\evil.example'), '/');
});
