import { withPage } from "../browser.js";

const LEAGUE_URL = "https://www.forebet.com/en/football-tips-and-predictions-for-england/premier-league";

// Forebet actively blocks non-browser and even some automated-browser
// requests (observed 403s during manual research too) — this is the least
// reliable of the three sources. Expect this to fail some weeks; when it
// does, the match simply gets a forebetNote instead of fabricated numbers,
// per this project's hard rule. If it fails consistently, consider dropping
// Forebet from the sources list rather than fighting its bot protection.
export async function fetchForebetPrediction(home, away) {
  try {
    return await withPage(async (page) => {
      const res = await page.goto(LEAGUE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
      if (res && res.status() === 403) {
        throw new Error("blocked (403) — Forebet's bot protection rejected this request");
      }
      const text = await page.innerText("body");
      return extractFromText(text, home, away);
    });
  } catch (err) {
    console.warn(`[forebet] failed for ${home} vs ${away}:`, err.message);
    return null;
  }
}

export function extractFromText(text, home, away) {
  const homeIdx = text.indexOf(home);
  const awayIdx = text.indexOf(away);
  if (homeIdx === -1 || awayIdx === -1) return null;

  const block = text.slice(Math.min(homeIdx, awayIdx), Math.max(homeIdx, awayIdx) + 300);
  // Forebet typically shows three adjacent percentages for 1 / X / 2
  const pcts = [...block.matchAll(/(\d{1,2})\s?%/g)].map((m) => parseFloat(m[1]));
  if (pcts.length < 3) return null;

  return {
    source: "Forebet",
    url: LEAGUE_URL,
    home: pcts[0],
    draw: pcts[1],
    away: pcts[2],
  };
}

export const FOREBET_UNAVAILABLE_NOTE =
  "Forebet's page was inaccessible for this fixture on this pass — it may work again next time.";
