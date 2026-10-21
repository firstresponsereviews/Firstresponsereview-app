# First Response dashboard

The client dashboard for First Response. Clients log in from the Webflow **Log in** page, fill in the questionnaire, and then use:

- **Review inbox:** every review with a suggested reply in their voice. They approve it, or copy it for Yelp and G2.
- **Reputation guidelines:** built from their questionnaire answers.
- **Monthly reports:** only the ones your team has approved.

Your team uses the **Team console** to:

- approve guidelines,
- add reviews (until the Google connection is approved),
- mark replies as posted,
- edit and send monthly reports.

It's plain Node.js with **no packages to install**, using Supabase for logins and data. Tested with `npm test` (31 tests).

## How the pieces connect

```
Webflow site ──"Start free trial" form──▶ Webflow webhook ──▶ /api/webflow/form ──▶ creates business + emails a set-password link
Webflow site ──"Log in" form (email + password)────────────▶ /auth/login ─────────▶ dashboard
Dashboard ◀────────────────────────────────────────────────▶ Supabase (logins + database, each business sees only its own data)
Render cron (1st of the month) ─────────────────────────────▶ /api/cron/monthly-reports ─▶ draft reports ─▶ team approves ─▶ emailed to client
```

## Set it up (about 30 minutes)

### 1. Supabase (logins and database)
1. Create a free project at supabase.com.
2. **SQL Editor → New query**, paste all of `supabase/schema.sql`, click **Run**.
3. **Authentication → Sign In / Providers → Email:** turn **off** “Allow new users to sign up”. Clients only get accounts through the free-trial form, and invites still work.
4. **Authentication → URL Configuration:**
   - **Site URL:** your dashboard address (step 3 below).
   - **Redirect URLs:** add `https://YOUR-DASHBOARD-ADDRESS/auth/callback`.
5. **Authentication → Emails → SMTP Settings:** connect Resend (step 2). Supabase's built-in sender only allows a few emails an hour.
6. **Project Settings → API:** copy the Project URL, the `anon` key and the `service_role` key. Keep the service key secret.

### 2. Resend (email)
1. Create an account at resend.com and verify the domain you'll send from.
2. Create an API key. Use it here as `RESEND_API_KEY`, and in Supabase's SMTP settings (host `smtp.resend.com`, user `resend`, password = the API key).

### 3. Put it online with Render
1. Put this folder in a private GitHub repository.
2. On render.com: **New → Blueprint**, pick the repo. It reads `render.yaml` and creates the dashboard plus the monthly report job.
3. Fill in the settings it asks for:
   - **APP_URL:** the address Render gives you, e.g. `https://first-response-dashboard.onrender.com`, or your own like `https://app.yourdomain.com`.
   - **SUPABASE_URL**, **SUPABASE_ANON_KEY**, **SUPABASE_SERVICE_ROLE_KEY:** from step 1.
   - **RESEND_API_KEY**, and **EMAIL_FROM** (e.g. `First Response <hello@yourdomain.com>`).
   - Leave the rest as they are. `WEBFLOW_WEBHOOK_KEY` and `CRON_SECRET` are generated for you.
4. Open `APP_URL/healthz`. It should say `{"ok":true}`.

### 4. Make yourself staff
1. In Supabase, go to **Authentication → Users → Invite user** and enter your email. Click the link in the email and set a password.
2. In the **SQL Editor**, run (with your email):
   ```sql
   update public.profiles set role = 'staff'
    where id = (select id from auth.users where email = 'kaitlyn@beyondsmm.com');
   ```
3. Log in. You'll land on the Team console.

### 5. Connect Webflow
Send Claude your `APP_URL` and `WEBFLOW_WEBHOOK_KEY`, and it will make both changes below. Or do them yourself:
- **Log in page:** in the code embed on `/login`, set `APP_LOGIN_URL` to `https://YOUR-DASHBOARD-ADDRESS/auth/login`. Point the “Forgot password?” link to `/forgot-password` on the dashboard.
- **Form webhook:** in Webflow, create a `form_submission` webhook to `https://YOUR-DASHBOARD-ADDRESS/api/webflow/form?key=YOUR_WEBFLOW_WEBHOOK_KEY`.
  - Free-trial signups become accounts.
  - Contact-form messages are emailed to `TEAM_EMAIL`.
  - If you create the webhook with your own Site API token, Webflow returns a signing secret. Put it in `WEBFLOW_WEBHOOK_SECRET` to have signatures checked too.

### 6. Test it end to end
1. Submit the free-trial form on the website with a test email.
2. The test email gets a “set your password” link, and `TEAM_EMAIL` gets a “New free trial” email.
3. Set the password, then answer the questionnaire.
4. In the Team console, approve the guidelines, then add a 1★ review.
5. As the client, approve the suggested reply in the inbox.
6. In the Team console, open the business and click **Create draft**. Edit the report, then **Approve & email**.

## Try it on your computer without Supabase

```
node test/demo-server.js
```

This runs the dashboard with sample data.
- **Client login:** `maria@casaluna.example` / `demo-pass-123`
- **Staff login:** `team@firstresponse.example` / `demo-pass-123`

Run the tests with `npm test`.

## Security built in
- Passwords go straight to Supabase; the dashboard never stores them.
- Sessions are kept in secure, HttpOnly cookies. Every page re-checks the session with Supabase.
- The login endpoint only accepts forms from the dashboard itself and your Webflow site.
- Every other action must come from the dashboard itself.
- Database rules (row-level security) mean a client can only ever read their own business. Clients only see reports after your team sends them.
- Login and password-reset attempts are rate-limited. Reset requests never reveal whether an email has an account.
- Replies with a client's never-say phrases are blocked on the server, not just in the browser.
- Reviews that mention illness, legal threats, discrimination or refunds are never approved automatically.

## Not built yet
- **Google Business Profile and Trustpilot connections:** pull new reviews and post approved replies automatically. This needs Google's API access approval. Until then, staff add reviews and post approved replies by hand from the Team console.
- **Text-message alerts:** needs Twilio. Alerts are email for now.
- **Stripe billing** for when trials end.
- **Agency workspace and white-label branding.**

## Files
- `server.js`: routes and the web server
- `routes/`: pages (`auth.js`, `app.js`, `team.js`) and background endpoints (`webhooks.js`)
- `lib/`: Supabase client, sessions, guidelines, monthly report builder, email, optional Claude rewrites
- `public/shared/replies.js`: reply-writing rules, used by both the server and the questionnaire preview
- `supabase/schema.sql`: database tables, access rules and functions
- `test/`: tests, the Supabase stand-in, and the demo server
