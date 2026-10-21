// Runs the dashboard locally against the stand-in Supabase with sample data,
// so you can click around without a Supabase project:  node test/demo-server.js
// Log in as maria@casaluna.example / demo-pass-123 (client) or team@firstresponse.example / demo-pass-123 (staff).
import { startStack, ANSWERS } from './helpers.js';

// Start first so the app reads the demo settings, then load the app's modules.
const { mock, appUrl } = await startStack();
const { normalizeGuidelines } = await import('../lib/guidelines.js');
const { draftForReview } = await import('../public/shared/replies.js');
const { buildReportDraft, previousMonth } = await import('../lib/reports.js');
const t = mock.state.tables;
mock.addUser('team@firstresponse.example', 'demo-pass-123', { full_name: 'Kaitlyn' }, 'staff');
const maria = mock.addUser('maria@casaluna.example', 'demo-pass-123', { full_name: 'Maria Delgado' });
const g = normalizeGuidelines(ANSWERS);
const now = Date.now();
const iso = (minsAgo) => new Date(now - minsAgo * 60000).toISOString();

const casa = { id: 'a1111111-1111-4111-8111-111111111111', name: 'Casa Luna Taquería', city: 'San Diego, CA', plan: 'Pro', locations: '1', owner_email: 'maria@casaluna.example', status: 'active', guidelines: g, guidelines_submitted_at: iso(60 * 24 * 40), guidelines_approved_at: iso(60 * 24 * 39), created_at: iso(60 * 24 * 41) };
const ledger = { id: 'b2222222-2222-4222-8222-222222222222', name: 'Ledgerly', city: 'Remote', plan: 'Concierge', locations: '1', owner_email: 'sam@ledgerly.example', status: 'in_review', guidelines: normalizeGuidelines({ ...ANSWERS, business_name: 'Ledgerly', industry: 'Software', platforms: ['Trustpilot', 'G2'], manager: 'Sam Ortiz', role: 'Customer Success Lead', sign: 'Sam, Customer Success', formality: '4', words: ['professional', 'calm'] }), guidelines_submitted_at: iso(90), guidelines_approved_at: null, created_at: iso(60 * 24 * 2) };
const fresh = { id: 'c3333333-3333-4333-8333-333333333333', name: 'Bloom Hair Studio', city: 'North Park, San Diego', plan: 'Starter', locations: '1', owner_email: 'ana@bloom.example', status: 'onboarding', guidelines: null, created_at: iso(30) };
t.businesses.push(casa, ledger, fresh);
t.memberships.push({ user_id: maria.id, business_id: casa.id, role: 'owner' });

const reviews = [
  ['Dana R.', 'Google', 1, 6, 'Waited 40 minutes for our food and nobody checked on us once. Tacos were good when they finally came, but the service ruined the night.', 'new'],
  ['Jordan M.', 'Google', 5, 14, 'Best carnitas in North Park, hands down. Staff remembered my order from last week!', 'posted'],
  ['Priya S.', 'Yelp', 4, 38, 'Really fresh salsas and great horchata. Parking is tough on a Friday night, so plan ahead.', 'new'],
  ['Marcus T.', 'Google', 2, 95, 'Found a hair in my burrito. The cashier gave me a refund but I got sick later that night.', 'new'],
  ['Elena V.', 'Google', 5, 180, 'Family dinner for 8 and they handled it perfectly. Kids loved the churros.', 'approved'],
  ['Aisha B.', 'Google', 5, 420, 'The al pastor is incredible and the patio is so cozy at night.', 'posted'],
  ['Sam K.', 'Yelp', 3, 1300, 'Food was solid but a bit pricey for the portion size. Friendly staff though.', 'posted'],
  ['Chris L.', 'Google', 4, 2900, 'Quick lunch, great value. Would love more vegetarian options.', 'posted'],
];
for (const [author, platform, rating, ago, body, status] of reviews) {
  const r = { id: crypto.randomUUID(), business_id: casa.id, platform, author, rating, body, posted_at: iso(ago), status, flag: null, reply: null, replied_at: null, created_at: iso(ago) };
  if (status !== 'new') Object.assign(r, { reply: draftForReview(r, g), replied_at: iso(ago - 12) });
  t.reviews.push(r);
}
const pm = previousMonth();
const past = t.reviews.map((r) => ({ ...r, posted_at: `${pm.start}T18:00:00Z`, replied_at: r.replied_at && `${pm.start}T18:12:00Z` }));
const report = { id: crypto.randomUUID(), ...buildReportDraft(casa, past, pm), status: 'sent', sent_at: iso(60 * 24 * 3), created_at: iso(60 * 24 * 4) };
const draft = { id: crypto.randomUUID(), ...buildReportDraft(ledger, [], pm), created_at: iso(60) };
t.reports.push(report, draft);

console.log(`Demo dashboard: ${appUrl}/login`);
console.log('Client: maria@casaluna.example / demo-pass-123');
console.log('Staff:  team@firstresponse.example / demo-pass-123');
