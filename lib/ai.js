// Optional: rewrite a suggested reply with Claude when ANTHROPIC_API_KEY is set.
// Every rewrite still goes through the same approval rules; nothing posts on its own.
import { config } from './config.js';
import { contactLine } from '../public/shared/replies.js';

export const aiEnabled = () => Boolean(config.anthropicKey);

export async function aiReply(review, g, tone) {
  if (!config.anthropicKey) return null;
  const v = g.voice || {};
  const system = [
    `You write public replies to online reviews for ${g.business.name || 'a local business'}, a ${g.business.industry || 'business'}.`,
    `Voice: ${(v.words || []).join(', ') || 'warm'}. Formality ${v.formality}/5. Keep it under 80 words. Tone requested: ${tone || 'default'}.`,
    `Sign off exactly as: ${v.sign || g.contact.manager || 'The team'}.`,
    `For reviews of 3 stars or fewer: thank them, name and own the specific problem, and ${contactLine(g)}.`,
    'Never offer discounts, refunds, freebies or anything of value in the reply. Never ask the reviewer to change or remove the review.',
    'Never argue, never share private details, never confirm someone was a patient or client.',
    v.never ? `Never use these phrases: ${v.never}.` : '',
    v.emoji === 'five' ? 'You may use one emoji only on 5-star reviews.' : 'Do not use emojis.',
    'Reply with the reply text only.',
  ].filter(Boolean).join('\n');
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': config.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.anthropicModel,
        max_tokens: 400,
        system,
        messages: [{ role: 'user', content: `${review.rating}-star review from ${review.author} on ${review.platform}:\n\n${review.body}` }],
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) { console.error(`[ai] ${res.status} ${(await res.text()).slice(0, 200)}`); return null; }
    const data = await res.json();
    const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    return text || null;
  } catch (e) {
    console.error('[ai] request failed', e.message);
    return null;
  }
}
