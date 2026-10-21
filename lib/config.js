// All settings come from environment variables. See .env.example.
const env = process.env;
const list = (v) => String(v || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
const port = Number(env.PORT || 3000);

export const config = {
  port,
  appUrl: (env.APP_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  supabaseUrl: (env.SUPABASE_URL || '').replace(/\/$/, ''),
  anonKey: env.SUPABASE_ANON_KEY || '',
  serviceKey: env.SUPABASE_SERVICE_ROLE_KEY || '',
  // The marketing site(s) allowed to post the login form to this app.
  webflowOrigins: list(env.WEBFLOW_SITE_URL || 'https://first-response-reviews.webflow.io'),
  webflowSecret: env.WEBFLOW_WEBHOOK_SECRET || '',
  // Alternative to the signature: a long random key in the webhook URL (?key=...).
  webflowUrlKey: env.WEBFLOW_WEBHOOK_KEY || '',
  resendKey: env.RESEND_API_KEY || '',
  emailFrom: env.EMAIL_FROM || 'First Response <hello@example.com>',
  teamEmail: env.TEAM_EMAIL || '',
  anthropicKey: env.ANTHROPIC_API_KEY || '',
  anthropicModel: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
  cronSecret: env.CRON_SECRET || '',
};

config.appOrigin = new URL(config.appUrl).origin;
config.secureCookies = config.appUrl.startsWith('https://');
config.marketingSite = config.webflowOrigins[0] || config.appUrl;
config.allowedLoginOrigins = [config.appOrigin, ...config.webflowOrigins.map((u) => new URL(u).origin)];

export function missingConfig() {
  return ['APP_URL', 'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'].filter((k) => !env[k]);
}
