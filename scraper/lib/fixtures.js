import { canonicalTeam, slugify } from "./teams.js";

// TheSportsDB's free, keyless-signup tier (public test key "3") — reliable
// structured fixture/score data, so the app's core schedule never depends
// on scraping a page that might change its layout.
const PL_LEAGUE_ID = 4328; // English Premier League on TheSportsDB
const API_BASE = "https://www.thesportsdb.com/api/v1/json/3";

function currentSeasonString(nowUtc) {
  const y = nowUtc.getUTCFullYear();
  const m = nowUtc.getUTCMonth() + 1; // 1-12
  // PL season starts in August; before that, we're still in the previous season
  return m >= 7 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

function toIctIso(timestampUtcIso) {
  // timestampUtcIso is like "2026-09-05T19:00:00" (UTC, no offset marker)
  // or occasionally includes a Z. Normalize, then shift by +7h for ICT.
  const clean = timestampUtcIso.endsWith("Z") ? timestampUtcIso : timestampUtcIso + "Z";
  const utcMs = new Date(clean).getTime();
  const ictMs = utcMs + 7 * 60 * 60 * 1000;
  const d = new Date(ictMs);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00+07:00`
  );
}

/**
 * Fetch every EPL fixture for the current season from TheSportsDB, mapped
 * into this project's match shape (minus predictions, which come from
 * separate scrapers). Returns ALL fixtures for the season — callers filter
 * down to the weekend window they care about.
 */
export async function fetchSeasonFixtures() {
  const season = currentSeasonString(new Date());
  const url = `${API_BASE}/eventsseason.php?id=${PL_LEAGUE_ID}&s=${season}`;
  const res = await fetch(url, { headers: { "User-Agent": "matchday-signal-scraper/1.0" } });
  if (!res.ok) throw new Error(`TheSportsDB fixtures request failed: ${res.status}`);
  const data = await res.json();
  const events = data.events || [];

  return events
    .filter((e) => e.strTimestamp) // skip fixtures with no confirmed kickoff yet
    .map((e) => {
      const home = canonicalTeam(e.strHomeTeam);
      const away = canonicalTeam(e.strAwayTeam);
      const finished = e.strStatus === "FT" || e.strStatus === "AET" || e.strStatus === "FT_PEN";
      return {
        id: slugify(home, away) + "-" + (e.dateEvent || "").replace(/-/g, "").slice(2),
        home,
        away,
        kickoffLocal: toIctIso(e.strTimestamp),
        status: finished ? "finished" : "upcoming",
        score: finished && e.intHomeScore != null && e.intAwayScore != null
          ? `${e.intHomeScore}–${e.intAwayScore}`
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
