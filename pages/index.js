import { useEffect, useMemo, useState, useCallback } from "react";
import Head from "next/head";
import { supabase } from "../lib/supabaseClient";
import { computeRoundAccuracy } from "../lib/results";

const TZ = "Asia/Ho_Chi_Minh";

// This one round only had 3 of its 10 fixtures actually researched before a
// since-fixed scraper bug (see scraper/run.js) — a 3-game sample makes the
// accuracy badge (0/3 — 0%) more misleading than informative. Rather than a
// general small-sample rule, this just suppresses the badge for this one
// archived round by its label; the real graded count stays visible, nothing
// is invented. Safe to delete once this round ages out of "Past rounds".
const HIDE_ACCURACY_FOR_ROUNDS = new Set(["Premier League · 2026-09-04 – 2026-09-06"]);
const AGREE_LABEL = { good: "Models agree", warn: "Models lean, not sure", bad: "Models conflict", split: "Split, tight" };

function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: TZ });
  } catch { return "--:--"; }
}
function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: TZ });
  } catch { return ""; }
}
// Stable "YYYY-MM-DD" grouping key in ICT — used to bucket fixtures by
// matchday for the day tabs, independent of the display format above.
function dayKey(iso) {
  try {
    return new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ });
  } catch { return ""; }
}
function fmtStamp(iso) {
  if (!iso) return "Last analyzed —";
  try {
    return "Last analyzed " + new Date(iso).toLocaleString("en-GB", {
      day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: TZ,
    }) + " (ICT)";
  } catch { return "Last analyzed —"; }
}

// Mirrors scraper/lib/agreement.js's favoredSide() — kept as a small local
// copy (same pattern as lib/results.js) since this runs client-side against
// data already in the browser, to find the single most one-sided individual
// reading for the Hero "Highest single reading" card. Not used to compute
// "Our Prediction" itself — that consensus is precomputed server-side and
// arrives on m.standout.
function favoredSide(p) {
  if (p.home != null && p.draw != null && p.away != null) {
    const entries = [["home", p.home], ["draw", p.draw], ["away", p.away]];
    entries.sort((a, b) => b[1] - a[1]);
    return { label: entries[0][0], value: entries[0][1] };
  }
  if (p.home != null) return { label: "home", value: p.home };
  if (p.away != null) return { label: "away", value: p.away };
  return null;
}

// Rows written before Champions League support existed have no
// `competition` column value other than the schema default — defaulting to
// "PL" here client-side too means an older row displays exactly where it
// always has, with no migration needed.
function rowToMatch(r) {
  return {
    id: r.id, competition: r.competition || "PL", home: r.home, away: r.away, kickoffLocal: r.kickoff_local,
    homeCrest: r.home_crest || null, awayCrest: r.away_crest || null,
    status: r.status, score: r.score,
    probs: r.probs || [], extras: r.extras || [], standout: r.standout || {},
    agreement: r.agreement, agreementNote: r.agreement_note, forebetNote: r.forebet_note,
  };
}

// Mirrors scraper/run.js's metaId()/competitionLabel() — the Premier League
// meta row keeps its original id ("status") untouched; Champions League
// gets its own row at "status_CL" instead of a schema change.
function metaId(competition) {
  return competition === "PL" ? "status" : `status_${competition}`;
}
const COMPETITIONS = [
  { id: "PL", label: "Premier League" },
  { id: "CL", label: "Champions League" },
];

// A small team badge — renders nothing (rather than a broken-image icon) for
// older fixtures scraped before crest URLs were captured; self-heals once
// that fixture is next (re-)researched. See scraper/run.js.
function Crest({ src, alt }) {
  if (!src) return null;
  return <img className="crest" src={src} alt={alt} loading="lazy" />;
}

