import { supabaseAdmin } from "./lib/supabaseAdmin.js";
import { fetchSeasonFixtures, weekendWindow } from "./lib/fixtures.js";
import { fetchOptaPrediction } from "./lib/predictions/opta.js";
import { fetchWincomparatorPrediction } from "./lib/predictions/wincomparator.js";
import { fetchForebetPrediction, FOREBET_UNAVAILABLE_NOTE } from "./lib/predictions/forebet.js";
import { computeAgreement } from "./lib/agreement.js";

// Which pass this run is: set by the GitHub Actions workflow that calls it.
//   friday   — ~5h before the weekend's first kickoff: populate the new round
//   saturday — ~5h before Saturday's first kickoff: finalize Friday, research Saturday
//   sunday   — ~5h before Sunday's first kickoff: finalize Saturday, research Sunday
//   wrap     — after the last Sunday kickoff: finalize Sunday, archive if complete
const PASS = process.env.PASS;
if (!["friday", "saturday", "sunday", "wrap"].includes(PASS)) {
  throw new Error(`PASS env var must be one of friday|saturday|sunday|wrap, got: ${PASS}`);
}

const HARD_RULE_NEVER_FABRICATE = true; // documentation flag — see README "hard rules"

function nowIct() {
  return new Date(Date.now() + 7 * 60 * 60 * 1000);
}

function dayOfIct(iso) {
  return new Date(iso).toISOString().slice(0, 10);
}

async function researchFixture(f) {
  const [opta, win, forebet] = await Promise.all([
    fetchOptaPrediction(f.home, f.away),
    fetchWincomparatorPrediction(f.home, f.away),
    fetchForebetPrediction(f.home, f.away),
  ]);
  const probs = [opta, win, forebet].filter(Boolean);
  const { agreement, agreementNote, standout } = computeAgreement(probs, f.home, f.away);

  return {
    id: f.id,
    home: f.home,
    away: f.away,
    kickoff_local: f.kickoffLocal,
    status: "upcoming",
    score: null,
    probs,
    extras: [],
    standout,
    agreement,
    agreement_note: agreementNote,
    forebet_note: forebet ? null : FOREBET_UNAVAILABLE_NOTE,
    updated_at: new Date().toISOString(),
  };
}

function placeholderFixture(f) {
  return {
    id: f.id,
    home: f.home,
    away: f.away,
    kickoff_local: f.kickoffLocal,
    status: "upcoming",
    score: null,
    probs: [],
    extras: [],
    standout: { market: "—", pick: "Not yet analyzed", pct: null, source: null, note: "Checked closer to kickoff." },
    agreement: null,
    agreement_note: "Not yet analyzed — checked closer to kickoff.",
    forebet_note: null,
    updated_at: new Date().toISOString(),
  };
}

async function finalizeFinishedFixtures(currentRows, seasonFixtures) {
  const byId = new Map(seasonFixtures.map((f) => [f.id, f]));
  const updates = [];
  for (const row of currentRows) {
    if (row.status === "finished") continue;
    const fresh = byId.get(row.id);
    if (fresh && fresh.status === "finished") {
      updates.push({
        ...row,
        status: "finished",
        score: fresh.score,
        standout: { market: "—", pick: `Match complete — ${fresh.score}`, pct: null, source: null, note: "Result recorded for round completeness." },
        updated_at: new Date().toISOString(),
      });
    }
  }
  if (updates.length) {
    const { error } = await supabaseAdmin.from("matches").upsert(updates);
    if (error) throw error;
    console.log(`Finalized ${updates.length} finished fixture(s).`);
  }
  return updates.map((u) => u.id);
}

