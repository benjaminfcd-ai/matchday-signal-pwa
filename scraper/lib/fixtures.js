import { canonicalTeam, slugify } from "./teams.js";

// football-data.org's free tier (requires a free API token — see README) —
// reliable structured fixture/score data, so the app's core schedule never
// depends on scraping a page that might change its layout.
//
// NOTE: this project originally used TheSportsDB's shared public "test" key
// ("3"). That key turned out to only ever return a handful of demo/sample
// events per league — not the real current-season schedule — so it silently
// produced "no fixtures found" for real weeks. football-data.org's free tier
// requires a one-time signup but actually returns the real data.
const API_BASE = "https://api.football-data.org/v4";
// football-data.org's own competition codes — both are on the free tier
// (confirmed: football-data.org's published free-tier competition list
// includes the UEFA Champions League alongside the "big 5" domestic
// leagues), so no second API key or paid plan is needed for CL support.
const COMPETITION_CODES = { PL: "PL", CL: "CL" };

function toIctIso(utcDateIso) {
  // utcDateIso is an ISO string with a Z, e.g. "2026-09-05T19:00:00Z".
  const utcMs = new Date(utcDateIso).getTime();
  const ictMs = utcMs + 7 * 60 * 60 * 1000;
  const d = new Date(ictMs);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00+07:00`
  );
}

/**
 * Fetch every fixture for the current season, for the given competition,
 * from football-data.org, mapped into this project's match shape (minus
 * predictions, which come from separate scrapers). Returns ALL fixtures for
 * the season — callers filter down to the window (weekend or midweek) they
 * care about.
 *
 * competition: "PL" (default, unchanged) or "CL". PL fixture IDs keep their
 * exact original format (slug + dateTag) — untouched, so existing rows
 * never change ID and never duplicate on upsert. CL fixtures get a "cl-"
 * prefix on that same slug so the two competitions' IDs can never collide,
 * even for a fixture that happens to share a slug (e.g. two same-named
 * clubs meeting on the same date in different competitions).
 */
export async function fetchSeasonFixtures(competition = "PL") {
  const token = process.env.FOOTBALL_DATA_TOKEN;
  if (!token) {
    throw new Error(
      "FOOTBALL_DATA_TOKEN must be set (as a GitHub Actions secret) — sign up free at football-data.org/client/register"
    );
  }
  const code = COMPETITION_CODES[competition] || competition;
  const url = `${API_BASE}/competitions/${code}/matches`;
  const res = await fetch(url, { headers: { "X-Auth-Token": token } });
  if (!res.ok) throw new Error(`football-data.org fixtures request failed for ${competition}: ${res.status}`);
  const data = await res.json();
  const matches = data.matches || [];

  return matches
    .filter((m) => m.utcDate)
    .map((m) => {
      const home = canonicalTeam(m.homeTeam?.name || m.homeTeam?.shortName || "");
      const away = canonicalTeam(m.awayTeam?.name || m.awayTeam?.shortName || "");
      const finished = m.status === "FINISHED";
      const homeScore = m.score?.fullTime?.home;
      const awayScore = m.score?.fullTime?.away;
      const dateTag = m.utcDate.slice(0, 10).replace(/-/g, "").slice(2);
      const slug = slugify(home, away) + "-" + dateTag;
      return {
        id: competition === "PL" ? slug : `${competition.toLowerCase()}-${slug}`,
        competition,
        home,
        away,
        // football-data.org returns each club's crest URL right alongside the
        // fixture — free, and already fetched for the schedule itself, so no
        // extra request or new dependency is needed to show team badges.
        homeCrest: m.homeTeam?.crest || null,
        awayCrest: m.awayTeam?.crest || null,
        kickoffLocal: toIctIso(m.utcDate),
        status: finished ? "finished" : "upcoming",
        score: finished && homeScore != null && awayScore != null
          ? `${homeScore}–${awayScore}`
          : null,
      };
    });
}

/**
 * Given a reference "now" (ICT), return the Fri/Sat/Sun window that contains
 * (or immediately follows) it — i.e. "this weekend's" matchweek.
 */
export function weekendWindow(nowIct = new Date()) {
  const day = nowIct.getUTCDay(); // 0 Sun .. 6 Sat, using UTC fields on an ICT-shifted date is fine here
  // Find the most recent Friday on/before "now" (0 = this Fri..Sun window)
  const daysSinceFriday = (day - 5 + 7) % 7;
  const friday = new Date(nowIct);
  friday.setUTCDate(friday.getUTCDate() - daysSinceFriday);
  friday.setUTCHours(0, 0, 0, 0);
  const mondayAfter = new Date(friday);
  mondayAfter.setUTCDate(friday.getUTCDate() + 3); // through end of Sunday
  return { start: friday, end: mondayAfter };
}

/**
 * Given a reference "now" (ICT), return the Mon–Thu window that contains
 * (or immediately follows) it — i.e. "this week's" Champions League round.
 * Champions League fixtures cluster midweek (mainly Tue/Wed, occasionally
 * Thu for later rounds) rather than the Fri–Sun spread Premier League uses
 * — this is the complementary window for that, covering Monday 00:00
 * through the start of Friday.
 */
export function midweekWindow(nowIct = new Date()) {
  const day = nowIct.getUTCDay(); // 0 Sun .. 6 Sat
  const daysSinceMonday = (day - 1 + 7) % 7;
  const monday = new Date(nowIct);
  monday.setUTCDate(monday.getUTCDate() - daysSinceMonday);
  monday.setUTCHours(0, 0, 0, 0);
  const fridayAfter = new Date(monday);
  fridayAfter.setUTCDate(monday.getUTCDate() + 4); // through end of Thursday
  return { start: monday, end: fridayAfter };
}
