// Club Elo (clubelo.com) — a well-established, independently maintained Elo
// rating system for club football, published as a plain CSV API (no login,
// no bot protection — it's built for programmatic use, unlike the sites
// this project scrapes). This module is different from the others: instead
// of reading someone else's published prediction, it fetches raw Elo
// ratings and CALCULATES a win/draw/loss prediction from them — real
// probability math, not a number lifted off a page.
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
// NOTE ON TEAM NAME SLUGS: ClubElo's per-club URLs use their own short
// slugs (e.g. "ManCity", not "Manchester City"). The mapping below is a
// best-effort guess at those slugs with a couple of fallback candidates per
// club — this is the piece most likely to need correcting once you see a
// real run's logs (a "[elo] no working ClubElo slug for X" warning means
// every candidate for that club failed; check clubelo.com directly for its
// real slug and add it to the candidates list below).
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
};

const eloCache = new Map(); // slug candidates key -> elo number, per run.js process

async function fetchLatestEloForSlug(slug) {
  const url = `http://api.clubelo.com/${encodeURIComponent(slug)}`;
  const res = await fetch(url, { headers: { "User-Agent": "matchday-signal-scraper/1.0" } });
  if (!res.ok) return null;
  const csv = (await res.text()).trim();
  const lines = csv.split("\n").filter(Boolean);
  if (lines.length < 2) return null;
  const header = lines[0].split(",");
  const eloIdx = header.indexOf("Elo");
  if (eloIdx === -1) return null;
  const last = lines[lines.length - 1].split(",");
  const elo = parseFloat(last[eloIdx]);
  return Number.isFinite(elo) ? elo : null;
}

async function fetchLatestElo(teamName) {
  const candidates = ELO_NAME_CANDIDATES[teamName];
  if (!candidates) {
    console.warn(`[elo] no ClubElo slug candidates configured for "${teamName}"`);
    return null;
  }
  const cacheKey = teamName;
  if (eloCache.has(cacheKey)) return eloCache.get(cacheKey);

  for (const slug of candidates) {
    try {
      const elo = await fetchLatestEloForSlug(slug);
      if (elo != null) {
        eloCache.set(cacheKey, elo);
        return elo;
      }
    } catch {
      // try the next candidate slug
    }
  }
  console.warn(`[elo] no working ClubElo slug for "${teamName}" (tried: ${candidates.join(", ")})`);
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
        url: "http://clubelo.com/",
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
