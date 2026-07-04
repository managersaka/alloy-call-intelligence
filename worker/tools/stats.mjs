// Quick DB stats: pipeline progress, classification mix, score distribution.
import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(process.env.DB_PATH || './data/calls.db');
const q = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);

console.log('ingested:', one('SELECT COUNT(*) n, SUM(transcript IS NOT NULL) with_transcript, SUM(processed) processed FROM calls'));
console.log('by classification:', q('SELECT classification, COUNT(*) n FROM calls WHERE processed=1 GROUP BY classification ORDER BY n DESC'));
console.log('unscored sales remaining:', one(`
  SELECT COUNT(*) n FROM calls c LEFT JOIN call_scores s ON s.call_id = c.id
  WHERE c.classification = 'sales' AND s.id IS NULL AND c.transcript IS NOT NULL`));
console.log('scores by type:', q(`
  SELECT call_type, COUNT(*) n, ROUND(AVG(weighted_total),1) avg, MIN(weighted_total) min, MAX(weighted_total) max
  FROM call_scores GROUP BY call_type`));
console.log('clarity outcomes:', q('SELECT clarity_outcome, COUNT(*) n FROM call_scores GROUP BY clarity_outcome ORDER BY n DESC'));
console.log('by caller:', q(`
  SELECT caller, call_type, COUNT(*) n, ROUND(AVG(weighted_total),1) avg
  FROM call_scores WHERE call_type != 'misrouted' GROUP BY caller, call_type ORDER BY n DESC LIMIT 10`));
console.log('sales call date range:', one(`SELECT MIN(started_at) oldest, MAX(started_at) newest FROM calls WHERE classification='sales'`));
