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
const COMPETITION = "PL"; // English Premier League

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
 * Fetch every EPL fixture for the current season from football-data.org,
 * mapped into this project's match shape (minus predictions, which come
 * from separate scrapers). Returns ALL fixtures for the season — callers
 * filter down to the weekend window they care about.
 */
export async function fetchSeasonFixtures() {
  const token = process.env.FOOTBALL_DATA_TOKEN;
  if (!token) {
    throw new Error(
      "FOOTBALL_DATA_TOKEN must be set (as a GitHub Actions secret) — sign up free at football-data.org/client/register"
    );
  }
  const url = `${API_BASE}/competitions/${COMPETITION}/matches`;
  const res = await fetch(url, { headers: { "X-Auth-Token": token } });
  if (!res.ok) throw new Error(`football-data.org fixtures request failed: ${res.status}`);
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
      return {
        id: slugify(home, away) + "-" + dateTag,
        home,
        away,
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
 * it, or — if that window has already fully elapsed — the NEXT upcoming
 * Fri/Sat/Sun window. This matters whenever the Friday pass gets triggered
 * (by schedule or manually) after a previous weekend has already finished
 * and been archived: it should start the new round on the coming weekend,
 * not regenerate the one that just ended.
 */
export function weekendWindow(nowIct = new Date()) {
  const day = nowIct.getUTCDay(); // 0 Sun .. 6 Sat, using UTC fields on an ICT-shifted date is fine here
  // Find the most recent Friday on/before "now" (0 = this Fri..Sun window)
  const daysSinceFriday = (day - 5 + 7) % 7;
  const friday = new Date(nowIct);
  friday.setUTCDate(friday.getUTCDate() - daysSinceFriday);
  friday.setUTCHours(0, 0, 0, 0);
  let mondayAfter = new Date(friday);
  mondayAfter.setUTCDate(friday.getUTCDate() + 3); // through end of Sunday

  // If that window already fully ended (we're on the Monday-Thursday after
  // it), roll forward one week to the next Friday-Sunday window instead.
  if (mondayAfter.getTime() <= nowIct.getTime()) {
    friday.setUTCDate(friday.getUTCDate() + 7);
    mondayAfter = new Date(friday);
    mondayAfter.setUTCDate(friday.getUTCDate() + 3);
  }

  return { start: friday, end: mondayAfter };
}
