// Turns questionnaire answers into a clean guidelines object, and renders it as the
// client's Reputation Guidelines page.
import { esc } from './html.js';
import { contactLine, replyText, ESCALATION_TOPICS, PLATFORMS, defaultGuidelines } from '../public/shared/replies.js';

export const INDUSTRIES = ['Restaurant or café', 'Salon or spa', 'Medical or dental', 'Home services', 'Retail or e-commerce', 'Software', 'Other'];
export const WORDS = ['warm', 'neighborly', 'upbeat', 'professional', 'playful', 'calm'];
export const OFFERS = { apology: 'A sincere apology and a fix', free: 'Something free on their next visit', discount: 'A discount on their next visit', refund: 'A refund', redo: 'Redo the service or replace the order free' };
const CALLBACKS = ['within 2 hours', 'the same day', 'within 24 hours'];
const METHODS = ['call', 'number', 'email'];

const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const str = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);
const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
const clampInt = (v, lo, hi, fallback) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback; };
const digits = (v) => String(v || '').replace(/[^0-9]/g, '').slice(0, 7);

export function normalizeGuidelines(f) {
  const words = arr(f.words).filter((w) => WORDS.includes(w)).slice(0, 3);
  const offers = ['apology', ...arr(f.offers).filter((o) => o in OFFERS && o !== 'apology')];
  const industry = pick(f.industry, INDUSTRIES, 'Other');
  return {
    business: {
      name: str(f.business_name, 120),
      industry,
      city: str(f.city, 120),
      locations: str(f.locations, 20) || '1',
      platforms: arr(f.platforms).filter((p) => PLATFORMS.includes(p)),
    },
    contact: {
      manager: str(f.manager, 80),
      role: str(f.role, 80),
      phone: str(f.phone, 40),
      email: str(f.contact_email, 120),
      callback: pick(f.callback, CALLBACKS, 'the same day'),
      method: pick(f.method, METHODS, 'call'),
    },
    offers: { items: offers, pct: digits(f.pct), refund: digits(f.refund), decide: pick(f.decide, ['manager', 'any'], 'manager') },
    voice: {
      formality: clampInt(f.formality, 1, 5, 2),
      length: clampInt(f.length, 1, 5, 3),
      words: words.length ? words : ['warm'],
      sign: str(f.sign, 80),
      emoji: pick(f.emoji, ['never', 'five'], 'never'),
      love: str(f.love, 300),
      never: str(f.never, 500),
    },
    rules: {
      r5: pick(f.r5, ['auto', 'ask'], 'auto'),
      r4: pick(f.r4, ['auto', 'ask'], 'auto'),
      r3: pick(f.r3, ['ask', 'team'], 'ask'),
      r12: pick(f.r12, ['ask', 'team'], 'ask'),
      escalate: arr(f.escalate).filter((e) => e in ESCALATION_TOPICS || e === 'A staff member named negatively' || e === 'A review that seems fake'),
      thankStaff: f.thankStaff === 'on',
      starOnly: f.starOnly === 'on',
      spanish: f.spanish === 'on',
      healthPrivacy: f.healthPrivacy === 'on' || industry === 'Medical or dental',
    },
  };
}

// Returns a list of plain-language problems, empty when the answers are complete.
export function validateGuidelines(g) {
  const errs = [];
  if (!g.business.name) errs.push('Add your business name.');
  if (!g.business.platforms.length) errs.push('Pick at least one review site.');
  if (!g.contact.manager) errs.push('Add who follows up with unhappy customers.');
  if (g.contact.phone.replace(/\D/g, '').length < 10) errs.push('Add a 10-digit phone number for alerts and callbacks.');
  if (!/^\S+@\S+\.\S+$/.test(g.contact.email)) errs.push('Add a valid follow-up email.');
  if (!g.voice.sign) errs.push('Add a name to sign replies with.');
  return errs;
}

export function guidelinesOrDefault(business) {
  const g = business && business.guidelines;
  if (g && g.business) return g;
  return defaultGuidelines(business || {});
}

const RULE = { auto: 'Posts automatically', ask: 'Sent to you first', team: 'First Response team approves' };
const FORMAL = ['', 'Casual', 'Friendly', 'Balanced', 'Polished', 'Formal'];
const LEN = ['', 'Very short', 'Short', '2–3 sentences', 'A few sentences', 'Detailed'];

export function offerList(g) {
  const o = [];
  const items = (g.offers && g.offers.items) || [];
  if (items.includes('free')) o.push('Something free on their next visit');
  if (items.includes('discount')) o.push(`${g.offers.pct || '—'}% off their next visit`);
  if (items.includes('refund')) o.push(`A refund of up to $${g.offers.refund || '—'}`);
  if (items.includes('redo')) o.push('Redo the service or replace the order free');
  return o;
}

