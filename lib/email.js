// Email through Resend's HTTP API. Without RESEND_API_KEY, emails are skipped and logged.
import { config } from './config.js';
import { esc } from './html.js';

export const emailEnabled = () => Boolean(config.resendKey);

export async function sendEmail({ to, subject, html, replyTo }) {
  const recipients = [].concat(to || []).filter(Boolean);
  if (!recipients.length) return { sent: false, reason: 'no recipient' };
  if (!config.resendKey) {
    console.log(`[email skipped: RESEND_API_KEY not set] to=${recipients.join(',')} subject="${subject}"`);
    return { sent: false, reason: 'email not configured' };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: config.emailFrom, to: recipients, subject, html, ...(replyTo ? { reply_to: replyTo } : {}) }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`[email failed] ${res.status} ${text.slice(0, 300)}`);
    return { sent: false, reason: `email provider error ${res.status}` };
  }
  return { sent: true };
}

export function emailShell(title, inner) {
  return `<!doctype html><html><body style="margin:0;background:#FBF8F4;font-family:Arial,Helvetica,sans-serif;color:#232845">
<div style="max-width:600px;margin:0 auto;padding:32px 20px">
<p style="font-weight:700;letter-spacing:.06em;color:#B05A20;margin:0 0 24px">FIRST RESPONSE</p>
<h1 style="font-size:24px;line-height:1.2;margin:0 0 16px">${esc(title)}</h1>
${inner}
<p style="font-size:12px;color:#5B6275;margin-top:32px">First Response · The first to respond to your reviews</p>
</div></body></html>`;
}

export function fieldsTable(obj) {
  return `<table style="border-collapse:collapse;width:100%;font-size:14px">${Object.entries(obj).map(([k, v]) =>
    `<tr><td style="padding:8px;border-bottom:1px solid #E6E0EC;font-weight:700;vertical-align:top;width:35%">${esc(k)}</td><td style="padding:8px;border-bottom:1px solid #E6E0EC;white-space:pre-wrap">${esc(v)}</td></tr>`).join('')}</table>`;
}
