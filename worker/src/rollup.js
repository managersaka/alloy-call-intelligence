// Weekly rollup → L10 scorecard rows. Run Sunday night via cron:
//   0 21 * * 0  cd /opt/alloy-call-intelligence/worker && node src/rollup.js
//
// Rules implemented here (do not change casually — they're the measurement design):
//   - Rolling 4-week average per caller PER CALL TYPE (QC and SPS never blended).
//   - Minimum-n: fewer than MIN_N scored calls in the 4-week window → report count, not score.
//   - `booked` reported as a team-level rate only, never per-call-blended into quality.
// Output: writes a CSV to data/rollups/ and (optionally) a Google Sheet tab via
// service account — same pattern as the QuickBooks P&L automation.

import { openDb } from './db.js';
import { bridge, bridgeEnabled } from './bridge.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIN_N = Number(process.env.MIN_N || 5);
const MIN_EVAL_SEC = Number(process.env.MIN_EVAL_SEC || 180);

const db = openDb();
const now = new Date();
const fourWeeksAgo = new Date(now.getTime() - 28 * 86400_000).toISOString();
const oneWeekAgo = new Date(now.getTime() - 7 * 86400_000).toISOString();

function agg(rows) {
  const byKey = {};
  for (const r of rows) {
    const key = `${r.caller || 'unknown'}|${r.call_type}`;
    (byKey[key] ||= []).push(r);
  }
  return Object.entries(byKey).map(([key, list]) => {
    const [caller, call_type] = key.split('|');
    const scores = list.map((r) => r.weighted_total).filter((x) => x != null);
    const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
    const bookedRate = list.length ? list.filter((r) => r.booked).length / list.length : null;
    return { caller, call_type, n: list.length, avg: avg?.toFixed(1), bookedRate: bookedRate?.toFixed(2) };
  });
}

// Window by CALL date, not scoring date — backfills score old calls "today"
// and would otherwise flood the rolling window. Rubric averages only count
// graded conversations (>= MIN_EVAL_SEC); shorter scored rows (early backfill)
// are excluded here too so the average stays comparable.
const WINDOW_SQL = `
  SELECT s.caller, s.call_type, s.weighted_total, s.booked
  FROM call_scores s JOIN calls c ON c.id = s.call_id
  WHERE c.started_at >= ? AND s.call_type != 'misrouted'
    AND (c.duration_sec IS NULL OR c.duration_sec >= ${MIN_EVAL_SEC})`;
const window4w = db.prepare(WINDOW_SQL).all(fourWeeksAgo);
const window1w = db.prepare(WINDOW_SQL).all(oneWeekAgo);

// Clarity discipline is tracked for EVERY sales call (classifier-emitted),
// including the sub-MIN_EVAL_SEC dials the rubric never sees. Fog on a short
// call is still a caller failure — this is where "no fog" gets enforced.
const CLARITY_SQL = `
  SELECT staff caller, clarity_outcome FROM calls
  WHERE classification = 'sales' AND started_at >= ? AND clarity_outcome IS NOT NULL`;
function clarityAgg(rows) {
  const byCaller = {};
  for (const r of rows) (byCaller[r.caller || 'unknown'] ||= []).push(r.clarity_outcome);
  return Object.entries(byCaller).map(([caller, list]) => ({
    caller,
    n: list.length,
    fogRate: (list.filter((o) => o === 'fog').length / list.length).toFixed(2),
    bookedRate: (list.filter((o) => o === 'booked').length / list.length).toFixed(2),
  }));
}
const clarity4w = clarityAgg(db.prepare(CLARITY_SQL).all(fourWeeksAgo));

// Failure-pattern trends: last 4 weeks vs the 4 weeks before, per caller.
// Rising or persistent patterns are the coaching watch-list.
const eightWeeksAgo = new Date(now.getTime() - 56 * 86400_000).toISOString();
const PATTERN_SQL = `
  SELECT s.caller, s.failure_patterns, c.started_at
  FROM call_scores s JOIN calls c ON c.id = s.call_id
  WHERE c.started_at >= ? AND s.call_type != 'misrouted'`;
function patternTrends() {
  const counts = {}; // caller|pattern -> {now, prior}
  for (const r of db.prepare(PATTERN_SQL).all(eightWeeksAgo)) {
    const bucket = r.started_at >= fourWeeksAgo ? 'now' : 'prior';
    for (const p of JSON.parse(r.failure_patterns || '[]')) {
      const key = `${r.caller || 'unknown'}|${p}`;
      (counts[key] ||= { now: 0, prior: 0 })[bucket]++;
    }
  }
  return Object.entries(counts)
    .map(([key, c]) => {
      const [caller, pattern] = key.split('|');
      const trend = c.now > c.prior ? 'RISING' : c.now === c.prior && c.now > 0 ? 'persistent' : c.now < c.prior && c.now > 0 ? 'improving' : c.now === 0 && c.prior > 0 ? 'CLEARED' : '';
      return { caller, pattern, now: c.now, prior: c.prior, trend };
    })
    .filter((p) => p.now >= 2 || (p.prior >= 2 && p.now === 0))
    .sort((a, b) => b.now - a.now);
}
const patterns = patternTrends();

const rolling = agg(window4w);
const weekly = agg(window1w);

const scorecardOf = (r) => (r.n >= MIN_N ? r.avg : `n=${r.n} (below min ${MIN_N})`);
const clarityScorecardOf = (r) => (r.n >= MIN_N ? `fog ${Math.round(r.fogRate * 100)}%` : `n=${r.n} (below min ${MIN_N})`);

const lines = ['scope,caller,call_type,n,avg_score,booked_rate,fog_rate,scorecard_value'];
for (const r of rolling) {
  // Minimum-n rule: under MIN_N, the scorecard shows the count, not a judgable score.
  lines.push(`rolling_4w,${r.caller},${r.call_type},${r.n},${r.avg ?? ''},${r.bookedRate ?? ''},,"${scorecardOf(r)}"`);
}
for (const r of weekly) {
  lines.push(`weekly_raw,${r.caller},${r.call_type},${r.n},${r.avg ?? ''},${r.bookedRate ?? ''},,caller_facing_only`);
}
for (const r of clarity4w) {
  lines.push(`clarity_4w,${r.caller},all_sales_calls,${r.n},,${r.bookedRate},${r.fogRate},"${clarityScorecardOf(r)}"`);
}

const outDir = path.join(__dirname, '..', 'data', 'rollups');
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `rollup_${now.toISOString().slice(0, 10)}.csv`);
writeFileSync(outFile, lines.join('\n'));
console.log(`rollup written: ${outFile}`);
console.table([...rolling.map((r) => ({ scope: '4w', ...r }))]);
console.table([...clarity4w.map((r) => ({ scope: 'clarity_4w', ...r }))]);

// Push the same rows to the "Call Quality" tab of both L10 sheets via the bridge.
if (bridgeEnabled()) {
  try {
    const result = await bridge('rollup', {
      generatedAt: now.toISOString(),
      rolling: rolling.map((r) => ({ ...r, scorecard: scorecardOf(r) })),
      clarity: clarity4w.map((r) => ({ ...r, scorecard: clarityScorecardOf(r) })),
      patterns,
    });
    console.log('pushed to L10 sheets:', result.written.join(', '));
  } catch (e) {
    console.error('L10 sheet push failed (CSV still written):', e.message);
  }
} else {
  console.log('bridge not configured — skipping L10 sheet push');
}
