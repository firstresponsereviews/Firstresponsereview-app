// Team console for First Response staff: approve guidelines, add reviews,
// mark replies posted, and review / edit / send monthly reports.
import { config } from '../lib/config.js';
import { auth, db, qs, UUID } from '../lib/supabase.js';
import { appPage, ago, esc, notice, stars } from '../lib/html.js';
import { HttpError, redirect, sendHtml } from '../lib/http.js';
import { isSameOrigin } from './auth.js';
import { requireCtx, guidelinesStatus, reportHtml } from './app.js';
import { guidelinesOrDefault, renderGuidelines } from '../lib/guidelines.js';
import { PLATFORMS, draftForReview, flagFor, ruleFor } from '../public/shared/replies.js';
import { buildReportDraft, monthLabel, previousMonth } from '../lib/reports.js';
import { emailEnabled, emailShell, sendEmail } from '../lib/email.js';

async function requireStaff(req, res, path) {
  const ctx = await requireCtx(req, res, path);
  if (!ctx) return null;
  if (!ctx.isStaff) throw new HttpError(404, 'Page not found.');
  return ctx;
}

const STATUS_LABEL = { onboarding: ['p-new', 'Onboarding'], in_review: ['p-needs', 'Guidelines to review'], active: ['p-posted', 'Active'], paused: ['p-draft', 'Paused'] };

// Creates draft reports for the given businesses for one month. Skips any that already exist.
export async function generateDrafts(d, businesses, period) {
  const created = [];
  for (const b of businesses) {
    const existing = await d.select('reports', qs({ business_id: `eq.${b.id}`, period_start: `eq.${period.start}`, select: 'id' }));
    if (existing.length) continue;
    const reviews = await d.select('reviews', qs({ business_id: `eq.${b.id}`, and: `(posted_at.gte.${period.start}T00:00:00Z,posted_at.lte.${period.end}T23:59:59Z)`, select: '*' }));
    const [row] = await d.insert('reports', buildReportDraft(b, reviews, period));
    created.push({ business: b, report: row });
  }
  return created;
}

export async function getTeam(req, res, { query }) {
  const ctx = await requireStaff(req, res, '/team');
  if (!ctx) return;
  const d = db(ctx.user.token);
  const [businesses, open, drafts] = await Promise.all([
    d.select('businesses', qs({ select: '*', order: 'created_at.desc' })),
    d.select('reviews', qs({ status: 'in.(new,approved)', select: 'business_id,status' })),
    d.select('reports', qs({ status: 'eq.draft', select: 'id,business_id,period_start' })),
  ]);
  const count = (id, s) => open.filter((r) => r.business_id === id && r.status === s).length;
  const name = (id) => (businesses.find((b) => b.id === id) || {}).name || 'Unknown';
  const toReview = businesses.filter((b) => b.guidelines && (b.status === 'in_review' || !b.guidelines_approved_at));
  const msg = query.generated != null ? `${query.generated} new draft report${query.generated === '1' ? '' : 's'} created for ${monthLabel(previousMonth().start)}.` : '';
  const body = `<header class="top"><div><h1>Team console</h1><p class="sub">Everything waiting on the First Response team.</p></div>
      <form method="post" action="/team/reports/generate"><button class="btn" type="submit">Create last month’s report drafts</button></form></header>
    <div class="grid2">
      <section class="card"><h2>Guidelines to review (${toReview.length})</h2>
        ${toReview.length ? `<ul class="plain">${toReview.map((b) => `<li><a href="/team/b/${esc(b.id)}">${esc(b.name)}</a> <span class="fine">submitted ${b.guidelines_submitted_at ? ago(b.guidelines_submitted_at) : ''}</span></li>`).join('')}</ul>` : '<p class="note">Nothing waiting.</p>'}</section>
      <section class="card"><h2>Reports to approve (${drafts.length})</h2>
        ${drafts.length ? `<ul class="plain">${drafts.map((r) => `<li><a href="/team/reports/${esc(r.id)}">${esc(name(r.business_id))} · ${esc(monthLabel(r.period_start))}</a></li>`).join('')}</ul>` : '<p class="note">Nothing waiting.</p>'}</section>
    </div>
    <section class="card"><h2>All businesses (${businesses.length})</h2>
      <div class="tablewrap"><table class="play"><thead><tr><th>Business</th><th>Status</th><th>Plan</th><th>Needs client OK</th><th>Approved, to post</th><th>Signed up</th></tr></thead><tbody>
      ${businesses.map((b) => { const [cls, label] = STATUS_LABEL[b.status] || STATUS_LABEL.onboarding; return `<tr><td><a href="/team/b/${esc(b.id)}">${esc(b.name)}</a><br><span class="fine">${esc(b.owner_email || '')}</span></td><td><span class="pill ${cls}">${label}</span></td><td>${esc(b.plan || '—')}</td><td>${count(b.id, 'new')}</td><td>${count(b.id, 'approved')}</td><td>${ago(b.created_at)}</td></tr>`; }).join('') || '<tr><td colspan="6">No businesses yet. Free trial signups from the website appear here.</td></tr>'}
      </tbody></table></div></section>`;
  sendHtml(res, 200, appPage({ title: 'Team console', ctx, active: 'team', body, notice: notice('ok', msg) }));
}

