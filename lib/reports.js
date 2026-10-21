// Builds a draft Monthly Insights Report from a business's reviews.
// Drafts always wait in the team console for a person to edit and approve.

const THEMES = {
  quality: { label: 'Product and food quality', words: ['delicious', 'tasty', 'fresh', 'quality', 'flavor', 'food', 'coffee', 'cut', 'color', 'result', 'works great', 'product'] },
  staff: { label: 'Staff and service', words: ['staff', 'friendly', 'rude', 'server', 'waiter', 'stylist', 'technician', 'team', 'service', 'helpful', 'remembered'] },
  wait: { label: 'Wait times', words: ['wait', 'waited', 'slow', 'took forever', 'long time', 'late', 'nobody checked'] },
  value: { label: 'Price and value', words: ['price', 'pricey', 'expensive', 'value', 'portion', 'worth', 'overpriced', 'cheap'] },
  cleanliness: { label: 'Cleanliness', words: ['clean', 'dirty', 'filthy', 'smell', 'bathroom', 'hair in'] },
  parking: { label: 'Parking and access', words: ['parking', 'park ', 'hard to find', 'location'] },
  ambience: { label: 'Atmosphere', words: ['patio', 'cozy', 'atmosphere', 'ambience', 'music', 'decor', 'vibe'] },
  booking: { label: 'Booking and scheduling', words: ['appointment', 'booking', 'booked', 'schedule', 'reschedul', 'no-show', "didn't show"] },
  billing: { label: 'Billing and refunds', words: ['charged', 'billing', 'refund', 'invoice', 'double charge', 'overcharg', 'subscription'] },
  support: { label: 'Support and responsiveness', words: ['support', 'emails', 'response', 'responded', 'call back', 'no reply'] },
};

const FIX = {
  quality: 'Look at the specific items or results people mention and check consistency with the team this month.',
  staff: 'Talk with the team about the moments customers describe and agree on one service standard to fix.',
  wait: 'Check on waiting customers at a set point (for example, at 10 minutes) during your busiest hours, and tell people how long the wait will be.',
  value: 'Make prices and portion sizes clear before people buy, and point customers to your best-value options.',
  cleanliness: 'Add a quick cleanliness check to opening and peak-hour routines.',
  parking: 'Add clear parking and arrival tips to your Google profile and website contact page.',
  ambience: 'Ask a few regulars what would make the space more comfortable, and fix the quick wins.',
  booking: 'Make booking and rescheduling easy to find, and confirm appointments by text the day before.',
  billing: 'Review your billing flow for the issues mentioned and give your team a clear refund timeline to share.',
  support: 'Set a target response time for customer emails and calls, and tell customers what it is.',
};

const KEEP = {
  quality: 'Feature what customers praise most in your photos, posts and Google profile.',
  staff: 'Share these shout-outs with your team and thank the people customers name.',
  wait: 'Mention quick service in your Google profile description; customers notice it.',
  value: 'Highlight your value in your Google profile and website — it is a reason people choose you.',
  cleanliness: 'Keep up the routines that make the space feel clean; customers notice.',
  parking: 'Keep your parking tips up to date on your profile.',
  ambience: 'Show your space in your photos; it is part of why people choose you.',
  booking: 'Keep booking as easy as it is now, and ask happy customers for honest reviews.',
  billing: 'Keep billing simple and transparent; customers mention it.',
  support: 'Keep your response times where they are; customers notice fast support.',
};

// Themes people only raise when something goes wrong are never reported as praise.
const COMPLAINT_ONLY = new Set(['wait', 'parking', 'billing', 'cleanliness']);

const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

export function themeCounts(reviews) {
  const counts = {};
  for (const key of Object.keys(THEMES)) counts[key] = { pos: 0, neg: 0 };
  for (const r of reviews) {
    const t = ` ${String(r.body || '').toLowerCase()} `;
    for (const [key, theme] of Object.entries(THEMES)) {
      if (theme.words.some((w) => t.includes(w))) counts[key][Number(r.rating) >= 4 ? 'pos' : 'neg'] += 1;
    }
  }
  return counts;
}

