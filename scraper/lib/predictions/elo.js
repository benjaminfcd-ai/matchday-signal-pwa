// Club Elo (clubelo.com) — a well-established, independently maintained Elo
// rating system for club football. This module is different from the other
// three prediction sources: instead of reading someone else's published
// prediction, it fetches a club's current Elo rating and CALCULATES a
// win/draw/loss prediction from it — real probability math, not a number
// lifted off a page.
//
// Method (standard, publicly documented, not proprietary): the Elo
// win-expectancy formula (the same one used across chess/sports Elo
// systems), with a ~100-point home-advantage adjustment — the convention
// used by most public football-Elo projects — converted into an expected
// goal difference (~173 Elo points per goal, a commonly cited
// approximation) and spread across a Poisson model to get win/draw/loss.
//
// SCOPE: this module ONLY produces a win/draw/loss reading. Over/Under,
// Correct Score, and Handicap are handled by `goalsModel.js` instead, which
// uses each club's ACTUAL goals scored/conceded this season — Elo ratings
// alone can't distinguish a low-scoring team from a high-scoring one of the
// same overall strength, which matters a lot for those markets specifically.
// This is an estimate either way — treat it as one more independent read
// alongside Opta/Wincomparator/SoccerVista/the goals model, not a ground truth.
//
// WHERE THE RATING COMES FROM: this used to hit ClubElo's plain-CSV API at
// api.clubelo.com/<slug>, a lightweight raw HTTP fetch. As of September
// 2026 that specific endpoint started failing (HTTP 502, confirmed both
// from the GitHub Actions runner and from a real browser — clubelo.com's
// own website was unaffected the whole time, so this was ClubElo's API
// backend for that route specifically, not the site or the service as a
// whole). This module now instead loads a club's normal page on the public
// website — https://clubelo.com/<slug> — with Playwright (same withPage()
// pattern already used by opta.js/wincomparator.js/soccervista.js) and reads
// the "Elo: NNNN" line that page displays near the top for the club. Same
// slug scheme, same candidate-fallback approach, same "never fabricate"
// behavior — just a different transport now that the CSV route is down. If
// ClubElo ever brings that API back, this module doesn't need it back: the
// website route confirmed to cover the same clubs (and then some — it goes
// all the way down England's league pyramid, not just the CSV's top flight).
//
// NOTE ON TEAM NAME SLUGS: ClubElo's per-club URLs use their own short
// slugs (e.g. "ManCity", not "Manchester City"). The mapping below is a
// best-effort guess at those slugs with a couple of fallback candidates per
// club — this is the piece most likely to need correcting once you see a
// real run's logs (a "[elo] no working ClubElo slug for X" warning means
// every candidate for that club failed; check clubelo.com directly for its
// real slug and add it to the candidates list below).
//
// That warning line also prints WHY each candidate slug failed (a page-load
// error, an HTTP status, or no "Elo:" line found in the page) rather than
// just "no working slug" — see fetchLatestEloForSlug below. That distinction
// matters: a slug that's clearly correct (e.g. "Arsenal") failing to load at
// all points at ClubElo being unreachable or blocking this scraper
// altogether, not at a wrong name guess — while a page that loads fine but
// has no "Elo:" line just means try a different candidate slug.
import { withPage } from "../browser.js";