export async function postGenerateAll(req, res) {
  if (!isSameOrigin(req)) return redirect(res, '/team');
  const ctx = await requireStaff(req, res, '/team');
  if (!ctx) return;
  const d = db(ctx.user.token);
  const active = await d.select('businesses', qs({ status: 'eq.active', select: '*' }));
  const created = await generateDrafts(d, active, previousMonth());
  redirect(res, `/team?generated=${created.length}`);
}

async function loadBusiness(d, id) {
  if (!UUID.test(id)) throw new HttpError(404, 'Business not found.');
  const [b] = await d.select('businesses', qs({ id: `eq.${id}`, select: '*' }));
  if (!b) throw new HttpError(404, 'Business not found.');
  return b;
}

export async function getTeamBusiness(req, res, { params, query }) {
  const ctx = await requireStaff(req, res, `/team/b/${params.id}`);
  if (!ctx) return;
  const d = db(ctx.user.token);
  const b = await loadBusiness(d, params.id);
  const [toPost, reports, members] = await Promise.all([
    d.select('reviews', qs({ business_id: `eq.${b.id}`, status: 'eq.approved', select: '*', order: 'replied_at.asc' })),
    d.select('reports', qs({ business_id: `eq.${b.id}`, select: 'id,period_start,status,sent_at', order: 'period_start.desc' })),
    d.select('memberships', qs({ business_id: `eq.${b.id}`, select: 'user_id' })),
  ]);
  const [cls, label] = guidelinesStatus(b);
  const needsApproval = b.guidelines && (b.status === 'in_review' || !b.guidelines_approved_at);
  const msgs = {
    approved: 'Guidelines approved. The client can start receiving replies.', review: 'Review added.', posted: 'Marked as posted.', exists: 'A report for that month already exists.',
    invited: `Set-password email sent to ${b.owner_email}.`,
    reset: `${b.owner_email} already had an account. We linked it to this business and sent a password-reset email.`,
  };
  const errs = {
    limited: 'The email service is at its hourly limit, so nothing was sent. Try again in about an hour, or connect Resend in Supabase’s SMTP settings to raise the limit.',
    noemail: 'This business has no owner email on file.',
    invite: 'The email couldn’t be sent. Check the dashboard logs in Render for details.',
  };
  const access = `<section class="card"><h2>Client login</h2>
      ${members.length ? `<p class="note">${members.length} login${members.length === 1 ? '' : 's'} connected to this business.</p>` : `<p class="note">No one can log in to this business yet. Send ${esc(b.owner_email || 'the owner')} a link to set their password and fill in the questionnaire.</p>`}
      ${b.owner_email ? `<form method="post" action="/team/b/${esc(b.id)}/invite"><button class="btn${members.length ? '' : ' primary'}" type="submit">${members.length ? 'Resend' : 'Send'} set-password email</button></form>` : ''}
    </section>`;
  const body = `<header class="top"><div><p class="fine"><a href="/team">← Team console</a></p><h1>${esc(b.name)}</h1>
      <p class="sub">${esc([b.city, b.plan && `${b.plan} plan`, b.locations && `${b.locations} location(s)`, b.owner_email].filter(Boolean).join(' · '))}</p></div>
      <span class="pill ${cls}">${label}</span></header>
    ${access}
    <section class="card"><h2>Reputation guidelines</h2>
      ${b.guidelines ? `${needsApproval ? `<form method="post" action="/team/b/${esc(b.id)}/approve-guidelines" class="row"><p class="note">Read the guidelines below, then approve to start replies.</p><button class="btn primary" type="submit">Approve guidelines</button></form>` : ''}
      <div class="guide">${renderGuidelines(b)}</div>` : '<p class="note">The client hasn’t finished the questionnaire yet.</p>'}
    </section>
    <div class="grid2">
      <section class="card"><h2>Add a review</h2>
        <p class="note">Until the Google connection is live, paste new reviews here. The client’s rules decide whether the reply is approved automatically or sent to them.</p>
        <form method="post" action="/team/b/${esc(b.id)}/reviews" class="stack">
          <div class="form">
            <div class="field"><label for="platform">Site</label><select id="platform" name="platform">${PLATFORMS.map((p) => `<option>${p}</option>`).join('')}</select></div>
            <div class="field"><label for="rating">Stars</label><select id="rating" name="rating">${[5, 4, 3, 2, 1].map((n) => `<option value="${n}">${n}★</option>`).join('')}</select></div>
            <div class="field"><label for="author">Reviewer name</label><input id="author" name="author" required maxlength="120"></div>
            <div class="field"><label for="posted_at">Posted on</label><input id="posted_at" name="posted_at" type="datetime-local"></div>
          </div>
          <label for="rbody">Review text</label><textarea id="rbody" name="body" rows="4" maxlength="5000"></textarea>
          <button class="btn primary" type="submit">Add review</button>
        </form></section>
      <section class="card"><h2>Approved replies to post (${toPost.length})</h2>
        ${toPost.length ? toPost.map((r) => `<div class="topost"><div class="row"><strong>${esc(r.author)}</strong>${stars(r.rating)}<span class="plat">${esc(r.platform)}</span><span class="meta">${ago(r.posted_at)}</span></div>
          <p class="quote small">“${esc(r.body)}”</p><p class="bubble">${esc(r.reply)}</p>
          <form method="post" action="/team/reviews/${esc(r.id)}/posted"><button class="btn small" type="submit">Mark posted</button></form></div>`).join('') : '<p class="note">Nothing waiting to post.</p>'}
      </section>
    </div>
    <section class="card"><h2>Monthly reports</h2>
      <form method="post" action="/team/b/${esc(b.id)}/reports/generate"><button class="btn" type="submit">Create draft for ${esc(monthLabel(previousMonth().start))}</button></form>
      <ul class="plain">${reports.map((r) => `<li><a href="/team/reports/${esc(r.id)}">${esc(monthLabel(r.period_start))}</a> <span class="pill ${r.status === 'sent' ? 'p-posted' : 'p-needs'}">${r.status === 'sent' ? 'Sent' : 'Draft, needs approval'}</span></li>`).join('') || '<li class="note">No reports yet.</li>'}</ul>
    </section>`;
  const note = errs[query.error] ? notice('error', errs[query.error]) : notice('ok', msgs[query.done] || '');
  sendHtml(res, 200, appPage({ title: b.name, ctx, active: 'team', body, notice: note }));
}

