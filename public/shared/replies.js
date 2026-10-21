// Reply-writing rules shared by the server and the browser (onboarding preview).
// Plain ES module with no dependencies so both sides run the exact same logic.

export const PLATFORMS = ['Google', 'Yelp', 'Trustpilot', 'G2'];

// Sites where only the business itself may post a reply: we write it, the client pastes it.
export const ASSISTED = {
  Yelp: 'Yelp only lets the business post replies itself, so copy this reply and paste it in the Yelp for Business app.',
  G2: 'G2 replies are posted from your my.G2 vendor account, so copy this reply and paste it there.',
};

export const ESCALATION_TOPICS = {
  'Illness, injury or food safety': 'health',
  'Legal threats': 'legal',
  'Discrimination': 'discrimination',
  'Refund requests': 'refund',
};

const TOPIC_WORDS = {
  wait: ['wait', 'waited', 'slow', 'took forever', 'long time', 'nobody checked'],
  health: ['sick', 'ill', 'food poisoning', 'injur', 'hurt', 'allerg', 'hair in', 'bug', 'raw', 'vomit', 'unsafe'],
  legal: ['lawyer', 'attorney', 'sue', 'lawsuit', 'legal action', 'small claims', 'report you'],
  discrimination: ['racist', 'discriminat', 'sexist', 'homophob', 'because i am', 'because i\'m'],
  refund: ['refund', 'money back', 'charged twice', 'double charge', 'overcharg'],
  billing: ['charged', 'billing', 'invoice', 'subscription', 'renewal'],
  value: ['pricey', 'expensive', 'overpriced', 'portion', 'price'],
  staff: ['staff', 'server', 'waiter', 'waitress', 'stylist', 'technician', 'team', 'rude'],
  parking: ['parking', 'park '],
  cleanliness: ['dirty', 'clean', 'filthy', 'smell'],
};

const ISSUE_PHRASES = {
  health: 'what you experienced',
  legal: 'your experience',
  discrimination: 'how you were treated',
  billing: 'the billing problem and the slow reply from our team',
  refund: 'the problem with your payment',
  wait: 'the long wait',
  value: 'the value you got for the price',
  cleanliness: 'the cleanliness issue you noticed',
  staff: 'how our team treated you',
  parking: 'the trouble with parking',
};

export function detectTopics(text) {
  const t = ` ${String(text || '').toLowerCase()} `;
  return Object.keys(TOPIC_WORDS).filter((k) => TOPIC_WORDS[k].some((w) => t.includes(w)));
}

// Returns a usable first name, or '' when the reviewer name isn't a real name.
export function firstName(name) {
  const s = String(name || '').trim();
  if (!s || /user|anonymous|customer|guest|reviewer/i.test(s)) return '';
  return s.split(/[\s,]+/)[0];
}

export function defaultGuidelines(business = {}) {
  return {
    business: { name: business.name || '', industry: 'Restaurant or café', city: business.city || '', locations: business.locations || '1', platforms: ['Google'] },
    contact: { manager: '', role: 'Owner', phone: business.phone || '', email: '', callback: 'the same day', method: 'call' },
    offers: { items: ['apology'], pct: '', refund: '', decide: 'manager' },
    voice: { formality: 2, length: 3, words: ['warm'], sign: '', emoji: 'never', love: '', never: '' },
    rules: { r5: 'auto', r4: 'auto', r3: 'ask', r12: 'ask', escalate: Object.keys(ESCALATION_TOPICS), thankStaff: true, starOnly: true, spanish: false, healthPrivacy: false },
  };
}

export function toneOf(g) {
  const v = (g && g.voice) || {};
  if (Number(v.formality) >= 4) return 'formal';
  if (Number(v.length) <= 2) return 'brief';
  return 'warm';
}

export function contactLine(g) {
  const c = (g && g.contact) || {};
  const who = firstName(c.manager) || 'our manager';
  if (c.method === 'call' && c.phone) return `please call or text ${who} directly at ${c.phone}`;
  if (c.method === 'number' && c.email) return `please send your phone number to ${c.email} and ${who} will call you ${c.callback || 'soon'}`;
  if (c.email) return `please email us at ${c.email}`;
  if (c.phone) return `please call us at ${c.phone}`;
  return 'please reach out to us directly';
}

