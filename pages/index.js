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

function rowToMatch(r) {
  return {
    id: r.id, home: r.home, away: r.away, kickoffLocal: r.kickoff_local,
    status: r.status, score: r.score,
    probs: r.probs || [], extras: r.extras || [], standout: r.standout || {},
    agreement: r.agreement, agreementNote: r.agreement_note, forebetNote: r.forebet_note,
  };
}

function ProbBars({ p }) {
  if (p.draw == null || p.away == null) {
    return (
      <div className="prob-row">
        <div className="src"><span>{p.source}</span></div>
        <div className="prob-na">{p.home != null ? `${p.home}% (single-side reading — draw/away not published)` : "Not published for this fixture"}</div>
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

function MatchCard({ m, open, onToggle }) {
  const isLive = m.status === "upcoming" && new Date(m.kickoffLocal).getTime() < Date.now();
  return (
    <div className={`match ${open ? "open" : ""} ${m.status === "finished" ? "is-finished" : ""}`}>
      <div className="match-head" onClick={() => onToggle(m.id)}>
        <div>
          <div className="teams">{m.home} vs {m.away}</div>
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
            <div className="label">{m.standout.market || "Standout signal"}</div>
            <div className="pick">{m.standout.pick}{m.standout.pct != null ? ` — ${m.standout.pct}%` : ""}</div>
            {m.standout.note && <div className="note">{m.standout.note}</div>}
          </div>
        )}
        {m.probs && m.probs.length > 0 ? (
          <div className="probs">
            {m.probs.map((p, i) => <ProbBars key={i} p={p} />)}
          </div>
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
  const unanimous = candidates.find((m) => m.agreement === "good" && m.standout?.source === "unanimous");
  const highest = candidates.reduce((best, m) => {
    const v = m.standout?.pct;
    return v != null && (!best || v > best.standout.pct) ? m : best;
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
          <div className="hero-title">{highest.standout.market} — {highest.standout.pick}, {highest.home} vs {highest.away}</div>
          <p className="hero-desc"><b>{highest.standout.pct}%</b> from {highest.standout.source} — the single most one-sided number found this round.</p>
        </div>
      )}
    </div>
  );
}

export default function Home() {
  const [view, setView] = useState("this"); // this | past | how
  const [meta, setMeta] = useState({ round_label: "Premier League", last_updated: null });
  const [matches, setMatches] = useState([]);
  const [archived, setArchived] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [connected, setConnected] = useState(false);
  const [selectedDay, setSelectedDay] = useState(null); // null = "All"; task 1a — day tabs on Upcoming

  const loadAll = useCallback(async () => {
    if (!supabase) return;
    const [{ data: metaRow }, { data: matchRows }, { data: archRows }] = await Promise.all([
      supabase.from("meta").select("*").eq("id", "status").maybeSingle(),
      supabase.from("matches").select("*"),
      supabase.from("archived_rounds").select("*").order("archived_at", { ascending: false }),
    ]);
    if (metaRow) setMeta(metaRow);
    if (matchRows) setMatches(matchRows.map(rowToMatch));
    if (archRows) setArchived(archRows);
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
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [loadAll]);

  const sorted = useMemo(
    () => matches.slice().sort((a, b) => new Date(a.kickoffLocal) - new Date(b.kickoffLocal)),
    [matches]
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
      <Head><title>Matchday Signal</title></Head>
      <div className="shell">
        <aside className="sidebar">
          <div className="brand">
            <div className="mark">MS</div>
            <div>
              <div className="name">Matchday Signal</div>
              <div className="sub">Premier League</div>
            </div>
          </div>
          <nav>
            <div className={`nav-item ${view === "this" ? "active" : ""}`} onClick={() => setView("this")}>This round</div>
            <div className={`nav-item ${view === "past" ? "active" : ""}`} onClick={() => setView("past")}>Past rounds</div>
            <div className={`nav-item ${view === "how" ? "active" : ""}`} onClick={() => setView("how")}>How this works</div>
          </nav>
          <div className="legend">
            <div className="legend-title">Sources checked</div>
            <div className="legend-row"><span>Opta Analyst</span><span className="dim">win probability</span></div>
            <div className="legend-row"><span>Forebet</span><span className="dim">1X2 + goals</span></div>
            <div className="legend-row"><span>Wincomparator</span><span className="dim">1X2 + goals</span></div>
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

              <Hero matches={matches} />

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
                    <p style={{ margin: 0 }}>No upcoming fixtures left in this round — check back once the next matchweek is analyzed.</p>
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
              <div className="topbar">
                <div>
                  <h1>Past rounds</h1>
                  <div className="sub">Archived once a round is fully played and a new one is analyzed</div>
                </div>
              </div>
              {archived.length ? (
                archived.map((r) => {
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
                  <h3>No completed rounds yet</h3>
                  <p>This round gets archived here automatically once it's fully played.</p>
                </div>
              )}
            </>
          )}

          {view === "how" && (
            <div className="how">
              <h3>How this works</h3>
              <p>Each fixture is checked against several independent, methodology-transparent prediction models rather than a single "top pick" source — no individual site in this space has a verified, audited accuracy record, so agreement across models is treated as the meaningful signal, not any one source's claimed win rate.</p>
              <p>This page shows win/draw/loss probabilities and secondary markets (both-teams-to-score, over/under goals, correct score) exactly as published by each source, plus the single strongest and most-agreed-upon signal per match. It intentionally excludes betting odds, stakes, or "place a bet" actions — it's a research view, not a betting tool.</p>
              <p>A scheduled job (not this page) checks every fixture every 3 hours and researches it once it's within 12 hours of kickoff, writing results straight into the database this page reads from — so every open tab updates automatically, live, with nothing to click.</p>
              <p><b>Disclaimer:</b> this site does not encourage or facilitate betting in any way, and nothing on it is betting advice. Nothing here is a guarantee of accuracy or profit — model agreement is a signal about a match, not a certainty, and no source on this page (including this site itself) has a verified long-term accuracy record. If you choose to bet elsewhere, please do so only with money you can afford to lose, and stop if it stops being fun.</p>
            </div>
          )}
        </main>
      </div>
    </>
  );
}
