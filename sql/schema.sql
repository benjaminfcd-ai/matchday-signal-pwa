-- Matchday Signal — Supabase schema
-- Run this once in the Supabase SQL Editor (Project > SQL Editor > New query),
-- then click "Run". Safe to re-run: uses IF NOT EXISTS / CREATE OR REPLACE.

-- ── meta: single row holding the round label + last-updated timestamp ──
create table if not exists public.meta (
  id text primary key default 'status',
  round_label text not null default 'Premier League',
  last_updated timestamptz not null default now()
);
insert into public.meta (id, round_label, last_updated)
values ('status', 'Premier League', now())
on conflict (id) do nothing;

-- ── matches: one row per fixture in the current round ──
create table if not exists public.matches (
  id text primary key,               -- e.g. "ars-che"
  home text not null,
  away text not null,
  kickoff_local timestamptz not null,  -- always stored/read as ICT (Asia/Ho_Chi_Minh)
  status text not null default 'upcoming' check (status in ('upcoming','finished')),
  score text,                          -- "2–1" once finished, else null
  probs jsonb not null default '[]',   -- [{source,url,home,draw,away}]
  extras jsonb not null default '[]',  -- [{market,pick,pct,source}]
  standout jsonb not null default '{}',-- {market,pick,pct,source,note}
  agreement text,                      -- "good" | "warn" | "bad" | "split"
  agreement_note text,
  forebet_note text,
  updated_at timestamptz not null default now()
);

-- ── archived_rounds: one row per fully-completed matchweek ──
create table if not exists public.archived_rounds (
  id bigint generated always as identity primary key,
  round_label text not null,
  matches jsonb not null,              -- full snapshot of that round's matches
  archived_at timestamptz not null default now()
);

-- Team crest (badge) URLs, added after matches already existed — safe to
-- re-run against a live table, does nothing if the columns are already there.
alter table public.matches add column if not exists home_crest text;
alter table public.matches add column if not exists away_crest text;

-- ── standings: single row holding the current Premier League table ──
-- (column named "rows", not "table" — "table" is a reserved SQL keyword)
create table if not exists public.standings (
  id text primary key default 'current',
  rows jsonb not null default '[]',    -- [{position,team,crest,played,won,draw,lost,goalsFor,goalsAgainst,goalDifference,points}]
  updated_at timestamptz not null default now()
);

-- ── Row Level Security: anyone can READ, nobody can WRITE except the
--    service_role key (used only by the GitHub Actions scraper, never
--    shipped to the browser). This keeps the public site read-only. ──
alter table public.meta enable row level security;
alter table public.matches enable row level security;
alter table public.archived_rounds enable row level security;
alter table public.standings enable row level security;

drop policy if exists "public read meta" on public.meta;
create policy "public read meta" on public.meta for select using (true);

drop policy if exists "public read matches" on public.matches;
create policy "public read matches" on public.matches for select using (true);

drop policy if exists "public read archived_rounds" on public.archived_rounds;
create policy "public read archived_rounds" on public.archived_rounds for select using (true);

drop policy if exists "public read standings" on public.standings;
create policy "public read standings" on public.standings for select using (true);

-- No insert/update/delete policies are created for the publishable (anon) key,
-- so writes are only possible using the project's secret (service_role) key —
-- which only the scheduled scraper holds, as a GitHub Actions secret.
