// Client dashboard: onboarding questionnaire, review inbox, guidelines, reports.
import { db, qs, UUID } from '../lib/supabase.js';
import { appPage, ago, esc, notice, stars } from '../lib/html.js';
import { HttpError, redirect, sendHtml } from '../lib/http.js';
import { loadContext, loadUser, setBusinessCookie } from '../lib/session.js';
import { isSameOrigin } from './auth.js';
import { INDUSTRIES, OFFERS, WORDS, guidelinesOrDefault, normalizeGuidelines, renderGuidelines, validateGuidelines } from '../lib/guidelines.js';
import { ASSISTED, ESCALATION_TOPICS, PLATFORMS, bannedPhrases, draftForReview, flagFor, toneOf, wordCount } from '../public/shared/replies.js';
import { formatMinutes, monthLabel, reviewStats } from '../lib/reports.js';
import { aiEnabled, aiReply } from '../lib/ai.js';

// Loads the signed-in context or sends the visitor to log in.
export async function requireCtx(req, res, path) {
  const user = await loadUser(req, res);
  if (!user) { redirect(res, `/login?next=${encodeURIComponent(path || req.url)}`); return null; }
  const ctx = await loadContext(req, user);
  if (ctx.current) {
    const waiting = await db(user.token).select('reviews', qs({ business_id: `eq.${ctx.current.id}`, status: 'eq.new', select: 'id', limit: 100 }));
    ctx.needsCount = waiting.length;
  }
  return ctx;
}

function noBusiness(res, ctx) {
  if (ctx.isStaff) return redirect(res, '/team');
  sendHtml(res, 200, appPage({
    title: 'Welcome', ctx, active: '',
    body: `<header class="top"><h1>Welcome to First Response</h1></header>
      <section class="card"><p>We’re still setting up your business. You’ll get an email as soon as it’s ready. Questions? Reply to your welcome email.</p></section>`,
  }));
}

export async function getHome(req, res) {
  const ctx = await requireCtx(req, res, '/');
  if (!ctx) return;
  if (!ctx.current) return noBusiness(res, ctx);
  redirect(res, ctx.current.status === 'onboarding' ? '/onboarding' : '/inbox');
}

export async function postSwitchBusiness(req, res, { body }) {
  if (!isSameOrigin(req)) return redirect(res, '/');
  const ctx = await requireCtx(req, res, '/');
  if (!ctx) return;
  const id = String(body.business_id || '');
  if (ctx.businesses.some((b) => b.id === id)) setBusinessCookie(res, id);
  redirect(res, '/');
}

/* ---------- Onboarding questionnaire ---------- */

const checked = (cond) => (cond ? ' checked' : '');
const selected = (cond) => (cond ? ' selected' : '');

