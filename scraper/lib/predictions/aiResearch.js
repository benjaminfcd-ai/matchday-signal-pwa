// AI Research — the one source in this project that IS an AI doing
// research, rather than a fixed scrape of one page. It asks Claude (via
// the Anthropic API's web_search tool) to do the same kind of broad,
// multi-site comparison a person would get asking ChatGPT directly:
// check a wide spread of independent football sites/prediction models for
// one specific fixture, then synthesize a single honest reading — rather
// than reading just one page the way opta.js/wincomparator.js/
// soccervista.js each do.
//
// HARD RULE (same as everywhere else in this project): never fabricate.
// The prompt below tells Claude explicitly to return nulls when it can't
// find real, checkable numbers for THIS fixture across enough sources,
// and this file re-validates the shape of whatever comes back (percentages
// must be real numbers that roughly sum to 100) before trusting it —
// malformed or missing output is discarded exactly like a network failure
// from any other source would be. There is no fallback guess.
//
// SETUP REQUIRED (see README):
//   1. An ANTHROPIC_API_KEY GitHub Actions secret — get one at
//      console.anthropic.com → API Keys.
//   2. Web search enabled for that key: console.anthropic.com → Settings →
//      "Web search" toggle. Without this, every call here fails with a 400
//      and this source just contributes nothing that run — same graceful
//      "no reading yet" degrade as any other source having a bad day, not
//      a crash.
//
// COST: web search is billed at $10 per 1,000 searches (flat, regardless
// of what's found) plus ordinary token cost for reading the results. At
// MAX_SEARCHES below, the worst case is roughly $0.12-0.15 in search fees
// per fixture, per (re-)research pass — and a fixture gets re-researched
// every 3 hours once it's inside its RESEARCH_WINDOW_HOURS window (see
// run.js), same as every other source, so a single fixture can be
// (re-)researched up to ~4 times before kickoff. For a typical ~10-fixture
// Premier League round that's on the order of a few dollars total, all in;
// lower MAX_SEARCHES below to cut that further if it ever matters.
const SOURCE_NAME = "AI Research (multi-source)";
const MODEL = "claude-sonnet-5";
const MAX_SEARCHES = 12;

const COMPETITION_LABEL = { PL: "Premier League", CL: "UEFA Champions League", BL1: "Bundesliga", PD: "La Liga" };

function buildPrompt(home, away, competition) {
  const label = COMPETITION_LABEL[competition] || "football";
  return `You are researching one upcoming ${label} fixture: ${home} vs ${away}.

Search the web broadly for this specific fixture — the way a thorough human researcher comparing many sites would, not just the first result you find. Check a wide spread of independent, real football prediction/analytics sources (for example: BBC Sport, Sky Sports, ESPN, WhoScored, FotMob, Forebet, SoccerVista, Football Web Pages, Opta/The Analyst, statistical models, and any other real site that publishes something specific to this fixture — use your own judgment on which real sites actually have relevant content). Aim for at least 8-10 distinct real sources checked before answering; do more if what you find is inconsistent.

For each source, note what it says (when published) about: match winner (home/draw/away), predicted correct score, over/under 2.5 goals, and Asian handicap.

Then synthesize ONE honest reading:
- A single home/draw/away win probability as your best synthesis across everything you actually found (should sum to roughly 100).
- The most commonly-cited correct score prediction, if any source published one.
- The most commonly-cited over/under 2.5 goals pick, if any.
- The most commonly-cited handicap line, if any.

CRITICAL — do not guess or fabricate. If you cannot find real, checkable, fixture-specific predictions across enough sources to say anything meaningful, return nulls for whatever you couldn't actually find rather than inventing plausible-looking numbers. It is always better to say "not enough real data" than to make something up. Only report a "sourcesChecked" count and "sourceNames" for sites where you actually found content specific to this fixture, not sites you merely queried and got nothing useful from.

End your response with ONLY a single JSON object — no other text after it, no markdown code fences around it — in exactly this shape:
{"home": <number 0-100 or null>, "draw": <number 0-100 or null>, "away": <number 0-100 or null>, "correctScore": "<e.g. 2-1, or null>", "overUnder": {"pick": "Over 2.5 or Under 2.5", "pct": <number or null>} or null, "handicap": "<e.g. Arsenal -1, or null>", "sourcesChecked": <integer count of distinct real sites with fixture-specific content>, "sourceNames": ["<short site name>", ...]}`;
}