export function reviewStats(reviews) {
  const answered = reviews.filter((r) => r.status === 'approved' || r.status === 'posted');
  const replyMins = answered.filter((r) => r.replied_at && r.posted_at)
    .map((r) => Math.max(0, Math.round((new Date(r.replied_at) - new Date(r.posted_at)) / 60000)));
  const avg = reviews.length ? reviews.reduce((s, r) => s + Number(r.rating), 0) / reviews.length : null;
  return {
    reviews: reviews.length,
    avgRating: avg == null ? null : Math.round(avg * 10) / 10,
    answeredPct: pct(answered.length, reviews.length),
    medianReplyMin: median(replyMins),
  };
}

export function formatMinutes(m) {
  if (m == null) return '—';
  if (m < 60) return `${m} min`;
  if (m < 2880) return `${Math.round(m / 60)} hr`;
  return `${Math.round(m / 1440)} days`;
}

export function previousMonth(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const iso = (d) => d.toISOString().slice(0, 10);
  return { start: iso(start), end: iso(end) };
}

export function buildReportDraft(business, reviews, period) {
  const stats = reviewStats(reviews);
  const counts = themeCounts(reviews);
  const n = reviews.length;
  // A theme counts as a complaint only when it comes up in more bad reviews than good ones,
  // and the same theme is never both the top complaint and the top praise.
  const byNeg = Object.entries(counts).filter(([, c]) => c.neg > 0 && c.neg >= c.pos)
    .sort((a, b) => (b[1].neg - b[1].pos) - (a[1].neg - a[1].pos) || b[1].neg - a[1].neg);
  const negKeys = new Set(byNeg.slice(0, 2).map(([k]) => k));
  const byPos = Object.entries(counts).filter(([k, c]) => c.pos > 0 && c.pos > c.neg && !negKeys.has(k) && !COMPLAINT_ONLY.has(k))
    .sort((a, b) => b[1].pos - a[1].pos);
  const insights = [];
  if (n === 0) {
    insights.push({
      title: 'No new reviews this month.',
      evidence: 'Fresh reviews keep your profile current and help you show up in local search.',
      rec: 'Ask every customer for an honest review by text or email after their visit — ask everyone, not just happy customers, and never offer anything in return.',
    });
  }
  if (byNeg[0]) {
    const [key, c] = byNeg[0];
    insights.push({ title: `${THEMES[key].label} is the top complaint.`, evidence: `${c.neg} of ${n} reviews this month mention ${THEMES[key].label.toLowerCase()} in a negative way.`, rec: FIX[key] });
  }
  if (byPos[0]) {
    const [key, c] = byPos[0];
    insights.push({ title: `${THEMES[key].label} is what customers love most.`, evidence: `${c.pos} of ${n} reviews (${pct(c.pos, n)}%) praise ${THEMES[key].label.toLowerCase()}.`, rec: KEEP[key] });
  }
  if (byNeg[1]) {
    const [key, c] = byNeg[1];
    insights.push({ title: `Watch ${THEMES[key].label.toLowerCase()}.`, evidence: `${c.neg} of ${n} reviews raise it.`, rec: FIX[key] });
  }
  if (n > 0 && insights.length < 3) {
    insights.push({
      title: stats.answeredPct === 100 ? 'Every review got a reply.' : `${stats.answeredPct}% of reviews got a reply.`,
      evidence: `Median time to first reply: ${formatMinutes(stats.medianReplyMin)}.`,
      rec: stats.answeredPct === 100 ? 'Keep asking every customer for an honest review — more reviews strengthen your Google profile.' : 'Approve waiting replies from your inbox so every customer hears back.',
    });
  }
  const rating = stats.avgRating == null ? 'no rating yet' : `an average of ${stats.avgRating}★`;
  const summary = n
    ? `${business.name} received ${n} review${n === 1 ? '' : 's'} with ${rating}, and ${stats.answeredPct}% got a reply.${byNeg[0] ? ` The main thing to fix is ${THEMES[byNeg[0][0]].label.toLowerCase()}.` : ''}`
    : `${business.name} received no new reviews this month. Asking every customer for an honest review is the quickest way to grow your profile.`;
  return {
    business_id: business.id,
    period_start: period.start,
    period_end: period.end,
    status: 'draft',
    summary,
    stats,
    insights: insights.slice(0, 3),
  };
}

export function monthLabel(isoDate) {
  return new Date(`${isoDate}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
