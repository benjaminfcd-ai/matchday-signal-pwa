import { canonicalTeam } from "./teams.js";

// Understat (understat.com) publishes match-by-match expected-goals (xG)
// data for the Premier League — a shot-quality-based measure that's widely
// regarded as a better predictor of a team's true attacking/defensive level
// than raw goals scored/conceded, especially early in a season when only a
// handful of games have been played and goal counts are still noisy (xG
// converges to a stable read much faster than goals do).
//
// Understat has no official public API. The technique used here — reading
// the `teamsData` variable embedded in the league page's JavaScript — is a
// long-standing, widely-documented public pattern (used by many open-source
// Understat scrapers), not a private reverse-engineering effort. That said,
// this project's development sandbox couldn't reach understat.com directly
// to verify the page's exact current markup, so treat this as best-effort:
// if it starts failing, a real GitHub Actions log will show "0 team(s)
// with current-season Understat data" (see run.js), and the fix is to
// compare Understat's actual page source against the parsing logic below.
const BASE = "https://understat.com/league/EPL";

function currentSeasonStartYear(now = new Date()) {
  // EPL season runs roughly Aug-May; Understat URLs use the year the
  // season STARTED (e.g. "2026" for the 2026-27 season, all the way
  // through May 2027).
  const y = now.getUTCFullYear();
  return now.getUTCMonth() >= 6 ? y : y - 1; // month 6 = July (0-indexed)
}

function decodeEscapedJson(raw) {
  // Understat embeds its data as `JSON.parse('\x7B...\x7D')` — a string
  // with every byte hex-escaped. Un-escape it back to real characters,
  // then parse it as JSON.
  const unescaped = raw.replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return JSON.parse(unescaped);
}

async function fetchTeamsData(seasonStartYear) {
  const url = `${BASE}/${seasonStartYear}`;
  const res = await fetch(url, { headers: { "User-Agent": "matchday-signal-scraper/1.0" } });
  if (!res.ok) return null;
  const html = await res.text();
  const match = html.match(/var\s+teamsData\s*=\s*JSON\.parse\('(.+?)'\);/);
  if (!match) return null;
  try {
    return decodeEscapedJson(match[1]);
  } catch {
    return null;
  }
}

// Sums each team's match-by-match history into season totals: xG for/
// against and games played. Returns null (not a guess) if the page
// couldn't be fetched or parsed at all.
function summarizeTeamsData(teamsData) {
  if (!teamsData) return null;
  const out = {};
  for (const team of Object.values(teamsData)) {
    const canon = canonicalTeam(team.title);
    const history = team.history || [];
    let xgFor = 0;
    let xgAgainst = 0;
    for (const g of history) {
      xgFor += Number(g.xG) || 0;
      xgAgainst += Number(g.xGA) || 0;
    }
    out[canon] = { xgFor, xgAgainst, games: history.length };
  }
  return out;
}

// Fetches both the current season's xG-so-far and the previous full
// season's final xG totals. The previous season is used as a per-team
// prior for the goals model (see goalsModel.js) so early-season
// predictions lean on that team's own recent level rather than a generic
// league-wide average — a real accuracy improvement for the first few
// matchweeks of a season specifically. Either or both can come back null
// (e.g. Understat unreachable, or a newly promoted team with no top-flight
// history last season) — callers must handle that, never guess in its
// place.
export async function fetchXgContext() {
  const thisYear = currentSeasonStartYear();
  const [current, previous] = await Promise.all([
    fetchTeamsData(thisYear).catch(() => null),
    fetchTeamsData(thisYear - 1).catch(() => null),
  ]);
  return {
    current: summarizeTeamsData(current),
    previous: summarizeTeamsData(previous),
  };
}