function ProbBars({ p, home, away }) {
  // A source can publish just one side (e.g. Wincomparator always does) —
  // that value can land in EITHER p.home or p.away depending on which team
  // it favors, so both must be checked here, not just p.home, or a real
  // away-favored single-side reading gets wrongly reported as unpublished.
  // A bare percentage means nothing to a visitor without the team it
  // belongs to, so name the actual favored team rather than just "home".
  if (p.home == null || p.draw == null || p.away == null) {
    const singleSidePct = p.home != null ? p.home : p.away;
    const favoredTeam = p.home != null ? home : away;
    return (
      <div className="prob-row">
        <div className="src"><span>{p.source}</span></div>
        <div className="prob-na">
          {singleSidePct != null
            ? `${favoredTeam} to win — ${singleSidePct}% (only side published)`
            : "Not published for this fixture"}
        </div>
      </div>
    );
  }
  return (
    <div className="prob-row">
      <div className="src"><span>{p.source}</span><span>{p.home}% / {p.draw}% / {p.away}%</span></div>
      <div className="prob-bars">
        <div className="prob-seg home" style={{ flex: p.home }} />
        <div className="prob-seg draw" style={{ flex: p.draw }} />
        <div className="prob-seg away" style={{ flex: p.away }} />
      </div>
    </div>
  );
}

// Every source is still shown — nothing is hidden or dropped — but Opta and
// Wincomparator are pulled out as the two featured reads (per the site's
// stated flow: Our Prediction → Opta → Wincomparator → the rest), with any
// remaining sources (SoccerVista, Club Elo, ...) tucked under a collapsed
// "+N more sources" toggle so the card isn't a wall of equally-weighted
// numbers. A fixture missing Opta or Wincomparator just skips that slot.
const FEATURED_SOURCES = ["Opta Analyst", "Wincomparator"];

function MatchCard({ m, open, onToggle }) {
  const isLive = m.status === "upcoming" && new Date(m.kickoffLocal).getTime() < Date.now();
  const featured = FEATURED_SOURCES
    .map((name) => (m.probs || []).find((p) => p.source === name))
    .filter(Boolean);
  const others = (m.probs || []).filter((p) => !FEATURED_SOURCES.includes(p.source));
  return (
    <div className={`match ${open ? "open" : ""} ${m.status === "finished" ? "is-finished" : ""}`}>
      <div className="match-head" onClick={() => onToggle(m.id)}>
        <div>
          <div className="teams">
            <Crest src={m.homeCrest} alt="" />
            {m.home} vs {m.away}
            <Crest src={m.awayCrest} alt="" />
          </div>
          <div className="meta-line">
            {m.status === "finished"
              ? "Full time"
              : `${fmtDate(m.kickoffLocal)} · ${fmtTime(m.kickoffLocal)} ICT`}
          </div>
        </div>
        <div className="head-right">
          {m.status === "finished" ? (
            <span className="status-chip">Final {m.score || ""}</span>
          ) : isLive ? (
            <span className="status-chip live">Live</span>
          ) : null}
          {m.agreement && (
            <span className={`agree-chip ${m.agreement}`}>{AGREE_LABEL[m.agreement] || m.agreement}</span>
          )}
          <svg className="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </div>
      </div>
      <div className="match-body">
        {m.standout && m.standout.pick && (
          <div className="standout">
            <div className="label">Our Prediction</div>
            <div className="pick">
              {m.standout.pick}
              {m.standout.pct != null ? ` — ${m.standout.pct}%` : ""}
            </div>
            {m.standout.totalSources > 0 && (
              <div className="consensus-line">
                {m.standout.sourcesUsed === m.standout.totalSources
                  ? `All ${m.standout.totalSources} sources checked agree on this`
                  : `${m.standout.sourcesUsed} of ${m.standout.totalSources} sources checked favor this`}
              </div>
            )}
            {m.standout.note && <div className="note">{m.standout.note}</div>}
          </div>
        )}
        {m.probs && m.probs.length > 0 ? (
          <>
            {featured.length > 0 ? (
              <div className="probs">
                {featured.map((p, i) => <ProbBars key={i} p={p} home={m.home} away={m.away} />)}
              </div>
            ) : (
              others.length > 0 && (
                <div className="prob-na">Opta and Wincomparator aren't published yet for this fixture — see sources below.</div>
              )
            )}
            {others.length > 0 && (
              <details className="more-sources">
                <summary>+ {others.length} more source{others.length > 1 ? "s" : ""}</summary>
                <div className="probs">
                  {others.map((p, i) => <ProbBars key={i} p={p} home={m.home} away={m.away} />)}
                </div>
              </details>
            )}
          </>
        ) : (
          <div className="prob-na">No numeric source accessible for this fixture yet.</div>
        )}
        {m.extras && m.extras.length > 0 && (
          <>
            <div className="extra-title">Other signals</div>
            <div className="extras">
              {m.extras.map((e, i) => (
                <span className="extra-tag" key={i}><b>{e.pick}</b> — {e.market}{e.pct != null ? ` (${e.pct}%)` : ""} · {e.source}</span>
              ))}
            </div>
          </>
        )}
        {(m.agreementNote || m.forebetNote) && (
          <div className="note">{m.agreementNote}{m.forebetNote ? " " + m.forebetNote : ""}</div>
        )}
      </div>
    </div>
  );
}

