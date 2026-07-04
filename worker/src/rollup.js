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
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIN_N = Number(process.env.MIN_N || 5);

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

const window4w = db.prepare(
  `SELECT caller, call_type, weighted_total, booked FROM call_scores WHERE scored_at >= ? AND call_type != 'misrouted'`
).all(fourWeeksAgo);
const window1w = db.prepare(
  `SELECT caller, call_type, weighted_total, booked FROM call_scores WHERE scored_at >= ? AND call_type != 'misrouted'`
).all(oneWeekAgo);

const rolling = agg(window4w);
const weekly = agg(window1w);

const lines = ['scope,caller,call_type,n,avg_score,booked_rate,scorecard_value'];
for (const r of rolling) {
  // Minimum-n rule: under MIN_N, the scorecard shows the count, not a judgable score.
  const scorecard = r.n >= MIN_N ? r.avg : `n=${r.n} (below min ${MIN_N})`;
  lines.push(`rolling_4w,${r.caller},${r.call_type},${r.n},${r.avg ?? ''},${r.bookedRate ?? ''},"${scorecard}"`);
}
for (const r of weekly) {
  lines.push(`weekly_raw,${r.caller},${r.call_type},${r.n},${r.avg ?? ''},${r.bookedRate ?? ''},caller_facing_only`);
}

const outDir = path.join(__dirname, '..', 'data', 'rollups');
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `rollup_${now.toISOString().slice(0, 10)}.csv`);
writeFileSync(outFile, lines.join('\n'));
console.log(`rollup written: ${outFile}`);
console.table([...rolling.map((r) => ({ scope: '4w', ...r }))]);

// TODO: push rolling_4w rows to the "Call Quality" tab of Alloy_KPI workbook via
// googleapis + service account (reuse creds from the QuickBooks P&L sync).