// Sends (or re-sends) the owner a set-password link and connects their login to the business.
export async function postInvite(req, res, { params }) {
  if (!isSameOrigin(req)) return redirect(res, '/team');
  const ctx = await requireStaff(req, res, '/team');
  if (!ctx) return;
  const d = db(ctx.user.token);
  const b = await loadBusiness(d, params.id);
  if (!b.owner_email) return redirect(res, `/team/b/${b.id}?error=noemail`);
  const back = (q) => redirect(res, `/team/b/${b.id}?${q}`);
  try {
    const user = await auth.invite(b.owner_email, {}, `${config.appUrl}/auth/callback`);
    if (user && user.id) await db('service').insert('memberships', { user_id: user.id, business_id: b.id, role: 'owner' }).catch(() => {});
    return back('done=invited');
  } catch (e) {
    if (e.status === 429) return back('error=limited');
    if (e.status !== 422) { console.error('[invite]', e.status, e.message); return back('error=invite'); }
  }
  // Already has an account: link it, then send a password-reset link instead.
  try {
    await d.rpc('link_business_owner', { bid: b.id });
    await auth.recover(b.owner_email, `${config.appUrl}/auth/callback`);
    return back('done=reset');
  } catch (e) {
    if (e.status === 429) return back('error=limited');
    console.error('[invite/reset]', e.status, e.message);
    return back('error=invite');
  }
}

