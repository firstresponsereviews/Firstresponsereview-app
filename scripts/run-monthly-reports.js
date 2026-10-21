// Called by the monthly cron job: asks the dashboard to create last month's report drafts.
const url = `${(process.env.APP_URL || '').replace(/\/$/, '')}/api/cron/monthly-reports`;
const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } });
const text = await res.text();
console.log(res.status, text);
if (!res.ok) process.exit(1);
