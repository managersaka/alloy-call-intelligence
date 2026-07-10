// Aggregated call-intelligence summary for the AOS weekly Alloy brief.
// Read-only; prints compact JSON to stdout. Aggregates only — no transcripts,
// no private reports, no member PII beyond what the L10 scorecard already shows.
//
// Usage: node tools/brief-summary.mjs   (from worker/, or set DB_PATH)
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'calls.db');
const db = new DatabaseSync(DB_PATH, { readOnly: true });

const MIN_N = 5; // L10 rule: below this, show count instead of trusting the average

function volume(sinceDays, untilDays = 0) {
  return db.prepare(`
    SELECT location_name, classification, COUNT(*) n
    FROM calls
    WHERE started_at >= datetime('now', ?) AND started_at < datetime('now', ?)
    GROUP BY location_name, classification`).all(`-${sinceDays} days`, `-${untilDays} days`);
}

// Window on the CALL's start time, not scored_at — backfill scoring would
// otherwise dump months of history into "this week". Misrouted calls score 0
// by definition and are excluded from averages (counted separately).
function scored(sinceDays, untilDays = 0) {
  return db.prepare(`
    SELECT s.call_type, s.location_name, COUNT(*) n, ROUND(AVG(s.weighted_total), 1) avg_score
    FROM call_scores s JOIN calls c ON c.id = s.call_id
    WHERE c.started_at >= datetime('now', ?) AND c.started_at < datetime('now', ?)
      AND s.call_type != 'misrouted'
    GROUP BY s.call_type, s.location_name`).all(`-${sinceDays} days`, `-${untilDays} days`);
}

// Rolling 4w per-caller rubric average (the L10 number) + last-7d for movement.
const callers4w = db.prepare(`
  SELECT s.caller, s.call_type, COUNT(*) n, ROUND(AVG(s.weighted_total), 1) avg_score
  FROM call_scores s JOIN calls c ON c.id = s.call_id
  WHERE c.started_at >= datetime('now', '-28 days') AND s.call_type != 'misrouted'
  GROUP BY s.caller, s.call_type
  ORDER BY s.call_type, avg_score DESC`).all()
  .map((r) => (r.n < MIN_N ? { ...r, avg_score: null, note: `n<${MIN_N}` } : r));

// Fog rate per caller, all sales calls regardless of length (clarity rule).
const fog4w = db.prepare(`
  SELECT staff caller, COUNT(*) sales_calls,
         SUM(CASE WHEN clarity_outcome = 'fog' THEN 1 ELSE 0 END) fog_n,
         ROUND(100.0 * SUM(CASE WHEN clarity_outcome = 'fog' THEN 1 ELSE 0 END) / COUNT(*), 0) fog_pct
  FROM calls
  WHERE classification = 'sales' AND started_at >= datetime('now', '-28 days') AND staff IS NOT NULL
  GROUP BY staff HAVING sales_calls >= 3
  ORDER BY fog_pct DESC`).all();

// Failure-pattern watch-list: last 4w vs prior 4w.
const patterns = (() => {
  const rows = db.prepare(`
    SELECT s.caller, s.failure_patterns, c.started_at FROM call_scores s
    JOIN calls c ON c.id = s.call_id
    WHERE c.started_at >= datetime('now', '-56 days') AND s.failure_patterns IS NOT NULL`).all();
  const cut = Date.now() - 28 * 86400_000;
  const tally = {};
  for (const r of rows) {
    let list = [];
    try { list = JSON.parse(r.failure_patterns); } catch { continue; }
    const recent = new Date(r.started_at).getTime() >= cut;
    for (const p of Array.isArray(list) ? list : []) {
      const key = `${r.caller}|${p}`;
      tally[key] ??= { caller: r.caller, pattern: p, last4w: 0, prior4w: 0 };
      tally[key][recent ? 'last4w' : 'prior4w']++;
    }
  }
  return Object.values(tally)
    .filter((t) => t.last4w + t.prior4w >= 2)
    .map((t) => ({ ...t, trend: t.last4w > t.prior4w ? 'RISING' : t.last4w < t.prior4w ? 'improving' : 'persistent' }))
    .sort((a, b) => b.last4w - a.last4w)
    .slice(0, 12);
})();

// Best and worst scored calls of the week (coaching priorities only, no reports).
const notable = db.prepare(`
  SELECT s.caller, s.call_type, s.location_name, s.weighted_total, s.coaching_priority, c.started_at
  FROM call_scores s JOIN calls c ON c.id = s.call_id
  WHERE c.started_at >= datetime('now', '-7 days') AND s.call_type != 'misrouted'
  ORDER BY s.weighted_total`).all();

const misrouted7d = db.prepare(`
  SELECT COUNT(*) n FROM call_scores s JOIN calls c ON c.id = s.call_id
  WHERE c.started_at >= datetime('now', '-7 days') AND s.call_type = 'misrouted'`).get().n;

console.log(JSON.stringify({
  generated: new Date().toISOString(),
  source: 'alloy-call-intelligence calls.db (droplet)',
  min_n_rule: MIN_N,
  volume_7d: volume(7),
  volume_prior_7d: volume(14, 7),
  scored_7d: scored(7),
  scored_prior_7d: scored(14, 7),
  callers_4w: callers4w,
  fog_4w: fog4w,
  watch_list: patterns,
  worst_call_7d: notable[0] ?? null,
  best_call_7d: notable.at(-1) ?? null,
  scored_calls_7d: notable.length,
  misrouted_calls_7d: misrouted7d,
}, null, 1));
