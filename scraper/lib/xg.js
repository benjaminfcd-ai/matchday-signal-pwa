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
// Understat scrapers), not a private reverse-engineering effort. This
// project's development sandbox couldn't reach understat.com directly to
// verify the page's exact current markup, so the first deployed version of
// this file failed silently into its safe fallback (0 teams, goals-only) —
// this version adds specific diagnostic logging (HTTP status, whether
// "teamsData" was found at all, a snippet of the page if not) so a real
// GitHub Actions log points at the actual cause instead of just "it didn't
// work."
const BASE = "https://understat.com/league/EPL";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

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
  let res;
  try {
    res = await fetch(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
  } catch (err) {
    console.warn(`[xg] network error fetching ${url}: ${err.message}`);
    return null;
  }
  if (!res.ok) {
    console.warn(`[xg] ${url} returned HTTP ${res.status}`);
    return null;
  }
  const html = await res.text();
  const match = html.match(/var\s+teamsData\s*=\s*JSON\.parse\('(.+?)'\);/);
  if (!match) {
    console.warn(
      `[xg] fetched ${url} (${html.length} bytes, HTTP ${res.status}) but couldn't find "teamsData" in it — ` +
        `page layout may differ from what this was built against. First 200 chars: ` +
        JSON.stringify(html.slice(0, 200).replace(/\s+/g, " "))
    );
    return null;
  }
  try {
    return decodeEscapedJson(match[1]);
  } catch (err) {
    console.warn(`[xg] found "teamsData" at ${url} but failed to parse it: ${err.message}`);
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
    fetchTeamsData(thisYear).catch((err) => {
      console.warn(`[xg] unexpected error fetching current season (${thisYear}): ${err.message}`);
      return null;
    }),
    fetchTeamsData(thisYear - 1).catch((err) => {
      console.warn(`[xg] unexpected error fetching previous season (${thisYear - 1}): ${err.message}`);
      return null;
    }),
  ]);
  return {
    current: summarizeTeamsData(current),
    previous: summarizeTeamsData(previous),
  };
}