const tags = (s, cls = '') => {
  const items = String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
  return items.length ? items.map((x) => `<span class="tag ${cls}">${esc(x)}</span>`).join('') : '<span class="fine">None yet</span>';
};

export function renderGuidelines(business) {
  const g = guidelinesOrDefault(business);
  const m = g.contact.manager.split(/\s+/)[0] || 'your manager';
  const words = g.voice.words.length ? g.voice.words : ['warm'];
  const offers = offerList(g);
  const plats = g.business.platforms.map((p) => `<span class="tag">${esc(p)} · ${['Yelp', 'G2'].includes(p) ? 'copied for you to post' : 'posted for you'}</span>`).join('') || '<span class="fine">No sites picked yet</span>';
  const sample5 = replyText(g, { name: 'Jordan', rating: 5 });
  const sample1 = replyText(g, { name: 'Dana', rating: 1, issue: 'the long wait' });
  return `
  <div class="grid2">
    <section class="card"><h2>Our voice</h2>
      <div class="tags">${words.map((w) => `<span class="tag">${esc(w[0].toUpperCase() + w.slice(1))}</span>`).join('')}</div>
      <ul>
        <li>Tone: ${FORMAL[g.voice.formality]}. Length: ${LEN[g.voice.length]}.</li>
        <li>Emojis: ${g.voice.emoji === 'five' ? 'one on 5★ thank-yous only' : 'never'}.</li>
        <li>Signed: “${esc(g.voice.sign || '—')}.”</li>
        ${g.rules.thankStaff ? '<li>Thank staff by name when a customer praises them.</li>' : ''}
        ${g.rules.spanish ? '<li>Reply in Spanish when the review is in Spanish.</li>' : ''}
        ${g.rules.healthPrivacy ? '<li>Health-privacy mode: replies never confirm someone was a patient or client.</li>' : ''}
      </ul>
      <h3>Details we love to mention</h3><div class="tags">${tags(g.voice.love)}</div>
      <h3>Never say</h3><div class="tags">${tags(g.voice.never, 'no')}</div>
    </section>
    <section class="card"><h2>When a customer is unhappy</h2>
      <ol>
        <li>We post a calm public reply that thanks them, owns the problem, and asks them to ${esc(contactLine(g))}.</li>
        <li>${esc(g.contact.manager || 'Your manager')}${g.contact.role ? ` (${esc(g.contact.role)})` : ''} gets an alert with the review and our suggested reply.</li>
        <li>${g.contact.method === 'email' ? `${esc(m)} answers their email ${esc(g.contact.callback)}.` : `${esc(m)} calls the customer ${esc(g.contact.callback)}.`}</li>
        <li>${offers.length ? `On the call, ${g.offers.decide === 'manager' ? `${esc(m)} decides whether to offer` : `${esc(m)} can offer`}: ${offers.map(esc).join('; ')}.` : 'On the call, the focus is a sincere apology and a fix.'}</li>
      </ol>
      <p class="callout">Offers stay private. They never appear in a public reply and are never tied to changing or removing a review.</p>
    </section>
  </div>
  <section class="card"><h2>Reply playbook</h2>
    <div class="tablewrap"><table class="play"><thead><tr><th>Review</th><th>Goal</th><th>What the reply does</th><th>Who approves</th></tr></thead><tbody>
      <tr><td>5★</td><td>Thank and invite back</td><td>Thanks them by name and mentions what they loved.</td><td>${RULE[g.rules.r5]}</td></tr>
      <tr><td>4★</td><td>Thank and close the gap</td><td>Thanks them and answers any small issue.</td><td>${RULE[g.rules.r4]}</td></tr>
      <tr><td>3★</td><td>Learn and recover</td><td>Thanks them, owns the problem, invites them to reach ${esc(m)}.</td><td>${RULE[g.rules.r3]}</td></tr>
      <tr><td>1–2★</td><td>Win the customer back</td><td>Apologizes, owns it, takes the conversation offline.</td><td>${RULE[g.rules.r12]}, plus an alert</td></tr>
    </tbody></table></div>
  </section>
  <div class="grid2">
    <section class="card"><h2>Always comes to you first</h2><p class="note">Never posted automatically, whatever the star rating.</p>
      <div class="tags">${g.rules.escalate.map((x) => `<span class="tag no">${esc(x)}</span>`).join('') || '<span class="fine">Nothing selected</span>'}</div>
      <h2>Where we reply</h2><div class="tags">${plats}</div></section>
    <section class="card"><h2>Example replies</h2>
      <div class="bubble"><span class="who">5★ review</span><span>${esc(sample5)}</span></div>
      <div class="bubble"><span class="who">1★ review</span><span>${esc(sample1)}</span></div></section>
  </div>`;
}
