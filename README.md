# Matchday Signal — PWA

A static-free, auto-updating rebuild of Matchday Signal: a Next.js Progressive
Web App (installable on Windows, Mac, iPhone and Android) backed by a
Supabase database, kept current by a scraper that runs on GitHub Actions —
no Claude session involved in the update loop at all.

No odds, no stakes, no "place a bet" — this compares independent prediction
models (Opta Analyst, Forebet, Wincomparator) only. That's a fixed design
decision, not a placeholder.

## How it fits together

```
GitHub Actions (cron)  →  scraper/run.js  →  Supabase (database)  →  Next.js PWA (Vercel)
   4x/week, free            Node + Playwright     free tier            free tier
```

- **Supabase** holds the data (`matches`, `meta`, `archived_rounds` tables).
- **The scraper** (`scraper/`) is a Node script that fetches fixtures/scores
  from a free structured API, and predictions from Opta/Forebet/Wincomparator,
  then writes the result into Supabase. GitHub Actions runs it on a schedule
  — see `.github/workflows/`.
- **The website** (`pages/`) is a Next.js app that reads from Supabase and
  subscribes to live changes, so every open tab updates the instant the
  scraper writes new data — no refresh button needed.

## One-time setup

You've already created GitHub, Vercel, and Supabase accounts. From here:

### 1. Run the database schema

In Supabase: open your project → **SQL Editor** → **New query** → paste the
contents of `sql/schema.sql` → **Run**. This creates the three tables and
locks them to public-read / no-public-write.

### 2. Get your Supabase keys

Project → **Settings → API Keys**:
- **Publishable key** (safe to expose) — already filled in `.env.example`
  for this project's Supabase instance.
- **Secret key** — click to reveal, copy it, and keep it out of any file
  that gets committed to GitHub. You'll paste it directly into GitHub's
  encrypted secrets in step 5 below.

### 3. Push this project to GitHub

Create a new empty repository on GitHub (no README/license — this project
already has them), then from this project's folder:

```
git init
git add .
git commit -m "Matchday Signal PWA"
git branch -M main
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

### 4. Deploy the website on Vercel

Vercel dashboard → **Add New → Project** → **Import** your new GitHub repo.
Before clicking Deploy, add two environment variables (Project Settings →
Environment Variables, or during import):

| Name | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | from `.env.example` / Supabase API settings |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the **publishable** key from step 2 |

Deploy. Vercel gives you a URL immediately (and redeploys automatically on
every future `git push`) — that URL is what you send to friends.

### 5. Add GitHub Actions secrets (for the scraper)

In your GitHub repo → **Settings → Secrets and variables → Actions → New
repository secret**, add:

| Name | Value |
|---|---|
| `SUPABASE_URL` | same project URL as above |
| `SUPABASE_SERVICE_KEY` | the **secret** key from step 2 (never the publishable one) |

### 6. Populate the first round manually

Don't wait for Friday's schedule — trigger it once by hand: GitHub repo →
**Actions** tab → **Matchday Signal – Friday update** → **Run workflow**.
Watch the run's logs; once it finishes, your Vercel URL should show the
current round's fixtures.

## Ongoing operation

Four scheduled workflows do what the old Claude scheduled tasks did, but as
real infrastructure that needs nothing from you or Claude to keep running:

- **Friday** (~5h before Friday's first kickoff) — starts a new matchweek:
  archives the finished previous round, researches Friday's fixtures, adds
  Saturday/Sunday as "not yet analyzed" placeholders.
- **Saturday** — finalizes Friday's results, researches Saturday's fixtures.
- **Sunday** — finalizes Saturday's results, researches Sunday's fixtures.
- **Weekend wrap** (after the last Sunday kickoff) — finalizes Sunday's
  results and archives the completed round.

You can re-run any of them manually from the Actions tab at any time.

## Known limitations — read before relying on this

**The scraper is the fragile part**, exactly as it was when I was manually
researching these sources in chat:

- **Forebet actively blocks bot traffic** (this returned a 403 even during
  manual research). The scraper tries anyway with a real headless browser,
  but expect it to fail some weeks — when it does, that match just gets a
  note instead of a fabricated number, per the project's one hard rule:
  never invent a prediction.
- **Opta Analyst and Wincomparator extraction is heuristic text-matching**,
  not a stable API. Their pages are prose/listings, not clean data tables,
  so `scraper/lib/predictions/opta.js` and `wincomparator.js` scan nearby
  text for percentages rather than reading a fixed field. If a site changes
  its wording or layout, extraction may come back empty for some or all
  fixtures that week — again, that shows as "not yet analyzed," never a
  guess.
- **Fixtures and final scores are reliable** — those come from TheSportsDB's
  structured free API, not scraping, so the schedule and results themselves
  shouldn't break even if predictions do.
- **The "agreement" labels (good/warn/bad/split) are now computed
  mechanically** from the raw percentages (see `scraper/lib/agreement.js`),
  not judged by an AI reading each page the way the old Claude-run passes
  did. It's a reasonable approximation, not identical reasoning.

If a run comes back with missing predictions, check that run's log in the
Actions tab first — it'll say which source failed and why.

## Local development

```
npm install
cp .env.example .env.local   # already has real values for this project
npm run dev
```

To run the scraper locally instead of waiting for GitHub Actions:

```
cd scraper
npm install
npx playwright install chromium
SUPABASE_URL=... SUPABASE_SERVICE_KEY=... PASS=friday node run.js
```
