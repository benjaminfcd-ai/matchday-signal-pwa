import { withPage } from "../browser.js";

// Opta Analyst publishes its supercomputer predictions as prose inside one
// weekly article per competition (not a clean per-match table), e.g.:
//   "...assigned a 56.8% win probability to Chelsea's 20%..."
// so extraction here is heuristic text-proximity matching, not a fixed
// selector. IMPORTANT: this is the piece most likely to need adjusting
// once you see a real week's article wording — if it comes back empty,
// check the URL still resolves to the current week's piece and that the
// surrounding sentence still mentions both percentages near the names.
//
// NOTE on the CL URL: theanalyst.com slugs its Champions League predictions
// article with a season suffix (e.g. "...2026-27"), unlike the evergreen PL
// slug — this will need a manual one-line update at the start of each new
// UCL season if the old URL stops resolving.
const ARTICLE_URLS = {
  PL: "https://theanalyst.com/articles/premier-league-match-predictions",
  CL: "https://theanalyst.com/articles/uefa-champions-league-match-predictions-2026-27",
  // Both confirmed loading directly (Sept 2026) with current-season content
  // (Bundesliga's mentions this year's promoted clubs; La Liga's is dated
  // Aug 2026 and mentions its own promoted clubs) — same yearly-slug pattern
  // as the CL URL above, so these will likely need the same kind of one-line
  // update at the start of a new season if the old URL stops resolving.
  BL1: "https://theanalyst.com/articles/bundesliga-predictions-2026-27-opta-supercomputer",
  PD: "https://theanalyst.com/articles/la-liga-predictions-2026-27-opta-supercomputer-projections",
};

export async function fetchOptaPrediction(home, away, competition = "PL") {
  const articleUrl = ARTICLE_URLS[competition] || ARTICLE_URLS.PL;
  try {
    return await withPage(async (page) => {
      await page.goto(articleUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      const text = await page.innerText("body");
      return extractFromText(text, home, away, articleUrl);
    });
  } catch (err) {
    console.warn(`[opta] failed for ${home} vs ${away} (${competition}):`, err.message);
    return null;
  }
}

export function extractFromText(text, home, away, articleUrl = ARTICLE_URLS.PL) {
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
    url: articleUrl,
    home: homePct,
    draw: drawPct,
    away: awayPct,
  };
}