function onboardingBody(g, errors = []) {
  const step = (n, title, sub, inner) => `<fieldset class="qstep" data-step="${n}"><legend class="qhead"><span class="eyebrow">Step ${n} of 5</span><span class="qtitle">${title}</span><span class="qsub">${sub}</span></legend>${inner}</fieldset>`;
  const opt = (name, value, label, on, type = 'checkbox') => `<label class="opt"><input type="${type}" name="${name}" value="${esc(value)}"${checked(on)}>${esc(label)}</label>`;
  return `
  <header class="top"><div><h1>Tell us how you treat customers</h1><p class="sub">About 10 minutes. Your answers become the reputation guidelines our team follows on every reply. You can change them anytime.</p></div></header>
  ${errors.length ? `<div class="notice error" role="alert"><strong>Please fix:</strong><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
  <div class="qwrap">
    <form method="post" action="/onboarding" class="card quiz" id="quiz" novalidate>
      <div class="progress" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div>
      ${step(1, 'Your business', 'The basics, so replies sound local and accurate.', `
        <div class="form">
          <div class="field"><label for="business_name">Business name</label><input id="business_name" name="business_name" required value="${esc(g.business.name)}"></div>
          <div class="field"><label for="industry">Type of business</label><select id="industry" name="industry">${INDUSTRIES.map((i) => `<option${selected(g.business.industry === i)}>${esc(i)}</option>`).join('')}</select></div>
          <div class="field"><label for="city">City and neighborhood</label><input id="city" name="city" value="${esc(g.business.city)}"></div>
          <div class="field"><label for="locations">Number of locations</label><input id="locations" name="locations" inputmode="numeric" value="${esc(g.business.locations)}"></div>
        </div>
        <div class="group"><p class="label">Where do customers review you?</p><div class="opts">${PLATFORMS.map((p) => opt('platforms', p, p, g.business.platforms.includes(p))).join('')}</div></div>`)}
      ${step(2, 'Unhappy customers', 'Who follows up, and how customers can reach them.', `
        <div class="form">
          <div class="field"><label for="manager">Who follows up with unhappy customers?</label><input id="manager" name="manager" value="${esc(g.contact.manager)}"></div>
          <div class="field"><label for="role">Their title</label><input id="role" name="role" value="${esc(g.contact.role)}"></div>
          <div class="field"><label for="phone">Their direct phone</label><input id="phone" name="phone" type="tel" autocomplete="tel" value="${esc(g.contact.phone)}"><span class="hint">Used for alerts and customer callbacks.</span></div>
          <div class="field"><label for="contact_email">Email for customer follow-up</label><input id="contact_email" name="contact_email" type="email" value="${esc(g.contact.email)}"></div>
          <div class="field"><label for="callback">How fast will they call back?</label><select id="callback" name="callback">${['within 2 hours', 'the same day', 'within 24 hours'].map((c) => `<option value="${c}"${selected(g.contact.callback === c)}>${c[0].toUpperCase() + c.slice(1)}</option>`).join('')}</select></div>
        </div>
        <div class="group"><p class="label">In a reply to an unhappy review, how should we invite the customer to reach you?</p>
          <label class="opt col"><input type="radio" name="method" value="call"${checked(g.contact.method === 'call')}><span>Share the manager’s number<small>“Please call or text them directly.”</small></span></label>
          <label class="opt col"><input type="radio" name="method" value="number"${checked(g.contact.method === 'number')}><span>Ask for their number so the manager calls them<small>“Send your number to our email and we’ll call you.”</small></span></label>
          <label class="opt col"><input type="radio" name="method" value="email"${checked(g.contact.method === 'email')}><span>Invite them to email<small>“Please email us.”</small></span></label></div>`)}
      ${step(3, 'Making it right', 'What your manager can offer privately after a bad experience.', `
        <div class="group"><p class="label">What can your manager offer to make it right?</p>
          <label class="opt col"><input type="checkbox" checked disabled><span>${OFFERS.apology}<small>Always included.</small></span></label>
          <label class="opt col"><input type="checkbox" name="offers" value="free"${checked(g.offers.items.includes('free'))}><span>${OFFERS.free}<small>A meal, a drink, an add-on service.</small></span></label>
          <label class="opt col"><input type="checkbox" name="offers" value="discount"${checked(g.offers.items.includes('discount'))}><span>A discount on their next visit:</span><input class="inline-num" name="pct" inputmode="numeric" aria-label="Discount percent" value="${esc(g.offers.pct)}">%</label>
          <label class="opt col"><input type="checkbox" name="offers" value="refund"${checked(g.offers.items.includes('refund'))}><span>A refund up to $</span><input class="inline-num" name="refund" inputmode="numeric" aria-label="Refund limit in dollars" value="${esc(g.offers.refund)}"></label>
          <label class="opt col"><input type="checkbox" name="offers" value="redo"${checked(g.offers.items.includes('redo'))}><span>${OFFERS.redo}</span></label></div>
        <div class="group"><p class="label">Who decides which offer to make?</p><div class="opts">
          ${opt('decide', 'manager', 'The manager, on the call', g.offers.decide === 'manager', 'radio')}${opt('decide', 'any', 'Any of the above, at their choice', g.offers.decide === 'any', 'radio')}</div></div>
        <p class="callout">Offers are made privately, on the call. We never mention them in a public reply, and they’re never tied to changing or removing a review. Federal rules ban incentives tied to what a review says.</p>`)}
      ${step(4, 'Your voice', 'How replies should sound when they come from you.', `
        <div class="group"><label class="label" for="formality">How formal should replies sound?</label><div class="range"><span>Casual</span><input id="formality" name="formality" type="range" min="1" max="5" value="${esc(g.voice.formality)}"><span>Formal</span></div></div>
        <div class="group"><label class="label" for="length">How long?</label><div class="range"><span>Short</span><input id="length" name="length" type="range" min="1" max="5" value="${esc(g.voice.length)}"><span>Detailed</span></div></div>
        <div class="group"><p class="label">Pick up to three words for your personality</p><div class="opts">${WORDS.map((w) => opt('words', w, w[0].toUpperCase() + w.slice(1), g.voice.words.includes(w))).join('')}</div></div>
        <div class="form">
          <div class="field"><label for="sign">Sign replies as</label><input id="sign" name="sign" value="${esc(g.voice.sign)}" placeholder="e.g. Maria, Owner"></div>
          <div class="field"><label for="emoji">Emojis</label><select id="emoji" name="emoji"><option value="never"${selected(g.voice.emoji === 'never')}>Never</option><option value="five"${selected(g.voice.emoji === 'five')}>Only on 5★ replies</option></select></div>
          <div class="field"><label for="love">Words or details you love to mention</label><input id="love" name="love" value="${esc(g.voice.love)}" placeholder="e.g. family recipes, our patio"></div>
          <div class="field"><label for="never">Never say</label><input id="never" name="never" value="${esc(g.voice.never)}" placeholder="e.g. sorry you feel that way"></div>
        </div>`)}
      ${step(5, 'How we respond', 'What posts on its own and what comes to you first.', `
        <div class="tablewrap"><table class="rules"><thead><tr><th>Review</th><th>What we do</th></tr></thead><tbody>
          <tr><td>5★</td><td><select name="r5" aria-label="5-star reviews"><option value="auto"${selected(g.rules.r5 === 'auto')}>Reply and post right away</option><option value="ask"${selected(g.rules.r5 === 'ask')}>Send it to me first</option></select></td></tr>
          <tr><td>4★</td><td><select name="r4" aria-label="4-star reviews"><option value="auto"${selected(g.rules.r4 === 'auto')}>Reply and post right away</option><option value="ask"${selected(g.rules.r4 === 'ask')}>Send it to me first</option></select></td></tr>
          <tr><td>3★</td><td><select name="r3" aria-label="3-star reviews"><option value="ask"${selected(g.rules.r3 === 'ask')}>Send it to me first</option><option value="team"${selected(g.rules.r3 === 'team')}>Our team approves for me</option></select></td></tr>
          <tr><td>1–2★</td><td><select name="r12" aria-label="1 and 2 star reviews"><option value="ask"${selected(g.rules.r12 === 'ask')}>Send it to me first, and alert me</option><option value="team"${selected(g.rules.r12 === 'team')}>Our team approves, and alerts me</option></select></td></tr>
        </tbody></table></div>
        <div class="group"><p class="label">Always come to me when a review mentions</p><div class="opts">
          ${[...Object.keys(ESCALATION_TOPICS), 'A staff member named negatively', 'A review that seems fake'].map((e) => opt('escalate', e, e, g.rules.escalate.includes(e))).join('')}</div></div>
        <div class="group"><p class="label">Other preferences</p>
          <label class="opt col"><input type="checkbox" name="thankStaff"${checked(g.rules.thankStaff)}><span>Thank staff by name when a customer praises them</span></label>
          <label class="opt col"><input type="checkbox" name="starOnly"${checked(g.rules.starOnly)}><span>Reply to star-only reviews with a short thank-you</span></label>
          <label class="opt col"><input type="checkbox" name="spanish"${checked(g.rules.spanish)}><span>Reply in Spanish when the review is in Spanish</span></label>
          <label class="opt col"><input type="checkbox" name="healthPrivacy"${checked(g.rules.healthPrivacy)}><span>Health-privacy mode<small>For medical and dental: replies never confirm someone was a patient.</small></span></label></div>`)}
      <div class="qnav"><button class="btn" type="button" data-back>Back</button><button class="btn primary" type="submit" data-next>Build my guidelines</button></div>
    </form>
    <aside class="preview" aria-live="polite">
      <h2>How your replies will sound</h2>
      <div class="bubble"><span class="who">★☆☆☆☆ “Waited 40 minutes and nobody checked on us.”</span><span id="pvLow">Fill in your answers to see a preview.</span></div>
      <div class="bubble"><span class="who">★★★★★ “Ana was amazing, best night out in ages!”</span><span id="pvHigh"></span></div>
      <p class="fine">Our team reads your answers before your first reply goes out.</p>
    </aside>
  </div>`;
}

export async function getOnboarding(req, res) {
  const ctx = await requireCtx(req, res, '/onboarding');
  if (!ctx) return;
  if (!ctx.current) return noBusiness(res, ctx);
  const b = ctx.current;
  const g = guidelinesOrDefault(b);
  if (!b.guidelines) {
    g.business.name = b.name || '';
    g.contact.email = g.contact.email || b.owner_email || '';
    g.contact.manager = g.contact.manager || ctx.user.name || '';
    if (b.review_sites) g.business.platforms = PLATFORMS.filter((p) => b.review_sites.toLowerCase().includes(p.toLowerCase()));
    if (!g.business.platforms.length) g.business.platforms = ['Google'];
  }
  sendHtml(res, 200, appPage({ title: 'Your guidelines', ctx, active: 'guidelines', body: onboardingBody(g), scripts: ['/static/js/onboarding.js'] }));
}

export async function postOnboarding(req, res, { body }) {
  if (!isSameOrigin(req)) return redirect(res, '/onboarding');
  const ctx = await requireCtx(req, res, '/onboarding');
  if (!ctx) return;
  if (!ctx.current) return noBusiness(res, ctx);
  const g = normalizeGuidelines(body);
  const errors = validateGuidelines(g);
  if (errors.length) {
    return sendHtml(res, 400, appPage({ title: 'Your guidelines', ctx, active: 'guidelines', body: onboardingBody(g, errors), scripts: ['/static/js/onboarding.js'] }));
  }
  await db(ctx.user.token).rpc('submit_guidelines', { bid: ctx.current.id, g });
  redirect(res, '/guidelines?submitted=1');
}

/* ---------- Guidelines ---------- */

export function guidelinesStatus(b) {
  if (!b.guidelines || b.status === 'onboarding') return ['p-new', 'Not finished yet'];
  if (b.status === 'in_review' || !b.guidelines_approved_at) return ['p-needs', 'In review by our team'];
  return ['p-posted', 'Approved'];
}

export async function getGuidelines(req, res, { query }) {
  const ctx = await requireCtx(req, res, '/guidelines');
  if (!ctx) return;
  if (!ctx.current) return noBusiness(res, ctx);
  const b = ctx.current;
  if (!b.guidelines) return redirect(res, '/onboarding');
  const [cls, label] = guidelinesStatus(b);
  sendHtml(res, 200, appPage({
    title: 'Reputation guidelines', ctx, active: 'guidelines',
    notice: query.submitted ? notice('ok', 'Thanks! Your guidelines are in. Our team reviews them within 1 business day before your first reply goes out.') : '',
    body: `<header class="top"><div><h1>${esc(b.name)} reputation guidelines</h1><p class="sub">Built from your questionnaire. Our team follows this on every reply.</p></div>
      <div class="row"><span class="pill ${cls}">${label}</span><a class="btn" href="/onboarding">Edit my answers</a></div></header>
      <div class="guide">${renderGuidelines(b)}</div>`,
  }));
}

/* ---------- Review inbox ---------- */

const STATUS = { new: ['p-needs', 'Needs your OK'], approved: ['p-draft', 'Approved · waiting to post'], posted: ['p-posted', 'Posted'] };

function kpis(reviews) {
  const now = Date.now();
  const last30 = reviews.filter((r) => now - new Date(r.posted_at) < 30 * 864e5);
  const last90 = reviews.filter((r) => now - new Date(r.posted_at) < 90 * 864e5);
  const s30 = reviewStats(last30);
  const s90 = reviewStats(last90);
  const waiting = reviews.filter((r) => r.status === 'new').length;
  return `<section class="kpis" aria-label="Key numbers">
    <div class="kpi hero"><span class="label">Median first reply · 30 days</span><span class="val">${formatMinutes(s30.medianReplyMin)}</span><span class="delta">from review to approved reply</span></div>
    <div class="kpi"><span class="label">Response rate · 30 days</span><span class="val">${last30.length ? `${s30.answeredPct}%` : '—'}</span><span class="delta">${last30.length} review${last30.length === 1 ? '' : 's'}</span></div>
    <div class="kpi"><span class="label">Average rating · 90 days</span><span class="val">${s90.avgRating == null ? '—' : `${s90.avgRating} ★`}</span><span class="delta">${last90.length} review${last90.length === 1 ? '' : 's'}</span></div>
    <div class="kpi"><span class="label">Waiting on you</span><span class="val">${waiting}</span><span class="delta">reviews that need your OK</span></div>
  </section>`;
}

function filterReviews(reviews, f) {
  const q = String(f.q || '').toLowerCase();
  return reviews.filter((r) => (!f.status || r.status === f.status)
    && (!f.platform || r.platform === f.platform)
    && (!f.rating || (f.rating === 'low' ? r.rating <= 3 : String(r.rating) === f.rating))
    && (!q || `${r.author} ${r.body}`.toLowerCase().includes(q)));
}

const keep = (f, extra = {}) => {
  const p = new URLSearchParams();
  for (const k of ['status', 'platform', 'rating', 'q']) if (f[k]) p.set(k, f[k]);
  for (const [k, v] of Object.entries(extra)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

async function detailHtml(r, g, f, query) {
  if (!r) return '<p class="sub">No reviews match these filters.</p>';
  const head = `<div class="row"><h2>${esc(r.author)}</h2>${stars(r.rating)}<span class="plat">${esc(r.platform)}</span><span class="meta">${ago(r.posted_at)}</span></div>
    <p class="quote">“${esc(r.body || '(Star rating only, no text)')}”</p>`;
  if (r.status === 'posted') {
    return `${head}<div class="posted"><strong>Reply posted on ${esc(r.platform)}</strong><p>${esc(r.reply)}</p></div>`;
  }
  const tone = ['warm', 'brief', 'formal'].includes(query.tone) ? query.tone : toneOf(g);
  let draft = r.reply && !query.tone && !query.ai ? r.reply : null;
  if (!draft && query.ai === '1' && aiEnabled()) draft = await aiReply(r, g, tone);
  if (!draft) draft = draftForReview(r, g, tone);
  const flag = r.flag || flagFor(r, g);
  const assisted = ASSISTED[r.platform];
  const [cls, label] = STATUS[r.status] || STATUS.new;
  const toneLink = (t, name) => `<a class="chip" href="/inbox${keep(f, { r: r.id, tone: t })}"${tone === t && !query.ai ? ' aria-current="true"' : ''}>${name}</a>`;
  return `${head}
    <div class="row"><span class="pill ${cls}">${label}</span></div>
    ${flag ? `<div class="flag" role="note"><strong>Flagged</strong><span>${esc(flag)}</span></div>` : ''}
    <form method="post" action="/inbox/${esc(r.id)}" class="composer">
      <input type="hidden" name="back" value="${esc(keep(f, { r: r.id }))}">
      <div class="row"><label for="reply">Suggested reply in your voice</label><span class="wc" id="wc" aria-live="polite"></span></div>
      <div class="tones" role="group" aria-label="Tone">${toneLink('warm', 'Warm')}${toneLink('brief', 'Brief')}${toneLink('formal', 'Professional')}${aiEnabled() ? `<a class="chip" href="/inbox${keep(f, { r: r.id, ai: '1', tone })}"${query.ai ? ' aria-current="true"' : ''}>Rewrite</a>` : ''}</div>
      <textarea id="reply" name="reply" rows="6" data-never="${esc(g.voice.never)}" required>${esc(draft)}</textarea>
      <div id="bannedMsg" aria-live="polite"></div>
      <div class="actions">
        ${assisted
          ? `<button class="btn primary" type="button" data-copy="#reply">Copy reply</button><button class="btn" type="submit" name="action" value="posted">I posted it on ${esc(r.platform)}</button>`
          : `<button class="btn primary" type="submit" name="action" value="approve">${r.status === 'approved' ? 'Update approved reply' : `Approve reply for ${esc(r.platform)}`}</button>`}
      </div>
      <p class="fine">${assisted ? esc(assisted) : 'Approved replies are posted to your profile by First Response. You can edit until then.'}</p>
    </form>`;
}

export async function getInbox(req, res, { query }) {
  const ctx = await requireCtx(req, res, '/inbox');
  if (!ctx) return;
  if (!ctx.current) return noBusiness(res, ctx);
  const b = ctx.current;
  if (b.status === 'onboarding') return redirect(res, '/onboarding');
  const g = guidelinesOrDefault(b);
  const reviews = await db(ctx.user.token).select('reviews', qs({ business_id: `eq.${b.id}`, select: '*', order: 'posted_at.desc', limit: 300 }));
  const f = { status: STATUS[query.status] ? query.status : '', platform: PLATFORMS.includes(query.platform) ? query.platform : '', rating: ['5', '4', 'low'].includes(query.rating) ? query.rating : '', q: String(query.q || '').slice(0, 100) };
  const list = filterReviews(reviews, f);
  const sel = list.find((r) => r.id === query.r) || list[0] || null;
  const savedMsg = { approved: 'Reply approved. We’ll post it to your profile.', posted: 'Marked as posted. Nice work.' }[query.saved] || '';
  const errMsg = query.error === 'banned' ? `That reply uses a phrase on your never-say list: “${String(query.phrase || '').slice(0, 80)}”.` : query.error === 'empty' ? 'Write a reply before approving.' : '';
  const body = `
    <header class="top"><div><h1>Review inbox</h1><p class="sub">${b.status === 'in_review' ? 'Your guidelines are in review. You can look around; replies start once our team approves them.' : 'Every review, answered first.'}</p></div></header>
    ${kpis(reviews)}
    <div class="inbox">
      <div>
        <form class="filters" method="get" action="/inbox" role="search">
          <label class="sr" for="q">Search reviews</label><input id="q" name="q" type="search" placeholder="Search reviews" value="${esc(f.q)}">
          <label class="sr" for="fs">Status</label><select id="fs" name="status" data-autosubmit><option value="">All statuses</option>${Object.entries(STATUS).map(([k, [, l]]) => `<option value="${k}"${selected(f.status === k)}>${l}</option>`).join('')}</select>
          <label class="sr" for="fp">Platform</label><select id="fp" name="platform" data-autosubmit><option value="">All sites</option>${PLATFORMS.map((p) => `<option${selected(f.platform === p)}>${p}</option>`).join('')}</select>
          <label class="sr" for="fr">Rating</label><select id="fr" name="rating" data-autosubmit><option value="">All ratings</option><option value="5"${selected(f.rating === '5')}>5★</option><option value="4"${selected(f.rating === '4')}>4★</option><option value="low"${selected(f.rating === 'low')}>1–3★</option></select>
          <noscript><button class="btn small" type="submit">Filter</button></noscript>
        </form>
        <ul class="list" aria-label="Reviews">
          ${list.length ? list.map((r) => `<li><a class="item" href="/inbox${keep(f, { r: r.id })}"${sel && sel.id === r.id ? ' aria-current="true"' : ''}>
            <span class="row"><span class="name">${esc(r.author)}</span>${stars(r.rating)}<span class="meta">${ago(r.posted_at)}</span></span>
            <span class="snip">${esc(r.body || 'Star rating only')}</span>
            <span class="row"><span class="plat">${esc(r.platform)}</span><span class="pill ${STATUS[r.status][0]}">${STATUS[r.status][1]}</span></span></a></li>`).join('')
            : `<li class="empty">${reviews.length ? 'No reviews match these filters.' : 'No reviews yet. New reviews show up here as soon as they arrive.'}</li>`}
        </ul>
      </div>
      <article class="detail" aria-label="Selected review">${await detailHtml(sel, g, f, query)}</article>
    </div>`;
  sendHtml(res, 200, appPage({ title: 'Review inbox', ctx, active: 'inbox', body, notice: notice('ok', savedMsg) + notice('error', errMsg) }));
}

export async function postReply(req, res, { params, body }) {
  if (!isSameOrigin(req)) return redirect(res, '/inbox');
  if (!UUID.test(params.id)) throw new HttpError(404, 'Review not found.');
  const ctx = await requireCtx(req, res, '/inbox');
  if (!ctx) return;
  if (!ctx.current) return noBusiness(res, ctx);
  const back = String(body.back || '').startsWith('?') ? String(body.back) : `?r=${params.id}`;
  const sep = back.includes('?') ? '&' : '?';
  const reply = String(body.reply || '').trim().slice(0, 4000);
  const g = guidelinesOrDefault(ctx.current);
  if (!reply || wordCount(reply) === 0) return redirect(res, `/inbox${back}${sep}error=empty`);
  const banned = bannedPhrases(reply, g.voice.never);
  if (banned.length) return redirect(res, `/inbox${back}${sep}error=banned&phrase=${encodeURIComponent(banned[0])}`);
  const action = body.action === 'posted' ? 'posted' : 'approve';
  await db(ctx.user.token).rpc(action === 'posted' ? 'mark_reply_posted' : 'approve_reply', { rid: params.id, reply_text: reply });
  redirect(res, `/inbox${back}${sep}saved=${action === 'posted' ? 'posted' : 'approved'}`);
}

/* ---------- Monthly reports (client view: only reports our team has sent) ---------- */

export function reportHtml(report, businessName) {
  const s = report.stats || {};
  return `<article class="card report">
    <h2>${esc(businessName)} · ${esc(monthLabel(report.period_start))}</h2>
    <p class="lead">${esc(report.summary)}</p>
    <div class="stats">
      <div><b>${esc(s.reviews ?? '—')}</b>new reviews</div>
      <div><b>${s.avgRating == null ? '—' : `${esc(s.avgRating)}★`}</b>average rating</div>
      <div><b>${esc(s.answeredPct ?? '—')}%</b>answered</div>
      <div><b>${esc(formatMinutes(s.medianReplyMin))}</b>median reply</div>
    </div>
    ${(report.insights || []).map((i, n) => `<div class="insight"><span class="n">${n + 1}</span><div><h3>${esc(i.title)}</h3><p>${esc(i.evidence)}</p><p class="rec"><strong>Try this:</strong> ${esc(i.rec)}</p></div></div>`).join('')}
  </article>`;
}

export async function getReports(req, res, { params }) {
  const ctx = await requireCtx(req, res, '/reports');
  if (!ctx) return;
  if (!ctx.current) return noBusiness(res, ctx);
  const b = ctx.current;
  const reports = await db(ctx.user.token).select('reports', qs({ business_id: `eq.${b.id}`, status: 'eq.sent', select: '*', order: 'period_start.desc' }));
  const chosen = params.id ? reports.find((r) => r.id === params.id) : reports[0];
  if (params.id && !chosen) throw new HttpError(404, 'Report not found.');
  const body = `<header class="top"><div><h1>Monthly reports</h1><p class="sub">What your reviews say and what to try next. Each report is read by our team before it reaches you.</p></div></header>
    ${reports.length ? `<div class="reports">
      <nav class="reportlist" aria-label="Past reports">${reports.map((r) => `<a href="/reports/${esc(r.id)}"${chosen && chosen.id === r.id ? ' aria-current="page"' : ''}>${esc(monthLabel(r.period_start))}</a>`).join('')}</nav>
      ${reportHtml(chosen, b.name)}</div>`
      : '<section class="card"><p>Your first report arrives at the start of next month, after your first full month of replies.</p></section>'}`;
  sendHtml(res, 200, appPage({ title: 'Monthly reports', ctx, active: 'reports', body }));
}
