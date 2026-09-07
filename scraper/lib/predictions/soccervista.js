import { withPage } from "../browser.js";

const LEAGUE_URL = "https://www.soccervista.com/england/premier-league/dYlOSQOD/";

// SoccerVista's fixture/prediction content is rendered client-side by
// JavaScript (confirmed: a plain HTTP fetch of this page returns only the
// page's static framework, no fixture data) — that's why this uses a real
// headless browser and waits for the network to go idle, rather than the
// faster "domcontentloaded" the other scrapers use.
//
// HONESTY NOTE: unlike Opta/Wincomparator, this page's real rendered layout
// hasn't been inspected directly (only its static HTML, before JS runs) —
// so this heuristic is a first pass, more likely than the others to need
// adjusting once you see a real run's output. If it comes back empty every
// time, check LEAGUE_URL still resolves to a live Premier League page and
// use the run's log (or a local `node scraper/run.js` run) to see what
// `page.innerText("body")` actually contains, then adjust the patterns
// below to match. Per this project's hard rule, it returns null rather than
// guessing when it can't find a confident reading — never fabricated.
//
// SoccerVista frames its predictions as betting tips (it shows "1X2 odds"
// language and gambling disclaimers on its own pages) — this project only
// ever reads its predicted pick/percentage, never odds, stakes, or EV, in
// line with this project's hard "no betting content" rule.
export async function fetchSoccervistaPrediction(home, away) {
  try {
    return await withPage(async (page) => {
      await page.goto(LEAGUE_URL, { waitUntil: "networkidle", timeout: 45000 });
      const text = await page.innerText("body");
      return extractFromText(text, home, away);
    });
  } catch (err) {
    console.warn(`[soccervista] failed for ${home} vs ${away}:`, err.message);
    return null;
  }
}

export function extractFromText(text, home, away) {
  const homeIdx = text.indexOf(home);
  const awayIdx = text.indexOf(away);
  if (homeIdx === -1 || awayIdx === -1) return null;

  const start = Math.max(0, Math.min(homeIdx, awayIdx) - 100);
  const end = Math.max(homeIdx, awayIdx) + 500;
  const block = text.slice(start, end);

  const extras = [];

  // Correct score: look for an explicit "Correct score" / "Predicted score"
  // label followed by an "N-N" or "N:N" scoreline within the block.
  const scoreMatch = block.match(/(?:correct score|predicted score)[^\d]{0,20}(\d)\s?[-:]\s?(\d)/i);
  if (scoreMatch) {
    extras.push({
      market: "Correct Score",
      pick: `${scoreMatch[1]}-${scoreMatch[2]}`,
      pct: null,
      source: "SoccerVista",
    });
  }

  // Asian handicap: look for a "Handicap" label followed by a team name and
  // a +/- number (e.g. "Handicap: Arsenal -1").
  const handicapMatch = block.match(/handicap[^\n]{0,40}?([+-]?\d(?:\.\d)?)/i);
  if (handicapMatch) {
    extras.push({
      market: "Handicap",
      pick: `${handicapMatch[1]}`,
      pct: null,
      source: "SoccerVista",
    });
  }

  // Over/Under 2.5: look for an explicit "Over 2.5" / "Under 2.5" pick,
  // optionally with a nearby percentage.
  const ouMatch = block.match(/(over|under)\s?2\.5[^\d%]{0,15}(\d{1,2})?\s?%?/i);
  if (ouMatch) {
    extras.push({
      market: "Over/Under 2.5",
      pick: `${ouMatch[1][0].toUpperCase()}${ouMatch[1].slice(1).toLowerCase()} 2.5`,
      pct: ouMatch[2] ? parseFloat(ouMatch[2]) : null,
      source: "SoccerVista",
    });
  }

  // 1X2 win/draw/away percentages, same three-number heuristic as the other
  // scrapers, contributed as a probs reading (not just an extra) if found.
  const pcts = [...block.matchAll(/(\d{1,2})\s?%/g)].map((m) => parseFloat(m[1]));
  const prob =
    pcts.length >= 3
      ? { source: "SoccerVista", url: LEAGUE_URL, home: pcts[0], draw: pcts[1], away: pcts[2] }
      : null;

  if (!prob && extras.length === 0) return null;
  return { prob, extras };
}
