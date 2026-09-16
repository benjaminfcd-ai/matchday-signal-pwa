# Matchday Signal — PWA

A static-free, auto-updating rebuild of Matchday Signal: a Next.js Progressive
Web App (installable on Windows, Mac, iPhone and Android) backed by a
Supabase database, kept current by a scraper that runs on GitHub Actions —
no Claude session involved in the update loop at all.

No odds, no stakes, no "place a bet" — this compares independent prediction
models (Opta Analyst, Wincomparator, SoccerVista, a self-calculated Club
Elo model, a second self-calculated Elo model built entirely from this
project's own recorded results, a form- and home/away-aware goals model,
and an AI Research pass that itself checks a broad spread of sites per
fixture) only. That's a fixed design decision, not a placeholder. (An
earlier version also used Forebet — dropped after its bot-protection made
it fail almost every run; see "Known limitations" below for what replaced
it.)

## How it fits together