async function main() {
  const { data: currentRows, error: readErr } = await supabaseAdmin.from("matches").select("*");
  if (readErr) throw readErr;

  const seasonFixtures = await fetchSeasonFixtures();

  if (PASS === "friday") {
    const allPast = currentRows.length > 0 && currentRows.every((r) => new Date(r.kickoff_local) < new Date());
    if (currentRows.length === 0 || allPast) {
      if (currentRows.length > 0) {
        const { data: metaRow } = await supabaseAdmin.from("meta").select("*").eq("id", "status").maybeSingle();
        await supabaseAdmin.from("archived_rounds").insert({
          round_label: metaRow?.round_label || "Premier League",
          matches: currentRows,
          archived_at: new Date().toISOString(),
        });
        await supabaseAdmin.from("matches").delete().neq("id", "__none__");
        console.log(`Archived ${currentRows.length} fixture(s) from the previous round.`);
      }

      const { start, end } = weekendWindow(nowIct());
      const weekendFixtures = seasonFixtures.filter((f) => {
        const t = new Date(f.kickoffLocal).getTime();
        return t >= start.getTime() && t < end.getTime();
      });
      if (weekendFixtures.length === 0) {
        console.warn("No fixtures found for this weekend — check TheSportsDB season data / league ID.");
      }

      const fridayFixtures = weekendFixtures.filter((f) => new Date(f.kickoffLocal).getUTCDay() === 5);
      const laterFixtures = weekendFixtures.filter((f) => new Date(f.kickoffLocal).getUTCDay() !== 5);

      const researched = await Promise.all(fridayFixtures.map(researchFixture));
      const placeholders = laterFixtures.map(placeholderFixture);
      const rows = [...researched, ...placeholders];
      if (rows.length) {
        const { error } = await supabaseAdmin.from("matches").upsert(rows);
        if (error) throw error;
      }

      const firstDate = weekendFixtures[0] ? dayOfIct(weekendFixtures[0].kickoffLocal) : "";
      const lastDate = weekendFixtures.length ? dayOfIct(weekendFixtures[weekendFixtures.length - 1].kickoffLocal) : "";
      await supabaseAdmin.from("meta").upsert({
        id: "status",
        round_label: `Premier League · ${firstDate} – ${lastDate}`,
        last_updated: new Date().toISOString(),
      });
      console.log(`New round populated: ${researched.length} researched, ${placeholders.length} placeholders.`);
    } else {
      console.log("Round already in progress — nothing to initialize this Friday pass.");
    }
  }

  if (PASS === "saturday" || PASS === "sunday") {
    await finalizeFinishedFixtures(currentRows, seasonFixtures);

    const targetDay = PASS === "saturday" ? 6 : 0; // JS getUTCDay: Sat=6, Sun=0
    const { data: freshRows } = await supabaseAdmin.from("matches").select("*");
    const toResearch = (freshRows || []).filter(
      (r) => r.status === "upcoming" && new Date(r.kickoff_local).getUTCDay() === targetDay && (!r.probs || r.probs.length === 0)
    );
    const researched = await Promise.all(
      toResearch.map((r) => researchFixture({ id: r.id, home: r.home, away: r.away, kickoffLocal: r.kickoff_local }))
    );
    if (researched.length) {
      const { error } = await supabaseAdmin.from("matches").upsert(researched);
      if (error) throw error;
    }
    await supabaseAdmin.from("meta").update({ last_updated: new Date().toISOString() }).eq("id", "status");
    console.log(`${PASS} pass: researched ${researched.length} fixture(s).`);
  }

  if (PASS === "wrap") {
    await finalizeFinishedFixtures(currentRows, seasonFixtures);
    const { data: freshRows } = await supabaseAdmin.from("matches").select("*");
    const stillUpcoming = (freshRows || []).filter((r) => r.status !== "finished");

    if (stillUpcoming.length === 0 && (freshRows || []).length > 0) {
      const { data: metaRow } = await supabaseAdmin.from("meta").select("*").eq("id", "status").maybeSingle();
      await supabaseAdmin.from("archived_rounds").insert({
        round_label: metaRow?.round_label || "Premier League",
        matches: freshRows,
        archived_at: new Date().toISOString(),
      });
      await supabaseAdmin.from("matches").delete().neq("id", "__none__");
      console.log(`Round complete — archived ${freshRows.length} fixture(s).`);
    } else if (stillUpcoming.length > 0) {
      console.log(`${stillUpcoming.length} fixture(s) still not finished (likely postponed) — leaving round open.`);
    } else {
      console.log("No fixtures in the round to wrap up.");
    }
    await supabaseAdmin.from("meta").update({ last_updated: new Date().toISOString() }).eq("id", "status");
  }
}

main().catch((err) => {
  console.error("Scraper run failed:", err);
  process.exit(1);
});
