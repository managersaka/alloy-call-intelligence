// One-time retro-fix: mark already-imported Drive docs whose FILENAME says SPS
// as kind='sps', purge their old (QC-rubric) scores + claims, so the pipeline
// re-analyzes them with the dedicated SPS rubric (sps-1.0).
import 'dotenv/config';
import { bridge } from '../src/bridge.js';
import { openDb } from '../src/db.js';

const FOLDERS = [
  '1X4CLutlgwTQBM4L-gRwshtjM6PzkQE15', // Phone Calls (Schaumburg) — contains AS/SPS-named docs too
  '1s6OjmVyeuh5bYO649gMQ0a4tdu5HU_19', // Phone Call Transcripts (Lincolnshire)
  '1RVPHPxEE6g0db3SYMUNj4-gAjYsIOVbc', // Alloy Lincolnshire Transcripts (root)
  '1WKE48Zex11Po-9w_1lSnGxNVaUbO0zVE', // Accountability (Schaumburg)/Transcript
  '1lRAGwSmhuf5BGztSKTEmSLBHHbBKqGWj', // Accountability Transcripts (Lincolnshire)
];
const SKIP_FOLDER = /eval|recording|meeting|l10|coach/i;

async function walk(folderId, depth = 0) {
  const { items } = await bridge('listFolder', { folderId });
  let out = [];
  for (const it of items) {
    if (it.mimeType === 'application/vnd.google-apps.folder') {
      if (depth < 2 && !SKIP_FOLDER.test(it.name)) out = out.concat(await walk(it.id, depth + 1));
    } else out.push(it);
  }
  return out;
}

let all = [];
for (const f of FOLDERS) all = all.concat(await walk(f));
const spsIds = [...new Set(all.filter((d) => /\bSPS\b/i.test(d.name)).map((d) => `drive_${d.id}`))];
console.log(`SPS-named docs in Drive: ${spsIds.length}`);

const db = openDb();
let marked = 0;
let purged = 0;
for (const id of spsIds) {
  const r = db.prepare(`UPDATE calls SET kind = 'sps' WHERE id = ? AND (kind IS NULL OR kind != 'sps')`).run(id);
  marked += r.changes;
  purged += db.prepare('DELETE FROM call_scores WHERE call_id = ?').run(id).changes;
  db.prepare('DELETE FROM claims WHERE key = ?').run(`score:${id}`);
}
console.log(`marked kind=sps: ${marked} | old scores purged: ${purged} — next poll re-analyzes with sps-1.0`);