const ELO_NAME_CANDIDATES = {
  "Arsenal": ["Arsenal"],
  "Aston Villa": ["AstonVilla", "Aston"],
  "Bournemouth": ["Bournemouth"],
  "Brentford": ["Brentford"],
  "Brighton and Hove Albion": ["Brighton", "BrightonHoveAlbion"],
  "Burnley": ["Burnley"],
  "Chelsea": ["Chelsea"],
  "Crystal Palace": ["CrystalPalace", "Palace"],
  "Everton": ["Everton"],
  "Fulham": ["Fulham"],
  "Leeds United": ["Leeds"],
  "Liverpool": ["Liverpool"],
  "Manchester City": ["ManCity"],
  "Manchester United": ["ManUnited"],
  "Newcastle United": ["Newcastle"],
  "Nottingham Forest": ["NottmForest", "Forest", "NottinghamForest"],
  "Sunderland": ["Sunderland"],
  "Tottenham Hotspur": ["Tottenham"],
  "West Ham United": ["WestHam"],
  "Wolverhampton Wanderers": ["Wolves", "Wolverhampton"],
  "Ipswich Town": ["Ipswich"],
  "Leicester City": ["Leicester"],
  "Southampton": ["Southampton"],

  // Champions League — same best-effort slug-guessing approach as above,
  // for the European clubs added to teams.js. ClubElo's slugs are terse
  // and not always predictable from the club's full name, so several of
  // these carry more than one candidate; a club that doesn't resolve just
  // warns and returns null (see fetchLatestElo below) — never fabricated.
  "Real Madrid": ["RealMadrid"],
  "Barcelona": ["Barcelona"],
  "Atletico Madrid": ["AtleticoMadrid", "Atletico"],
  "Bayern Munich": ["BayernMunich", "FCBayern"],
  "Borussia Dortmund": ["Dortmund", "BorussiaDortmund"],
  "RB Leipzig": ["RBLeipzig", "Leipzig"],
  "Bayer Leverkusen": ["Leverkusen", "BayerLeverkusen"],
  "Paris Saint-Germain": ["ParisSG", "PSG"],
  "Monaco": ["Monaco"],
  "Marseille": ["Marseille"],
  "Juventus": ["Juventus"],
  "Inter Milan": ["Inter"],
  "AC Milan": ["ACMilan", "Milan"],
  "Napoli": ["Napoli"],
  "Atalanta": ["Atalanta"],
  "Benfica": ["Benfica"],
  "Porto": ["FCPorto", "Porto"],
  "Sporting CP": ["Sporting", "SportingCP"],
  "Ajax": ["Ajax"],
  "PSV Eindhoven": ["PSV"],
  "Feyenoord": ["Feyenoord"],
  "Club Brugge": ["ClubBrugge", "Brugge"],
  "Union Saint-Gilloise": ["Union", "UnionSG", "UnionStGilloise"],
  "Celtic": ["Celtic"],
  "Shakhtar Donetsk": ["Shakhtar", "ShakhtarDonetsk"],
  "Dynamo Kyiv": ["DynamoKyiv", "DynamoKiev"],
  "Red Bull Salzburg": ["Salzburg", "RedBullSalzburg"],
  "Sturm Graz": ["Sturm", "SturmGraz"],
  "Slavia Prague": ["SlaviaPraha", "SlaviaPrague"],
  "Sparta Prague": ["SpartaPraha", "SpartaPrague"],
  "Galatasaray": ["Galatasaray"],
  "Fenerbahce": ["Fenerbahce"],
  "Olympiacos": ["Olympiakos", "Olympiacos"],
  "PAOK": ["PAOK"],
  "Bodo/Glimt": ["BodoGlimt"],
  "Copenhagen": ["FCCopenhagen", "Copenhagen"],
  "Qarabag": ["Qarabag"],
  // Sabah FK (Man Utd's 2026-27 UCL opponent) doesn't have a confirmed
  // ClubElo slug yet — left out deliberately rather than guessed. If it
  // shows up in "[elo] no ClubElo slug candidates configured" logs, check
  // clubelo.com directly for its real slug and add it here.
};

const eloCache = new Map(); // slug candidates key -> elo number, per run.js process

// The club's page opens with a line like:
//   Elo: 2039 (Best: 2045, reached on 2026-03-07), Golo: 1.0
// This matches just the "Elo: NNNN" part — deliberately anchored on the
// colon so it can't accidentally match the "Elo" column header that shows
// up elsewhere on the same page (the ranking table, the calculation log).
const ELO_LINE_RE = /Elo:\s*(\d+(?:\.\d+)?)/;