function signOff(g) {
  const v = (g && g.voice) || {};
  return v.sign || (g && g.contact && g.contact.manager) || (g && g.business && g.business.name) || 'The team';
}

export function replyText(g, { name, rating, issue = 'your experience', extra = '', tone } = {}) {
  g = g || defaultGuidelines();
  tone = tone || toneOf(g);
  const v = g.voice || {};
  const n = firstName(name);
  const sign = signOff(g);
  const words = v.words || [];
  const love = String(v.love || '').toLowerCase();
  const biz = (g.business && g.business.name) || 'us';

  if (Number(rating) >= 4) {
    const emo = v.emoji === 'five' && Number(rating) === 5 ? ' 🙌' : '';
    const close = love.includes('see you soon') ? 'See you soon!' : 'We can’t wait to see you again.';
    if (tone === 'brief') return `Thank you${n ? ', ' + n : ''}! So glad you enjoyed it.${extra}${emo} — ${sign}`;
    if (tone === 'formal') return `Thank you for your review${n ? ', ' + n : ''}. We appreciate you choosing ${biz} and look forward to welcoming you back.${extra} — ${sign}`;
    const lead = n ? `${n}, thank you so much!` : 'Thank you so much!';
    const mid = words.includes('playful') ? ' You just made the whole team’s day.' : ' Reviews like yours mean a lot to our team.';
    return `${lead}${mid}${extra} ${close}${emo} — ${sign}`;
  }

  const ask = contactLine(g);
  const Ask = ask.charAt(0).toUpperCase() + ask.slice(1);
  if (tone === 'brief') return `${n ? n + ', thank' : 'Thank'} you for telling us about ${issue}. That’s not our standard. ${Ask} so we can make it right. — ${sign}`;
  if (tone === 'formal') return `Thank you for your feedback${n ? ', ' + n : ''}. We take ${issue} seriously and have shared your review with our team. ${Ask} so we can resolve this directly. — ${sign}`;
  return `${n ? n + ', thank' : 'Thank'} you for letting us know, and I’m sorry about ${issue}. That isn’t the experience we want for anyone. I’d love to make it right — ${ask}. — ${sign}`;
}

export function issueFor(topics, g) {
  const privacy = g && g.rules && g.rules.healthPrivacy;
  if (privacy) return 'your experience';
  const order = ['health', 'discrimination', 'legal', 'billing', 'refund', 'wait', 'cleanliness', 'staff', 'value', 'parking'];
  const hit = order.find((k) => topics.includes(k));
  return hit ? ISSUE_PHRASES[hit] : 'your experience';
}

export function draftForReview(review, g, tone) {
  const topics = detectTopics(review.body);
  const extra = Number(review.rating) >= 4 && g && g.rules && g.rules.thankStaff && topics.includes('staff')
    ? ' We’ll make sure the team hears this.' : '';
  return replyText(g, { name: review.author, rating: review.rating, issue: issueFor(topics, g), extra, tone });
}

// Escalation flag: returns a short reason string, or null.
export function flagFor(review, g) {
  const topics = detectTopics(review.body);
  const chosen = (g && g.rules && g.rules.escalate) || Object.keys(ESCALATION_TOPICS);
  for (const label of chosen) {
    const topic = ESCALATION_TOPICS[label];
    if (topic && topics.includes(topic)) return `Mentions ${label.toLowerCase()} — never posted automatically.`;
  }
  return null;
}

// What the client's rules say to do with a new review: 'auto' (post without asking) or 'ask'.
export function ruleFor(review, g) {
  const r = (g && g.rules) || {};
  const rating = Number(review.rating);
  if (flagFor(review, g)) return 'ask';
  if (rating === 5) return r.r5 === 'auto' ? 'auto' : 'ask';
  if (rating === 4) return r.r4 === 'auto' ? 'auto' : 'ask';
  return 'ask';
}

export function bannedPhrases(text, never) {
  const t = String(text || '').toLowerCase();
  return String(never || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).filter((p) => t.includes(p));
}

export function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}
