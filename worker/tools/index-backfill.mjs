// Push every not-yet-indexed analysis into the Analysis Index sheet.
// Idempotent: rows are marked indexed=1 as they go; safe to re-run anytime.
import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import { bridge } from '../src/bridge.js';

const BASE = process.env.DASHBOARD_BASE || 'https://alloy-members.duckdns.org/call-intel';
const db = new DatabaseSync(process.env.DB_PATH || './data/calls.db');

const rows = db.prepare(`
  SELECT s.call_id, c.started_at, c.location_name, c.contact_name, s.caller, s.call_type,
         s.weighted_total, s.clarity_outcome, s.booked, s.coaching_priority, s.shareable_summary
  FROM call_scores s JOIN calls c ON c.id = s.call_id
  WHERE s.call_type != 'misrouted' AND s.indexed = 0
  ORDER BY c.started_at`).all();
console.log(`analyses to index: ${rows.length}`);

let url = null;
for (let i = 0; i < rows.length; i += 40) {
  const batch = rows.slice(i, i + 40).map((r) => ({
    date: (r.started_at || '').slice(0, 16).replace('T', ' '),
    studio: r.location_name,
    teamMember: r.caller || '',
    contact: r.contact_name || '',
    type: r.call_type,
    score: r.weighted_total,
    clarity: r.clarity_outcome,
    booked: Boolean(r.booked),
    coachingPriority: r.coaching_priority || '',
    summary: r.shareable_summary || '',
    reportUrl: `${BASE}/report/${r.call_id}`,
  }));
  const res = await bridge('appendIndexRows', { rows: batch });
  url = res.spreadsheetUrl;
  const mark = db.prepare('UPDATE call_scores SET indexed = 1 WHERE call_id = ?');
  for (const r of rows.slice(i, i + 40)) mark.run(r.call_id);
  console.log(`  ${Math.min(i + 40, rows.length)}/${rows.length}`);
}
console.log('INDEX BACKFILL DONE →', url);