function Hero({ matches }) {
  const candidates = matches.filter((m) => m.status !== "finished" || m.probs.length);
  // "Most agreed-upon" — m.agreement === "good" already means every source
  // checked favored the same side with decent average confidence (see
  // scraper/lib/agreement.js), so this needs no extra unanimity flag.
  const unanimous = candidates.find((m) => m.agreement === "good");
  // "Highest single reading" is deliberately NOT read from m.standout — that
  // field is now "Our Prediction" (a consensus across sources). This scans
  // every source's own raw reading across every match to find the single
  // most one-sided number actually published this round, and names which
  // source published it.
  const highest = candidates.reduce((best, m) => {
    for (const p of m.probs || []) {
      const r = favoredSide(p);
      if (!r) continue;
      if (!best || r.value > best.value) best = { ...r, source: p.source, match: m };
    }
    return best;
  }, null);

  if (!unanimous && !highest) return null;

  return (
    <div className="hero">
      {unanimous && (
        <div className="hero-block">
          <div className="eyebrow"><span className="dot" />Most agreed-upon</div>
          <div className="hero-title">
            {unanimous.standout.pick === "Draw"
              ? `${unanimous.home} vs ${unanimous.away} — Draw`
              : `${unanimous.standout.pick} to beat ${
                  unanimous.standout.pick === unanimous.home ? unanimous.away : unanimous.home
                }`}
          </div>
          <p className="hero-desc">Every model checked points the same way — direction is solid, though confidence varies by source.</p>
        </div>
      )}
      {highest && (
        <div className="hero-block">
          <div className="eyebrow"><span className="dot" />Highest single reading</div>
          <div className="hero-title">
            {highest.label === "draw" ? "Draw" : highest.label === "home" ? highest.match.home : highest.match.away}
            , {highest.match.home} vs {highest.match.away}
          </div>
          <p className="hero-desc"><b>{highest.value}%</b> from {highest.source} — the single most one-sided number found this round.</p>
        </div>
      )}
    </div>
  );
}

// Position bands are the standard EPL convention this season: top 4 into the
// Champions League, 5th into the Europa League, bottom 3 relegated. Purely a
// visual cue — the numbers themselves come straight from football-data.org.
function zoneClass(position) {
  if (position <= 4) return "ucl";
  if (position === 5) return "uel";
  if (position >= 18) return "rel";
  return "";
}

function StandingsTable({ standings }) {
  const rows = standings?.rows || [];
  if (!rows.length) {
    return (
      <div className="empty-state">
        <h3>Table not available yet</h3>
        <p>The league table is refreshed on the same schedule as predictions — check back shortly.</p>
      </div>
    );
  }
  return (
    <div className="table-wrap">
      <table className="standings">
        <thead>
          <tr>
            <th className="num">#</th>
            <th className="team-col">Team</th>
            <th className="num">MP</th>
            <th className="num">W</th>
            <th className="num">D</th>
            <th className="num">L</th>
            <th className="num">GD</th>
            <th className="num pts">Pts</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.team} className={zoneClass(r.position)}>
              <td className="num zone-cell"><span className="zone-bar" />{r.position}</td>
              <td className="team-col">
                <Crest src={r.crest} alt="" />
                {r.team}
              </td>
              <td className="num">{r.played}</td>
              <td className="num">{r.won}</td>
              <td className="num">{r.draw}</td>
              <td className="num">{r.lost}</td>
              <td className="num">{r.goalDifference > 0 ? `+${r.goalDifference}` : r.goalDifference}</td>
              <td className="num pts">{r.points}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="table-legend">
        <span><span className="zone-swatch ucl" />Champions League</span>
        <span><span className="zone-swatch uel" />Europa League</span>
        <span><span className="zone-swatch rel" />Relegation</span>
      </div>
    </div>
  );
}

