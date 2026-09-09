import { withPage } from "../browser.js";

const LEAGUE_URLS = {
  PL: "https://www.forebet.com/en/football-tips-and-predictions-for-england/premier-league",
  CL: "https://www.forebet.com/en/predictions-europe/uefa-champions-league",
};

// Forebet — a free, no-login prediction site publishing a home/draw/away
// percentage split for every fixture (e.g. "45% 30% 25%"), confirmed via
// third-party coverage of its format. Added as a 5th independent source
// alongside Opta/Wincomparator/SoccerVista/Elo, for both Premier League and
// Champions League.
//
// HONESTY NOTE: forebet.com's real rendered layout hasn't been inspected
// directly — a direct fetch of the page returned a 403 (it has some bot
// protection, same category of issue browser.js's shared headless-browser
// helper already exists to work around for the other sources), so this
// extraction is a first-pass heuristic, more likely than the others to
// need adjusting once you see a real run's output. If it comes back empty
// every time: check the URL still resolves to a live predictions page, and
// use the run's log (or a local `node scraper/run.js` run) to see what
// `page.innerText("body")` actually contains near a fixture, then adjust
// the pattern below to match. Per this project's hard rule, it returns
// null rather than guessing when it can't find a confident reading.
export async function fetchForebetPrediction(home, away, competition = "PL") {
  const leagueUrl = LEAGUE_URLS[competition] || LEAGUE_URLS.PL;
  try {
    return await withPage(async (page) => {
      await page.goto(leagueUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      const text = await page.innerText("body");
      return extractFromText(text, home, away, leagueUrl);
    });
  } catch (err) {
    console.warn(`[forebet] failed for ${home} vs ${away} (${competition}):`, err.message);
    return null;
  }
}

export function extractFromText(text, home, away, leagueUrl = LEAGUE_URLS.PL) {
  const homeIdx = text.indexOf(home);
  const awayIdx = text.indexOf(away);
  if (homeIdx === -1 || awayIdx === -1) return null;

  const start = Math.min(homeIdx, awayIdx);
  const end = Math.max(homeIdx, awayIdx) + 300;
  const block = text.slice(start, end);

  // Forebet lists its 1X2 prediction as three consecutive percentages
  // (home / draw / away, in that order) near the fixture — same three-
  // number heuristic already used by soccervista.js/opta.js for sources
  // that don't expose a clean per-outcome selector.
  const pcts = [...block.matchAll(/(\d{1,2})\s?%/g)].map((m) => parseFloat(m[1]));
  if (pcts.length < 3) return null;

  return {
    source: "Forebet",
    url: leagueUrl,
    home: pcts[0],
    draw: pcts[1],
    away: pcts[2],
  };
}
