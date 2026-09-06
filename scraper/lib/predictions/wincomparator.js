import { withPage } from "../browser.js";

const LEAGUE_URL = "https://www.wincomparator.com/predictions/football/england/premier-league-49/";

// Wincomparator's listing page shows each fixture with a single predicted
// "Probability: NN%" reading (not always a full home/draw/away breakdown) —
// confirmed by manual inspection. This heuristic finds the text block for
// the requested fixture and takes the percentage nearest to it, assuming it
// belongs to whichever team name sits closer to that percentage in the text.
// NOTE: if wincomparator's page layout changes, or a match's block isn't
// found, this returns null (per the project's "never fabricate" rule) —
// check LEAGUE_URL still lists upcoming fixtures if this keeps failing.
export async function fetchWincomparatorPrediction(home, away) {
  try {
    return await withPage(async (page) => {
      await page.goto(LEAGUE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
      const text = await page.innerText("body");
      return extractFromText(text, home, away);
    });
  } catch (err) {
    console.warn(`[wincomparator] failed for ${home} vs ${away}:`, err.message);
    return null;
  }
}

export function extractFromText(text, home, away) {
  const homeIdx = text.indexOf(home);
  const awayIdx = text.indexOf(away);
  if (homeIdx === -1 || awayIdx === -1) return null;

  const blockStart = Math.min(homeIdx, awayIdx);
  const blockEnd = Math.max(homeIdx, awayIdx) + 300;
  const block = text.slice(blockStart, blockEnd);

  const probMatch = block.match(/Probability:?\s*(\d{1,2}(?:\.\d)?)\s?%/i);
  if (!probMatch) return null;
  const pct = parseFloat(probMatch[1]);

  // whichever team name appears closer to the percentage is treated as the
  // side the probability applies to
  const pctIdx = block.indexOf(probMatch[0]);
  const homeRel = block.lastIndexOf(home, pctIdx);
  const awayRel = block.lastIndexOf(away, pctIdx);
  const favorsHome = homeRel > -1 && homeRel >= awayRel;

  return {
    source: "Wincomparator",
    url: LEAGUE_URL,
    home: favorsHome ? pct : null,
    draw: null,
    away: favorsHome ? null : pct,
  };
}