export default function Home() {
  const [view, setView] = useState("this"); // this | past | table | how
  const [competition, setCompetition] = useState("PL"); // PL | CL — toggle at the top of "This round's signal"
  const [metaRows, setMetaRows] = useState([]); // both competitions' meta rows — pick the active one when rendering
  const [matches, setMatches] = useState([]);
  const [archived, setArchived] = useState([]);
  const [standings, setStandings] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [connected, setConnected] = useState(false);
  const [selectedDay, setSelectedDay] = useState(null); // null = "All"; task 1a — day tabs on Upcoming

  const loadAll = useCallback(async () => {
    if (!supabase) return;
    // meta is fetched without an id filter so both the Premier League
    // ("status") and Champions League ("status_CL") rows come back at
    // once — the toggle below just picks which one to show, no refetch.
    const [{ data: metaData }, { data: matchRows }, { data: archRows }, { data: standingsRow }] = await Promise.all([
      supabase.from("meta").select("*"),
      supabase.from("matches").select("*"),
      supabase.from("archived_rounds").select("*").order("archived_at", { ascending: false }),
      supabase.from("standings").select("*").eq("id", "current").maybeSingle(),
    ]);
    if (metaData) setMetaRows(metaData);
    if (matchRows) setMatches(matchRows.map(rowToMatch));
    if (archRows) setArchived(archRows);
    if (standingsRow) setStandings(standingsRow);
    setConnected(true);
  }, []);

  useEffect(() => {
    loadAll();
    if (!supabase) return;
    const channel = supabase
      .channel("matchday-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "matches" }, loadAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "meta" }, loadAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "archived_rounds" }, loadAll)
      .on("postgres_changes", { event: "*", schema: "public", table: "standings" }, loadAll)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [loadAll]);

  // "This round's signal" shows one competition at a time — the toggle
  // just swaps this filter, no refetch, since `matches` already holds both.
  const compMatches = useMemo(
    () => matches.filter((m) => m.competition === competition),
    [matches, competition]
  );
  const meta = useMemo(() => {
    const row = metaRows.find((r) => r.id === metaId(competition));
    return row || { round_label: COMPETITIONS.find((c) => c.id === competition)?.label || competition, last_updated: null };
  }, [metaRows, competition]);

  const sorted = useMemo(
    () => compMatches.slice().sort((a, b) => new Date(a.kickoffLocal) - new Date(b.kickoffLocal)),
    [compMatches]
  );

  // Past rounds gets the same toggle and filter as "This round's signal" —
  // archived_rounds rows carry their own `competition` (set at archive
  // time in scraper/run.js), defaulting to "PL" for rounds archived before
  // Champions League support existed.
  const compArchived = useMemo(
    () => archived.filter((r) => (r.competition || "PL") === competition),
    [archived, competition]
  );
  const upcoming = sorted.filter((m) => m.status !== "finished");
  const past = sorted.filter((m) => m.status === "finished");

  // task 1a — one tab per distinct matchday among the upcoming fixtures,
  // e.g. "Sat 12 Sept" / "Sun 13 Sept". Derived fresh from `upcoming` each
  // render so it stays correct as fixtures finish and drop out of the list.
  const upcomingDays = useMemo(() => {
    const seen = new Map();
    for (const m of upcoming) {
      const key = dayKey(m.kickoffLocal);
      if (key && !seen.has(key)) seen.set(key, { key, label: fmtDate(m.kickoffLocal) });
    }
    return Array.from(seen.values()).sort((a, b) => a.key.localeCompare(b.key));
  }, [upcoming]);

  // Guard against a stale selection (e.g. that day's last fixture just
  // finished and the tab disappeared) by falling back to "All" rather than
  // showing an empty list with no visible way back.
  const activeDay = selectedDay && upcomingDays.some((d) => d.key === selectedDay) ? selectedDay : null;
  const visibleUpcoming = activeDay ? upcoming.filter((m) => dayKey(m.kickoffLocal) === activeDay) : upcoming;

  const toggle = (id) => setOpenId((cur) => (cur === id ? null : id));

  return (
    <>
      <Head>
        <title>Premier League Signal — Match Predictions Compared</title>
        <meta
          name="description"
          content="Compare independent Premier League and Champions League match predictions from Opta Analyst, Forebet, Wincomparator, SoccerVista and Elo ratings, plus a self-built Poisson goals model. Auto-updated every 3 hours. No odds, no betting picks."
        />
      </Head>
      <div className="shell">
        <aside className="sidebar">
          <div className="brand">
            <div className="mark">PL</div>
            <div>
              <div className="name">Premier League Signal</div>
              <div className="sub">Predictions, compared</div>
            </div>
          </div>
          <nav>
            <div className={`nav-item ${view === "this" ? "active" : ""}`} onClick={() => setView("this")}>This round</div>
            <div className={`nav-item ${view === "past" ? "active" : ""}`} onClick={() => setView("past")}>Past rounds</div>
            <div className={`nav-item ${view === "table" ? "active" : ""}`} onClick={() => setView("table")}>Table</div>
            <div className={`nav-item ${view === "how" ? "active" : ""}`} onClick={() => setView("how")}>How this works</div>
          </nav>
          <div className="legend">
            <div className="legend-title">Sources checked</div>
            <div className="legend-row"><span>Opta Analyst</span><span className="dim">win probability</span></div>
            <div className="legend-row"><span>Forebet</span><span className="dim">1X2</span></div>
            <div className="legend-row"><span>Wincomparator</span><span className="dim">1X2 + goals</span></div>
            <div className="legend-row"><span>SoccerVista</span><span className="dim">1X2 + goals</span></div>
            <div className="legend-row"><span>Club Elo</span><span className="dim">win probability</span></div>
          </div>
          <div className="legend">
            <div className="legend-row">
              <span><span className="live-dot" /> {connected ? "Live" : "Connecting…"}</span>
            </div>
          </div>
        </aside>

        <main>
          {view === "this" && (
            <>
              <div className="comp-tabs">
                {COMPETITIONS.map((c) => (
                  <button
                    type="button"
                    key={c.id}
                    className={`comp-tab ${competition === c.id ? "active" : ""}`}
                    onClick={() => setCompetition(c.id)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>

              <div className="topbar">
                <div>
                  <h1>This round's signal</h1>
                  <div className="sub">{meta.round_label}</div>
                </div>
                <div className="sync">
                  <div className="stamp">{fmtStamp(meta.last_updated)}</div>
                  <span className="status-pill"><span className="live-dot" />Auto-updating</span>
                </div>
              </div>

              <Hero matches={compMatches} />

              <div className="section-label">Upcoming — kickoff times in Ho Chi Minh City (ICT)</div>

              {upcomingDays.length > 1 && (
                <div className="day-tabs">
                  <button
                    type="button"
                    className={`day-tab ${activeDay === null ? "active" : ""}`}
                    onClick={() => setSelectedDay(null)}
                  >
                    All
                  </button>
                  {upcomingDays.map((d) => (
                    <button
                      type="button"
                      key={d.key}
                      className={`day-tab ${activeDay === d.key ? "active" : ""}`}
                      onClick={() => setSelectedDay(d.key)}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>
              )}

              <div className="matches">
                {visibleUpcoming.length ? (
                  visibleUpcoming.map((m) => <MatchCard key={m.id} m={m} open={openId === m.id} onToggle={toggle} />)
                ) : (
                  <div className="empty-state">
                    <p style={{ margin: 0 }}>No upcoming {competition === "CL" ? "Champions League" : "Premier League"} fixtures left in this round — check back once the next round is analyzed.</p>
                  </div>
                )}
              </div>

              {past.length > 0 && (
                <>
                  <div className="section-label">Past games this round</div>
                  <div className="matches">
                    {past.map((m) => <MatchCard key={m.id} m={m} open={openId === m.id} onToggle={toggle} />)}
                  </div>
                </>
              )}

              <p className="footer-note">
                This page updates itself automatically — a scheduled job checks every fixture every 3 hours and (re-)researches it once it's within 12 hours of kickoff, writing straight to the database behind this page, so every open tab refreshes live with no button to press. Finished fixtures move into <b>Past games this round</b> as soon as they're checked and stay there through the weekend; the whole round moves to <b>Past rounds</b> once the last fixture is done.
              </p>
              <p className="footer-note">
                This site is a research tool, not betting advice — it doesn't encourage placing bets and makes no promise of accuracy or profit. Agreement between models is a signal, not a guarantee, about any specific match. If you choose to bet elsewhere, please only do so with money you can afford to lose.
              </p>
            </>
          )}

          {view === "past" && (
            <>
              <div className="comp-tabs">
                {COMPETITIONS.map((c) => (
                  <button
                    type="button"
                    key={c.id}
                    className={`comp-tab ${competition === c.id ? "active" : ""}`}
                    onClick={() => setCompetition(c.id)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>

              <div className="topbar">
                <div>
                  <h1>Past rounds</h1>
                  <div className="sub">Archived once a round is fully played and a new one is analyzed</div>
                </div>
              </div>
              {compArchived.length ? (
                compArchived.map((r) => {
                  const { correct, graded } = computeRoundAccuracy(r.matches || []);
                  const pct = graded ? Math.round((correct / graded) * 100) : null;
                  const hideBadge = HIDE_ACCURACY_FOR_ROUNDS.has(r.round_label);
                  return (
                    <div className="archived-round" key={r.id}>
                      <div>
                        <div className="rtitle">{r.round_label}</div>
                        <div className="rsub">{(r.matches || []).length} fixtures analyzed · archived {fmtStamp(r.archived_at).replace("Last analyzed ", "")}</div>
                      </div>
                      {pct != null && !hideBadge ? (
                        <span className={`accuracy-chip ${pct > 50 ? "good" : "bad"}`}>{correct}/{graded} correct — {pct}%</span>
                      ) : (
                        <span className="accuracy-chip none">Not enough graded picks</span>
                      )}
                    </div>
                  );
                })
              ) : (
                <div className="empty-state">
                  <h3>No completed {competition === "CL" ? "Champions League" : "Premier League"} rounds yet</h3>
                  <p>A round gets archived here automatically once every fixture in it has been played.</p>
                </div>
              )}
            </>
          )}

          {view === "table" && (
            <>
              <div className="topbar">
                <div>
                  <h1>Premier League table</h1>
                  <div className="sub">
                    {standings?.updated_at
                      ? fmtStamp(standings.updated_at)
                      : "Refreshed on the same schedule as predictions"}
                  </div>
                </div>
              </div>
              <StandingsTable standings={standings} />
            </>
          )}

          {view === "how" && (
            <div className="how">
              <h3>How this works</h3>
              <p>Each fixture is checked against several independent, methodology-transparent prediction models rather than a single "top pick" source — no individual site in this space has a verified, audited accuracy record, so agreement across models is treated as the meaningful signal, not any one source's claimed win rate.</p>
              <p>Each match card leads with "Our Prediction" — not a 6th model, but an honest consensus of whichever outcome the majority of that fixture's sources lean toward, and how many of them agree. Below it, Opta Analyst and Wincomparator are shown individually, with any remaining sources (Forebet, SoccerVista, Club Elo) tucked under a "more sources" toggle so every number is still there, just not competing for attention. This page shows win/draw/loss probabilities and secondary markets (both-teams-to-score, over/under goals, correct score) exactly as published by each source. It intentionally excludes betting odds, stakes, or "place a bet" actions — it's a research view, not a betting tool.</p>
              <p>Premier League and Champions League fixtures get the exact same treatment, side by side under the toggle at the top of "This round's signal" — Champions League just runs on its own schedule, since its fixtures cluster midweek rather than on weekends.</p>
              <p>A scheduled job (not this page) checks every fixture every 3 hours and researches it once it's within 12 hours of kickoff, writing results straight into the database this page reads from — so every open tab updates automatically, live, with nothing to click.</p>
              <p><b>Disclaimer:</b> this site does not encourage or facilitate betting in any way, and nothing on it is betting advice. Nothing here is a guarantee of accuracy or profit — model agreement is a signal about a match, not a certainty, and no source on this page (including this site itself) has a verified long-term accuracy record. If you choose to bet elsewhere, please do so only with money you can afford to lose, and stop if it stops being fun.</p>
            </div>
          )}
        </main>
      </div>
    </>
  );
}