function extractJson(text) {
  const start = text.lastIndexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function isValidPct(n) {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 100;
}

let warnedMissingKey = false;

export async function fetchAiResearchPrediction(home, away, competition = "PL") {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Not an error — just not configured yet. Warn once per run (not once
    // per fixture) so a run without this secret set doesn't flood the log.
    if (!warnedMissingKey) {
      console.warn("[ai-research] ANTHROPIC_API_KEY not set — this source will contribute nothing until it's added as a GitHub Actions secret (see README).");
      warnedMissingKey = true;
    }
    return null;
  }

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2048,
        messages: [{ role: "user", content: buildPrompt(home, away, competition) }],
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: MAX_SEARCHES }],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(`[ai-research] API error ${res.status} for ${home} vs ${away}: ${body.slice(0, 300)}`);
      return null;
    }

    const data = await res.json();
    // The final assistant turn is the last "text" content block in the
    // response — earlier blocks are the tool-use/tool-result pairs from
    // the searches themselves (this is one API call start to finish; the
    // web_search tool runs server-side, no back-and-forth needed here).
    const textBlocks = (data.content || []).filter((b) => b.type === "text");
    const finalText = textBlocks[textBlocks.length - 1]?.text || "";
    const parsed = extractJson(finalText);
    if (!parsed) {
      console.warn(`[ai-research] couldn't find a parseable JSON reading for ${home} vs ${away} — treating as no reading (not a fabricated guess).`);
      return null;
    }

    const { home: h, draw: d, away: a } = parsed;
    let prob = null;
    if (isValidPct(h) && isValidPct(d) && isValidPct(a) && Math.abs(h + d + a - 100) <= 6) {
      prob = { source: SOURCE_NAME, url: null, home: Math.round(h), draw: Math.round(d), away: Math.round(a) };
    }

    const extras = [];
    if (typeof parsed.correctScore === "string" && /^\d+\s?[-:]\s?\d+$/.test(parsed.correctScore.trim())) {
      extras.push({ market: "Correct Score", pick: parsed.correctScore.trim().replace(/\s/g, "").replace(":", "-"), pct: null, source: SOURCE_NAME });
    }
    if (parsed.overUnder && (parsed.overUnder.pick === "Over 2.5" || parsed.overUnder.pick === "Under 2.5")) {
      extras.push({
        market: "Over/Under 2.5",
        pick: parsed.overUnder.pick,
        pct: isValidPct(parsed.overUnder.pct) ? Math.round(parsed.overUnder.pct) : null,
        source: SOURCE_NAME,
      });
    }
    if (typeof parsed.handicap === "string" && parsed.handicap.trim()) {
      extras.push({ market: "Handicap", pick: parsed.handicap.trim(), pct: null, source: SOURCE_NAME });
    }
    if (Number.isInteger(parsed.sourcesChecked) && parsed.sourcesChecked > 0) {
      const names = Array.isArray(parsed.sourceNames) ? parsed.sourceNames.filter((n) => typeof n === "string" && n.trim()) : [];
      extras.push({
        market: "Sources Checked",
        pick: `${parsed.sourcesChecked} site${parsed.sourcesChecked === 1 ? "" : "s"}${names.length ? ` (${names.slice(0, 6).join(", ")}${names.length > 6 ? ", ..." : ""})` : ""}`,
        pct: null,
        source: SOURCE_NAME,
      });
    }

    if (!prob && extras.length === 0) return null;
    return { prob, extras };
  } catch (err) {
    console.warn(`[ai-research] failed for ${home} vs ${away} (${competition}):`, err.message);
    return null;
  }
}
