// Canonical Premier League club names + common aliases used by fixture/
// prediction sources, so text scraped from different sites can be matched
// to the same fixture. Extend this list if a club is promoted/relegated.
export const TEAM_ALIASES = {
  "Arsenal": ["Arsenal"],
  "Aston Villa": ["Aston Villa", "Villa"],
  "Bournemouth": ["Bournemouth", "AFC Bournemouth"],
  "Brentford": ["Brentford"],
  "Brighton and Hove Albion": ["Brighton", "Brighton & Hove Albion", "Brighton and Hove Albion"],
  "Burnley": ["Burnley"],
  "Chelsea": ["Chelsea"],
  "Crystal Palace": ["Crystal Palace", "Palace"],
  "Everton": ["Everton"],
  "Fulham": ["Fulham"],
  "Leeds United": ["Leeds", "Leeds United"],
  "Liverpool": ["Liverpool"],
  "Manchester City": ["Man City", "Manchester City"],
  "Manchester United": ["Man Utd", "Man United", "Manchester United"],
  "Newcastle United": ["Newcastle", "Newcastle United"],
  "Nottingham Forest": ["Nottingham Forest", "Nott'm Forest", "Forest"],
  "Sunderland": ["Sunderland"],
  "Tottenham Hotspur": ["Tottenham", "Spurs", "Tottenham Hotspur"],
  "West Ham United": ["West Ham", "West Ham United"],
  "Wolverhampton Wanderers": ["Wolves", "Wolverhampton Wanderers", "Wolverhampton"],
  "Ipswich Town": ["Ipswich", "Ipswich Town"],
  "Leicester City": ["Leicester", "Leicester City"],
  "Southampton": ["Southampton"],

  // Champions League — major European clubs likely to appear in a given
  // season's league-phase draw. This list is deliberately best-effort, not
  // exhaustive: canonicalTeam()'s partial-match fallback below already
  // handles most unlisted clubs reasonably (a club not listed here just
  // keeps its source-provided name rather than getting normalized across
  // sources) — same graceful, "never fabricate" degrade as the rest of
  // this project. Extend this list as real CL fixtures reveal club-name
  // mismatches between football-data.org and the scraped prediction sites.
  "Real Madrid": ["Real Madrid", "Real Madrid CF"],
  "Barcelona": ["Barcelona", "FC Barcelona", "Barça"],
  "Atletico Madrid": ["Atletico Madrid", "Atlético Madrid", "Atletico de Madrid", "Club Atlético de Madrid"],
  "Bayern Munich": ["Bayern Munich", "Bayern München", "FC Bayern München", "Bayern"],
  "Borussia Dortmund": ["Borussia Dortmund", "Dortmund", "BVB"],
  "RB Leipzig": ["RB Leipzig", "Leipzig"],
  "Bayer Leverkusen": ["Bayer Leverkusen", "Leverkusen", "Bayer 04 Leverkusen"],
  "Paris Saint-Germain": ["Paris Saint-Germain", "PSG", "Paris SG"],
  "Monaco": ["Monaco", "AS Monaco"],
  "Marseille": ["Marseille", "Olympique de Marseille", "OM"],
  "Juventus": ["Juventus", "Juventus FC", "Juve"],
  "Inter Milan": ["Inter Milan", "Inter", "FC Internazionale Milano", "Internazionale"],
  "AC Milan": ["AC Milan", "Milan"],
  "Napoli": ["Napoli", "SSC Napoli"],
  "Atalanta": ["Atalanta", "Atalanta BC"],
  "Benfica": ["Benfica", "SL Benfica"],
  "Porto": ["Porto", "FC Porto"],
  "Sporting CP": ["Sporting CP", "Sporting Clube de Portugal", "Sporting Lisbon"],
  "Ajax": ["Ajax", "AFC Ajax"],
  "PSV Eindhoven": ["PSV Eindhoven", "PSV"],
  "Feyenoord": ["Feyenoord", "Feyenoord Rotterdam"],
  "Club Brugge": ["Club Brugge", "Club Brugge KV"],
  "Union Saint-Gilloise": ["Union Saint-Gilloise", "Royale Union Saint-Gilloise"],
  "Celtic": ["Celtic", "Celtic FC"],
  "Shakhtar Donetsk": ["Shakhtar Donetsk", "Shakhtar"],
  "Dynamo Kyiv": ["Dynamo Kyiv", "Dynamo Kiev"],
  "Red Bull Salzburg": ["Red Bull Salzburg", "RB Salzburg", "Salzburg"],
  "Sturm Graz": ["Sturm Graz"],
  "Slavia Prague": ["Slavia Prague", "SK Slavia Praha"],
  "Sparta Prague": ["Sparta Prague", "AC Sparta Praha"],
  "Galatasaray": ["Galatasaray", "Galatasaray SK"],
  "Fenerbahce": ["Fenerbahce", "Fenerbahçe"],
  "Olympiacos": ["Olympiacos", "Olympiacos FC"],
  "PAOK": ["PAOK", "PAOK FC"],
  "Bodo/Glimt": ["Bodo/Glimt", "Bodø/Glimt", "FK Bodø/Glimt"],
  "Copenhagen": ["Copenhagen", "FC København", "FC Copenhagen"],
  "Qarabag": ["Qarabag", "Qarabağ", "Qarabag FK"],
  "AS Roma": ["Roma", "AS Roma"],
  "Como": ["Como", "Como 1907"],
  "Villarreal": ["Villarreal", "Villarreal CF"],
  "Real Betis": ["Real Betis", "Real Betis Balompié", "Betis"],
  "Lille": ["Lille", "Lille OSC"],
  "AEK Athens": ["AEK Athens", "PAE AEK", "AEK"],
  "LASK": ["LASK", "LASK Linz"],

  // Bundesliga — full 2026-27 season list (18 clubs), cross-checked against
  // Wikipedia's 2026-27 Bundesliga season page and confirmed relegation/
  // promotion reporting (Sept 2026). This season's promoted clubs are
  // Schalke 04 (returning after 3 years out), SV Elversberg (first-ever
  // top-flight promotion), and SC Paderborn (won the playoff vs Wolfsburg);
  // Wolfsburg, Heidenheim and St. Pauli went the other way. Canonical
  // spellings here are kept ASCII (no ö/ü) to match what football-data.org
  // and the scraped English-language prediction sites consistently use —
  // the umlaut/accented forms are listed as aliases so a source that DOES
  // use them still resolves correctly. These same canonical strings are
  // reused as ClubElo lookup keys in elo.js — keep the two files in sync if
  // you ever rename an entry here.
  "Bayern Munich": ["Bayern Munich", "Bayern München", "FC Bayern München", "Bayern", "FC Bayern"],
  "Borussia Dortmund": ["Borussia Dortmund", "Dortmund", "BVB"],
  "Bayer Leverkusen": ["Bayer Leverkusen", "Bayer 04 Leverkusen", "Leverkusen"],
  "RB Leipzig": ["RB Leipzig", "Leipzig"],
  "VfB Stuttgart": ["VfB Stuttgart", "Stuttgart"],
  "TSG 1899 Hoffenheim": ["TSG 1899 Hoffenheim", "Hoffenheim", "TSG Hoffenheim"],
  "SC Freiburg": ["SC Freiburg", "Freiburg"],
  "1. FSV Mainz 05": ["1. FSV Mainz 05", "Mainz 05", "Mainz", "FSV Mainz 05"],
  "FC Schalke 04": ["FC Schalke 04", "Schalke 04", "Schalke"],
  "SV Elversberg": ["SV Elversberg", "Elversberg", "SV 07 Elversberg"],
  "SC Paderborn 07": ["SC Paderborn 07", "SC Paderborn", "Paderborn"],
  "1. FC Köln": ["1. FC Köln", "FC Köln", "Köln", "Cologne", "1. FC Koln", "Koln"],
  "SV Werder Bremen": ["SV Werder Bremen", "Werder Bremen", "Werder", "Bremen"],
  "Hamburger SV": ["Hamburger SV", "Hamburg", "HSV"],
  "1. FC Union Berlin": ["1. FC Union Berlin", "Union Berlin", "Union"],
  "FC Augsburg": ["FC Augsburg", "Augsburg"],
  "Borussia Mönchengladbach": ["Borussia Mönchengladbach", "Borussia Monchengladbach", "Gladbach", "Borussia M'gladbach", "Mönchengladbach"],
  "Eintracht Frankfurt": ["Eintracht Frankfurt", "Frankfurt", "Eintracht"],

  // La Liga — full 2026-27 season list (20 clubs), same cross-checked
  // sourcing as Bundesliga above. This season's promoted clubs are Racing
  // Santander (Segunda champion, first top flight season since 2011-12),
  // Deportivo de La Coruña (Segunda runner-up, back after 8 years out), and
  // Málaga (playoff winner, back after relegation in 2017-18); Real
  // Oviedo, Girona and RCD Mallorca went down. Same ASCII-canonical /
  // accented-alias convention as above, and same "keep elo.js in sync"
  // note. Real Madrid, Barcelona, Atletico Madrid, Real Betis, and
  // Villarreal are NOT repeated here — they're already defined above in the
  // Champions League block (same clubs, same canonical spelling already
  // matches), so adding them again would just be a harmless-but-confusing
  // duplicate key.
  "Athletic Club": ["Athletic Club", "Athletic Bilbao", "Athletic"],
  "Real Sociedad": ["Real Sociedad", "Real Sociedad de Fútbol", "La Real"],
  "Sevilla": ["Sevilla", "Sevilla FC"],
  "Valencia": ["Valencia", "Valencia CF"],
  "Celta Vigo": ["Celta Vigo", "RC Celta de Vigo", "Celta", "RC Celta"],
  "Osasuna": ["Osasuna", "CA Osasuna"],
  "Getafe": ["Getafe", "Getafe CF"],
  "Alaves": ["Alaves", "Deportivo Alavés", "Alavés"],
  "Rayo Vallecano": ["Rayo Vallecano", "Rayo"],
  "Espanyol": ["Espanyol", "RCD Espanyol", "RCD Espanyol de Barcelona"],
  "Levante": ["Levante", "Levante UD"],
  "Elche": ["Elche", "Elche CF"],
  "Racing Santander": ["Racing Santander", "Racing de Santander", "Racing"],
  "Deportivo La Coruna": ["Deportivo La Coruna", "Deportivo de La Coruña", "Deportivo La Coruña", "Deportivo", "RC Deportivo"],
  "Malaga": ["Malaga", "Málaga", "Málaga CF", "Malaga CF"],
};

