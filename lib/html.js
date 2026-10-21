// HTML escaping and the two page shells (signed-out pages, and the dashboard).
import { config } from './config.js';

export function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const head = (title) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${esc(title)} · First Response</title>
<link rel="icon" href="/static/favicon.png" type="image/png">
<link rel="apple-touch-icon" href="/static/webclip.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Jost:wght@500;600;700&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,700&display=swap">
<link rel="stylesheet" href="/static/app.css">
</head>`;

const brand = `<a class="brand" href="${esc(config.marketingSite)}"><img src="/static/icon.png" alt="" width="36" height="36"><b>FIRST<br>RESPONSE</b></a>`;

export function publicPage({ title, body }) {
  return `${head(title)}
<body class="public">
<header class="public-top">${brand}<a class="linkish" href="${esc(config.marketingSite)}">Back to website</a></header>
<main class="public-main">${body}</main>
</body></html>`;
}

const NAV = [
  ['inbox', '/inbox', 'Review inbox'],
  ['guidelines', '/guidelines', 'Reputation guidelines'],
  ['reports', '/reports', 'Monthly reports'],
];

export function appPage({ title, ctx, active, body, scripts = [], notice = '' }) {
  const { user, businesses, current, isStaff } = ctx;
  const nav = NAV.filter(() => current).map(([key, href, label]) =>
    `<a href="${href}"${active === key ? ' aria-current="page"' : ''}>${label}${key === 'inbox' && ctx.needsCount ? ` <span class="count">${ctx.needsCount}</span>` : ''}</a>`).join('');
  const team = isStaff ? `<a href="/team"${active === 'team' ? ' aria-current="page"' : ''}>Team console</a>` : '';
  const switcher = businesses.length > 1 ? `
    <form method="post" action="/switch-business" class="switcher">
      <label for="biz">Business</label>
      <select id="biz" name="business_id" data-autosubmit>${businesses.map((b) => `<option value="${esc(b.id)}"${current && b.id === current.id ? ' selected' : ''}>${esc(b.name)}</option>`).join('')}</select>
      <noscript><button class="btn small" type="submit">Switch</button></noscript>
    </form>` : current ? `<div class="bizname"><span class="fine">Business</span><strong>${esc(current.name)}</strong></div>` : '';
  return `${head(title)}
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="app">
  <aside class="side">
    ${brand}
    <nav aria-label="Dashboard">${nav}${team}</nav>
    <div class="side-foot">
      ${switcher}
      <div class="account"><span class="fine">${esc(user.email)}</span>
        <form method="post" action="/auth/logout"><button class="linkish" type="submit">Log out</button></form></div>
    </div>
  </aside>
  <main id="main">
    ${notice}
    ${body}
  </main>
</div>
<script src="/static/js/app.js" type="module"></script>
${scripts.map((s) => `<script src="${esc(s)}" type="module"></script>`).join('\n')}
</body></html>`;
}

export function notice(kind, text) {
  return text ? `<p class="notice ${kind}" role="status">${esc(text)}</p>` : '';
}

export function stars(n) {
  const r = Math.max(0, Math.min(5, Number(n) || 0));
  return `<span class="stars" aria-label="${r} out of 5 stars">${'★'.repeat(r)}<span class="off">${'★'.repeat(5 - r)}</span></span>`;
}

export function ago(iso) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)} hr ago`;
  const days = Math.round(mins / 1440);
  return days < 60 ? `${days} day${days === 1 ? '' : 's'} ago` : new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