export async function postApproveGuidelines(req, res, { params }) {
  if (!isSameOrigin(req)) return redirect(res, '/team');
  const ctx = await requireStaff(req, res, '/team');
  if (!ctx) return;
  const d = db(ctx.user.token);
  const b = await loadBusiness(d, params.id);
  await d.update('businesses', qs({ id: `eq.${b.id}` }), { status: 'active', guidelines_approved_at: new Date().toISOString() });
  await sendEmail({
    to: b.owner_email,
    subject: 'Your reputation guidelines are approved',
    html: emailShell('You’re all set', `<p>Our team approved the reputation guidelines for ${esc(b.name)}. From now on, every new review gets a reply in your voice, and anything sensitive comes to you first.</p><p><a href="${esc(config.appUrl)}/inbox">Open your dashboard</a></p>`),
  });
  redirect(res, `/team/b/${b.id}?done=approved`);
}

export async function postAddReview(req, res, { params, body }) {
  if (!isSameOrigin(req)) return redirect(res, '/team');
  const ctx = await requireStaff(req, res, '/team');
  if (!ctx) return;
  const d = db(ctx.user.token);
  const b = await loadBusiness(d, params.id);
  const g = guidelinesOrDefault(b);
  const posted = body.posted_at ? new Date(body.posted_at) : new Date();
  const review = {
    business_id: b.id,
    platform: PLATFORMS.includes(body.platform) ? body.platform : 'Google',
    author: String(body.author || '').trim().slice(0, 120) || 'Customer',
    rating: Math.min(5, Math.max(1, parseInt(body.rating, 10) || 5)),
    body: String(body.body || '').trim().slice(0, 5000),
    posted_at: Number.isNaN(posted.getTime()) ? new Date().toISOString() : posted.toISOString(),
  };
  review.flag = flagFor(review, g);
  const auto = b.status === 'active' && b.guidelines_approved_at && ruleFor(review, g) === 'auto' && !['Yelp', 'G2'].includes(review.platform);
  if (auto) Object.assign(review, { status: 'approved', reply: draftForReview(review, g), replied_at: new Date().toISOString() });
  await d.insert('reviews', review);
  if (!auto && b.owner_email && (review.rating <= 3 || review.flag)) {
    await sendEmail({
      to: b.owner_email,
      subject: `New ${review.rating}★ review needs your OK`,
      html: emailShell('A review needs your OK', `<p><strong>${esc(review.author)}</strong> left a ${review.rating}★ review on ${esc(review.platform)}:</p><blockquote style="margin:0;padding:12px;background:#F1ECF8;border-radius:8px">${esc(review.body)}</blockquote><p>A calm reply in your voice is ready. <a href="${esc(config.appUrl)}/inbox">Review and approve it</a>.</p>`),
    });
  }
  redirect(res, `/team/b/${b.id}?done=review`);
}

export async function postMarkPosted(req, res, { params }) {
  if (!isSameOrigin(req)) return redirect(res, '/team');
  const ctx = await requireStaff(req, res, '/team');
  if (!ctx) return;
  if (!UUID.test(params.id)) throw new HttpError(404, 'Review not found.');
  const d = db(ctx.user.token);
  const [r] = await d.update('reviews', qs({ id: `eq.${params.id}`, status: 'eq.approved' }), { status: 'posted' });
  redirect(res, r ? `/team/b/${r.business_id}?done=posted` : '/team');
}

export async function postGenerateOne(req, res, { params }) {
  if (!isSameOrigin(req)) return redirect(res, '/team');
  const ctx = await requireStaff(req, res, '/team');
  if (!ctx) return;
  const d = db(ctx.user.token);
  const b = await loadBusiness(d, params.id);
  const [created] = await generateDrafts(d, [b], previousMonth());
  redirect(res, created ? `/team/reports/${created.report.id}` : `/team/b/${b.id}?done=exists`);
}

async function loadReport(d, id) {
  if (!UUID.test(id)) throw new HttpError(404, 'Report not found.');
  const [r] = await d.select('reports', qs({ id: `eq.${id}`, select: '*' }));
  if (!r) throw new HttpError(404, 'Report not found.');
  const b = await loadBusiness(d, r.business_id);
  return { r, b };
}