const FLAT_ALIASES = Object.entries(TEAM_ALIASES).flatMap(([canonical, names]) =>
  names.map((n) => [n.toLowerCase(), canonical])
);

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Resolve any spelling/short-name of a club to its canonical name, or return
// the input unchanged if unrecognized (better to keep an unrecognized name
// visible than silently drop the fixture).
export function canonicalTeam(name) {
  if (!name) return name;
  // football-data.org names include the club suffix, e.g. "Arsenal FC",
  // "AFC Bournemouth" — strip that before matching against our aliases.
  const stripped = name.trim().replace(/^AFC\s+/i, "").replace(/\s+F\.?C\.?$/i, "").trim();
  const lower = stripped.toLowerCase();
  const exact = FLAT_ALIASES.find(([alias]) => alias === lower);
  if (exact) return exact[1];
  // Fallback for a name that isn't an exact alias match but clearly contains
  // (or is contained by) one — e.g. a source sending "Hotspur" alone should
  // still resolve via the "Tottenham Hotspur" alias. This MUST be checked on
  // whole-word boundaries, never as a raw substring: a plain .includes() once
  // matched "AS Roma" and "Como" to Marseille's short alias "OM", purely
  // because "om" happens to appear inside the letters "r-om-a" / "c-om-o" —
  // and would do the same to "Villarreal" via Aston Villa's "Villa" alias.
  // \b anchors the match to real word edges so a short alias can only match
  // a real standalone word/phrase, not a coincidental run of letters inside
  // an unrelated club name.
  const partial = FLAT_ALIASES.find(([alias]) => {
    const aliasInName = new RegExp(`\\b${escapeRegExp(alias)}\\b`, "i").test(lower);
    const nameInAlias = new RegExp(`\\b${escapeRegExp(lower)}\\b`, "i").test(alias);
    return aliasInName || nameInAlias;
  });
  return partial ? partial[1] : stripped;
}

export function slugify(home, away) {
  const s = (t) => t.toLowerCase().replace(/[^a-z]+/g, "").slice(0, 4);
  return `${s(home)}-${s(away)}`;
}
