import { withPage } from "../browser.js";

const ARTICLE_URL = "https://theanalyst.com/articles/premier-league-match-predictions";

// Opta Analyst publishes its supercomputer predictions as prose inside one
// weekly article (not a clean per-match table), e.g.:
//   "...assigned a 56.8% win probability to Chelsea's 20%..."
// so extraction here is heuristic text-proximity matching, not a fixed
// selector. IMPORTANT: this is the piece most likely to need adjusting
// once you see a real week's article wording — if it comes back empty,
// check ARTICLE_URL still resolves to the current week's piece and that
// the surrounding sentence still mentions both percentages near the names.
export async function fetchOptaPrediction(home, away) {
  try {
    return await withPage(async (page) => {
      await page.goto(ARTICLE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
      const text = await page.innerText("body");
      return extractFromText(text, home, away);
    });
  } catch (err) {
    console.warn(`[opta] failed for ${home} vs ${away}:`, err.message);
    return null;
  }
}

export function extractFromText(text, home, away) {
  const homeIdx = text.indexOf(home);
  const awayIdx = text.indexOf(away);
  if (homeIdx === -1 || awayIdx === -1) return null;

  const start = Math.max(0, Math.min(homeIdx, awayIdx) - 200);
  const end = Math.max(homeIdx, awayIdx) + 400;
  const window = text.slice(start, end);

  const pctMatches = [...window.matchAll(/(\d{1,2}(?:\.\d)?)\s?%/g)].map((m) => parseFloat(m[1]));
  if (pctMatches.length < 2) return null;

  const homePct = pctMatches[0];
  const awayPct = pctMatches[1];
  let drawPct = pctMatches[2];
  if (drawPct == null) {
    const remainder = Math.round((100 - homePct - awayPct) * 10) / 10;
    drawPct = remainder > 0 && remainder < 100 ? remainder : null;
  }

  return {
    source: "Opta Analyst",
    url: ARTICLE_URL,
    home: homePct,
    draw: drawPct,
    away: awayPct,
  };
}
