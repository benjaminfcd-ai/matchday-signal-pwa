import { withPage } from "./browser.js";
import { canonicalTeam } from "./teams.js";

// Understat (understat.com) publishes match-by-match expected-goals (xG)
// data for the Premier League — a shot-quality-based measure that's widely
// regarded as a better predictor of a team's true attacking/defensive level
// than raw goals scored/conceded, especially early in a season when only a
// handful of games have been played and goal counts are still noisy (xG
// converges to a stable read much faster than goals do).
//
// Understat has no official public API. A first version of this file tried
// a plain HTTP fetch and read a `teamsData` variable out of the raw HTML —
// a long-standing, widely-documented public pattern for this site. A real
// run's log showed that no longer works: the request succeeds (HTTP 200,
// correct page title) but the response is a small, mostly-empty shell with
// no `teamsData` in it — Understat's data is now loaded client-side by its
// own JavaScript after the page loads, the same situation this project
// already solved for SoccerVista. This version uses the same fix: a real
// headless browser (already set up for that purpose — see browser.js),
// which actually runs the page's JS before reading the data.
const BASE = "https://understat.com/league/EPL";

function currentSeasonStartYear(now = new Date()) {
  // EPL season runs roughly Aug-May; Understat URLs use the year the
  // season STARTED (e.g. "2026" for the 2026-27 season, all the way
  // through May 2027).
  const y = now.getUTCFullYear();
  return now.getUTCMonth() >= 6 ? y : y - 1; // month 6 = July (0-indexed)
}

function decodeEscapedJson(raw) {
  // Understat's older embedding style: `JSON.parse('\x7B...\x7D')` — a
  // string with every byte hex-escaped. Un-escape it back to real
  // characters, then parse it as JSON. Kept as a fallback (see below).
  const unescaped = raw.replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return JSON.parse(unescaped);
}

async function fetchTeamsData(seasonStartYear) {
  const url = `${BASE}/${seasonStartYear}`;
  try {
    return await withPage(async (page) => {
      await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });

      // Primary path: Understat's page sets `teamsData` as a client-side
      // global once its own JS runs — read it directly from the rendered
      // page rather than parsing HTML text.
      const fromWindow = await page.evaluate(() =>
        typeof window.teamsData !== "undefined" ? window.teamsData : null
      );
      if (fromWindow) return fromWindow;

      // Fallback: in case the data instead arrives as an escaped JSON
      // string inside a <script> tag (this project's older assumption),
      // check the fully-rendered HTML for that pattern too before giving
      // up — cheap to try, and covers a future layout change either way.
      const html = await page.content();
      const match = html.match(/var\s+teamsData\s*=\s*JSON\.parse\('(.+?)'\);/);
      if (!match) {
        console.warn(
          `[xg] rendered ${url} in a real browser (${html.length} bytes) but found neither ` +
            `window.teamsData nor an embedded teamsData script — Understat's page structure may ` +
            `have changed further; this needs a fresh look at the real page.`
        );
        return null;
      }
      try {
        return decodeEscapedJson(match[1]);
      } catch (err) {
        console.warn(`[xg] found an embedded teamsData script at ${url} but failed to parse it: ${err.message}`);
        return null;
      }
    });
  } catch (err) {
    console.warn(`[xg] browser fetch failed for ${url}: ${err.message}`);
    return null;
  }
}

// Sums each team's match-by-match history into season totals: xG for/
// against and games played. Used for the PREVIOUS season only, where a
// single flat total is exactly what's needed — it's just an anchor prior
// for the early-season blend in goalsModel.js, not something that needs
// its own recency weighting. Returns null (not a guess) if the page
// couldn't be fetched or parsed at all.
function summarizeTeamsDataAggregate(teamsData) {
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

// Used for the CURRENT season instead: keeps each match's own date and
// home/away flag rather than collapsing straight to one flat average, so
// goalsModel.js can weight recent matches more heavily than early-season
// ones and compute each team's home form separately from its away form
// (see that file for why). Sorted oldest-first per team. Returns null if
// the page couldn't be fetched at all.
function summarizeTeamsDataDetailed(teamsData) {
  if (!teamsData) return null;
  const out = {};
  for (const team of Object.values(teamsData)) {
    const canon = canonicalTeam(team.title);
    const history = team.history || [];
    out[canon] = history
      .map((g) => ({
        date: g.date || null,
        // Understat marks each match "h" (home) or "a" (away) for the team
        // whose history this is. If this field is ever missing or comes
        // back as something unexpected, the match is left OUT of the home/
        // away split specifically (never guessed which venue it was) but
        // still counts toward that team's overall recency-weighted rate —
        // see venueStats() in goalsModel.js.
        venue: g.h_a === "h" ? "home" : g.h_a === "a" ? "away" : null,
        xgFor: Number(g.xG) || 0,
        xgAgainst: Number(g.xGA) || 0,
      }))
      .filter((g) => g.date) // no date means it can't be ordered/weighted safely — drop it rather than guess its recency
      .sort((a, b) => new Date(a.date) - new Date(b.date));
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
    // Per-match detail (date + home/away + xG), so goalsModel.js can weight
    // recent matches more heavily and split by venue.
    current: summarizeTeamsDataDetailed(current),
    // A flat season total — used only as a prior anchor, not something
    // that needs recency weighting itself.
    previous: summarizeTeamsDataAggregate(previous),
  };
}