export async function getReportEditor(req, res, { params, query }) {
  const ctx = await requireStaff(req, res, `/team/reports/${params.id}`);
  if (!ctx) return;
  const { r, b } = await loadReport(db(ctx.user.token), params.id);
  const sent = r.status === 'sent';
  const ins = [0, 1, 2].map((i) => (r.insights || [])[i] || { title: '', evidence: '', rec: '' });
  const msgs = { saved: 'Draft saved.', sent: emailEnabled() ? `Approved and emailed to ${b.owner_email || 'the client'}.` : 'Approved. It now shows in the client’s dashboard. (Email isn’t set up yet, so no email was sent.)' };
  const body = `<header class="top"><div><p class="fine"><a href="/team/b/${esc(b.id)}">← ${esc(b.name)}</a></p><h1>${esc(monthLabel(r.period_start))} report</h1></div>
      <span class="pill ${sent ? 'p-posted' : 'p-needs'}">${sent ? 'Sent to client' : 'Waiting for team approval'}</span></header>
    <ol class="steps" aria-label="Report workflow">
      <li class="done"><strong>Created automatically</strong><span>${ago(r.created_at)}</span></li>
      <li class="${sent ? 'done' : 'now'}"><strong>Reviewed by our team</strong><span>Edit, then approve</span></li>
      <li class="${sent ? 'done' : ''}"><strong>Emailed to client</strong><span>${esc(b.owner_email || 'no email on file')}</span></li>
    </ol>
    ${sent ? reportHtml(r, b.name) : `
    <form method="post" action="/team/reports/${esc(r.id)}" class="card stack">
      <label for="summary">Summary</label><textarea id="summary" name="summary" rows="3" maxlength="1000">${esc(r.summary)}</textarea>
      ${ins.map((i, n) => `<fieldset class="insightedit"><legend>Insight ${n + 1}</legend>
        <label for="t${n}">Headline</label><input id="t${n}" name="title${n}" maxlength="200" value="${esc(i.title)}">
        <label for="e${n}">Evidence from reviews</label><input id="e${n}" name="evidence${n}" maxlength="300" value="${esc(i.evidence)}">
        <label for="r${n}">Recommendation</label><input id="r${n}" name="rec${n}" maxlength="300" value="${esc(i.rec)}"></fieldset>`).join('')}
      <div class="actions"><button class="btn" type="submit" name="action" value="save">Save draft</button><button class="btn primary" type="submit" name="action" value="send">Approve &amp; email to client</button></div>
      <p class="fine">Stats (${esc(r.stats.reviews)} reviews, ${r.stats.avgRating == null ? 'no rating' : `${esc(r.stats.avgRating)}★`}, ${esc(r.stats.answeredPct)}% answered) are calculated from the reviews and can’t be edited.</p>
    </form>`}`;
  sendHtml(res, 200, appPage({ title: 'Report', ctx, active: 'team', body, notice: notice('ok', msgs[query.done] || '') }));
}

export async function postReport(req, res, { params, body }) {
  if (!isSameOrigin(req)) return redirect(res, '/team');
  const ctx = await requireStaff(req, res, '/team');
  if (!ctx) return;
  const d = db(ctx.user.token);
  const { r, b } = await loadReport(d, params.id);
  if (r.status === 'sent') return redirect(res, `/team/reports/${r.id}`);
  const insights = [0, 1, 2].map((n) => ({
    title: String(body[`title${n}`] || '').trim().slice(0, 200),
    evidence: String(body[`evidence${n}`] || '').trim().slice(0, 300),
    rec: String(body[`rec${n}`] || '').trim().slice(0, 300),
  })).filter((i) => i.title);
  const patch = { summary: String(body.summary || '').trim().slice(0, 1000), insights };
  if (body.action !== 'send') {
    await d.update('reports', qs({ id: `eq.${r.id}` }), patch);
    return redirect(res, `/team/reports/${r.id}?done=saved`);
  }
  const [updated] = await d.update('reports', qs({ id: `eq.${r.id}`, status: 'eq.draft' }), { ...patch, status: 'sent', sent_at: new Date().toISOString(), approved_by: ctx.user.id });
  if (updated) {
    await sendEmail({
      to: b.owner_email,
      subject: `Your ${monthLabel(r.period_start)} review insights`,
      html: emailShell(`${b.name}: ${monthLabel(r.period_start)} insights`, `<p>${esc(updated.summary)}</p>${updated.insights.map((i, n) => `<h3 style="margin:20px 0 4px;font-size:16px">${n + 1}. ${esc(i.title)}</h3><p style="margin:0 0 4px;color:#4A5068">${esc(i.evidence)}</p><p style="margin:0;color:#3A5FB8"><strong>Try this:</strong> ${esc(i.rec)}</p>`).join('')}<p style="margin-top:24px"><a href="${esc(config.appUrl)}/reports/${esc(updated.id)}">See the full report in your dashboard</a></p>`),
    });
  }
  redirect(res, `/team/reports/${r.id}?done=sent`);
}