// Returns { ok: true, elo } on success or { ok: false, reason } on any
// failure — never throws. Distinguishing WHY a slug failed (page-load
// error vs HTTP status vs no matching "Elo:" line) is the whole point: it's
// what lets fetchLatestElo's warning below tell a genuinely wrong slug
// guess apart from ClubElo being unreachable or blocking this scraper
// entirely.
async function fetchLatestEloForSlug(slug) {
  const url = `https://clubelo.com/${encodeURIComponent(slug)}`;
  try {
    return await withPage(async (page) => {
      let res;
      try {
        res = await page.goto(url, { waitUntil: "networkidle", timeout: 45000 });
      } catch (err) {
        return { ok: false, reason: `page load failed (${err?.message || err})` };
      }
      if (res && !res.ok()) {
        return { ok: false, reason: `HTTP ${res.status()}` };
      }
      const text = await page.innerText("body");
      const match = text.match(ELO_LINE_RE);
      if (!match) {
        return { ok: false, reason: `no "Elo:" line found on the page` };
      }
      const elo = parseFloat(match[1]);
      if (!Number.isFinite(elo)) {
        return { ok: false, reason: `could not parse a numeric Elo value from "${match[0]}"` };
      }
      return { ok: true, elo };
    });
  } catch (err) {
    return { ok: false, reason: `network error (${err?.message || err})` };
  }
}

async function fetchLatestElo(teamName) {
  const candidates = ELO_NAME_CANDIDATES[teamName];
  if (!candidates) {
    console.warn(`[elo] no ClubElo slug candidates configured for "${teamName}"`);
    return null;
  }
  const cacheKey = teamName;
  if (eloCache.has(cacheKey)) return eloCache.get(cacheKey);

  const failures = [];
  for (const slug of candidates) {
    const result = await fetchLatestEloForSlug(slug);
    if (result.ok) {
      eloCache.set(cacheKey, result.elo);
      return result.elo;
    }
    failures.push(`${slug} → ${result.reason}`);
  }
  console.warn(`[elo] no working ClubElo slug for "${teamName}": ${failures.join("; ")}`);
  eloCache.set(cacheKey, null);
  return null;
}

function poissonPmf(k, lambda) {
  let logP = -lambda + k * Math.log(lambda);
  for (let i = 2; i <= k; i++) logP -= Math.log(i);
  return Math.exp(logP);
}

// Elo win-expectancy alone can only tell you an expected POINTS share, not
// a clean win/draw/loss split — so, purely to derive that split, this still
// runs a Poisson model off a generic (league-average) goal total. That
// generic goal total is fine here because only the resulting win/draw/loss
// shape is used — the actual goal-count-sensitive markets (Over/Under,
// Correct Score, Handicap) are deliberately left to goalsModel.js, which
// uses real scoring data instead of this generic assumption.
export function computeEloPrediction(homeElo, awayElo) {
  const HOME_ADV = 100;
  const dr = homeElo - awayElo + HOME_ADV;

  const expGoalDiff = dr / 173; // ~173 Elo points ≈ 1 goal, a commonly cited approximation
  const AVG_TOTAL_GOALS = 2.7; // Premier League long-run rough average
  const homeExp = Math.max(0.35, AVG_TOTAL_GOALS / 2 + expGoalDiff / 2);
  const awayExp = Math.max(0.35, AVG_TOTAL_GOALS / 2 - expGoalDiff / 2);

  const MAX_GOALS = 8;
  let pHome = 0, pDraw = 0, pAway = 0;
  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      const p = poissonPmf(h, homeExp) * poissonPmf(a, awayExp);
      if (h > a) pHome += p;
      else if (h === a) pDraw += p;
      else pAway += p;
    }
  }

  const round = (x) => Math.round(x * 100);
  return { winProb: { home: round(pHome), draw: round(pDraw), away: round(pAway) } };
}

export async function fetchEloPrediction(home, away) {
  try {
    const [homeElo, awayElo] = await Promise.all([fetchLatestElo(home), fetchLatestElo(away)]);
    if (homeElo == null || awayElo == null) return null;

    const calc = computeEloPrediction(homeElo, awayElo);
    return {
      prob: {
        source: "Club Elo (calculated)",
        url: "https://clubelo.com/",
        home: calc.winProb.home,
        draw: calc.winProb.draw,
        away: calc.winProb.away,
      },
    };
  } catch (err) {
    console.warn(`[elo] failed for ${home} vs ${away}:`, err.message);
    return null;
  }
}
