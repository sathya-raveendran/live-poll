# Live poll

A lightweight, Menti-style live polling app. The audience scans a QR code and votes from their phones with no sign-in, and results update live on the presenter screen.

- **Hosting:** static pages on GitHub Pages, with data in Supabase (Postgres). Both are on free plans.
- **Question types:** multiple choice (bar chart), rating scale (columns plus average), and word cloud (up to 3 short answers per phone).
- **Scale:** load-tested with 200 and 400 simulated phones on the free plan: every vote counted, no errors, about 50 ms median response time.

## Pages

| Page | URL | Who |
| --- | --- | --- |
| Vote | `https://sathya-raveendran.github.io/live-poll/` (add `?p=<code>` for a poll other than the default) | Audience phones |
| Presenter | `present.html?p=<code>` | The projector |
| Admin | `admin.html` | Allow-listed admins only |

The default poll code is set in [`site/config.js`](site/config.js), so the QR code can point at the bare URL.

## How it works

Phones never hold a live connection. Every 3 to 4 seconds each phone asks Postgres which question is live, and it sends one request per vote. The presenter screen asks for the live question and the totals once a second. Without live connections, the Supabase free plan's Realtime limit of 200 connections never comes into play.

The database ([`supabase/migrations/`](supabase/migrations/)) enforces the rules:

- Anonymous users can't read or write tables directly. They can call only three functions: `get_live` (the current question), `submit_vote` (counted only on the live, open question, one answer per phone and changeable, or up to 3 words), and `get_results` (totals only, never individual votes).
- Each phone generates a random ID and keeps it in browser storage. A unique index allows one answer per ID per question. That's the same trust model as Menti. Someone using a private browser window could vote twice.
- Admins sign in with an emailed one-time code or link. Row-level security allows edits only for emails in the `admins` table, and public sign-ups are disabled.

## Running the session

**The day before**

- Free Supabase projects pause after 7 days without use. Open the [dashboard](https://supabase.com/dashboard/project/vwcukaalvqpzcvtsvnlz) to make sure the project is active.
- Sign in on the presenter laptop at `admin.html`. The session stays signed in on that browser.
- Run `npm test`, then **Reset votes** on anything you tested by hand.

**In the room**

1. Open `present.html` full screen (press **F**). It shows the join screen with a large QR code.
2. Use the admin page or the keyboard to move through questions.
3. Show results on phones if you want; it's a toggle on the admin page or the **R** key.

**Presenter keys** (most work with a presentation clicker): **F** full screen · **Q** large QR code · **H** hide or show results. Admins also get **→**, **Page Down**, or **Space** for the next question; **←** or **Page Up** for the previous one; **C** to close or reopen voting; and **J** for the join screen.

**If the sign-in email doesn't arrive:** run `npm run admin-link`. It prints a one-time sign-in link and code without sending an email. Use the code with **I already have a code** on the admin page.

## Development

```bash
npm install
npm run serve          # http://127.0.0.1:8080
npm test               # API and security smoke test against the live project
npm run load-test      # 200 simulated phones for 30 s (args: voters seconds poll-code)
npx supabase db push   # apply new migrations
npx supabase config push   # apply supabase/config.toml auth settings
npm run deploy         # publish site/ to GitHub Pages
```

Secrets (database password and secret API key) live in `.env.local`, which git ignores. The publishable key in `site/config.js` is designed to be public; the database rules do the protecting.

To deploy, commit your changes and run `npm run deploy`. It pushes `main`, then publishes the `site/` folder to the `gh-pages` branch, which GitHub Pages serves. It uses the `sathya-raveendran` gh login; set `GH_ACCOUNT` to use another account. GitHub Pages caches files for about 10 minutes, so bump the `?v=` version strings in the HTML files when you change JavaScript or CSS.

## Free-plan limits worth knowing

| Limit | Free plan | This app at 200 people |
| --- | --- | --- |
| Realtime connections | 200 | 0 used (polling instead) |
| Database egress | 5 GB/month | About 150–200 MB per hour of live session |
| Database size | 500 MB | Under 1 MB per session |
| Inactivity pause | After 7 days | Open the dashboard before each session |
| Auth email | A few per hour, built-in sender | Use `npm run admin-link` as a backup |
