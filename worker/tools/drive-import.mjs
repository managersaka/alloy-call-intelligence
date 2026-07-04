// Phase 4 backfill: import Feb–Jun call/SPS/accountability transcripts from
// Google Drive (via the bridge's listFolder/getDocs) into the calls table as
// transcript_source='drive_backfill'. The normal pipeline (classify → score →
// Q&A) picks them up on the next poll; report emails are age-gated so nothing
// gets mailed for these old calls. Idempotent: existing drive_<id> rows skipped.
import 'dotenv/config';
import { bridge } from '../src/bridge.js';
import { openDb, upsertCall } from '../src/db.js';

const FOLDERS = [
  { id: '1X4CLutlgwTQBM4L-gRwshtjM6PzkQE15', location: 'Schaumburg', label: 'Phone Calls (Schaumburg)' },
  { id: '1WKE48Zex11Po-9w_1lSnGxNVaUbO0zVE', location: 'Schaumburg', label: 'Accountability (Schaumburg)/Transcript' },
  { id: '1s6OjmVyeuh5bYO649gMQ0a4tdu5HU_19', location: 'Lincolnshire', label: 'Phone Call Transcripts (Lincolnshire)' },
  { id: '1lRAGwSmhuf5BGztSKTEmSLBHHbBKqGWj', location: 'Lincolnshire', label: 'Accountability Transcripts (Lincolnshire)' },
  { id: '1RVPHPxEE6g0db3SYMUNj4-gAjYsIOVbc', location: 'Lincolnshire', label: 'Alloy Lincolnshire Transcripts (root)' },
];
// Folders whose names match this are evaluations/recordings/meetings — not call transcripts.
const SKIP_FOLDER = /eval|recording|meeting|l10|coach/i;

const STAFF = { colin: 'Colin Yording', christian: 'Christian Simanonis', michael: 'Michael (former)', nimisha: 'Nimisha Singri' };
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

function parseName(name, created) {
  const lower = name.toLowerCase();
  const staff = Object.keys(STAFF).find((k) => lower.includes(k));
  // contact: "Christian and Jane Doe ..." pattern
  const m = name.match(/(?:and)\s+([A-Z][\w'-]+(?:\s+[A-Z][\w'.-]+)?)/);
  let contact = m ? m[1] : null;
  if (!contact) {
    // "Kate Migdalovich [Colin (SPS Transcript)] ..." pattern — leading name
    const m2 = name.match(/^\s*([A-Z][\w'-]+\s+[A-Z][\w'.-]+)/);
    contact = m2 ? m2[1] : null;
  }
  // date: try "March 19, 2026" / "Mar 06 2026", then "2026 05 22" / "[2026 06 08]", then "4/20/2026"
  let date = null;
  let dm = lower.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/);
  if (dm) date = new Date(Date.UTC(Number(dm[3]), MONTHS[dm[1]], Number(dm[2]), 17));
  if (!date) {
    dm = name.match(/(\d{4})[\s/-](\d{2})[\s/-](\d{2})/);
    if (dm) date = new Date(Date.UTC(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), 17));
  }
  if (!date) {
    dm = name.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (dm) date = new Date(Date.UTC(Number(dm[3]), Number(dm[1]) - 1, Number(dm[2]), 17));
  }
  if (!date || isNaN(date)) date = created ? new Date(created) : null;
  return { staff: staff ? STAFF[staff] : null, contact, startedAt: date ? date.toISOString() : null };
}

const db = openDb();
const exists = (id) => db.prepare('SELECT 1 FROM calls WHERE id = ?').get(id);

async function collectDocs(folderId, location, depth = 0) {
  const { items } = await bridge('listFolder', { folderId });
  let docs = [];
  for (const it of items) {
    if (it.mimeType === 'application/vnd.google-apps.folder') {
      if (depth < 2 && !SKIP_FOLDER.test(it.name)) docs = docs.concat(await collectDocs(it.id, location, depth + 1));
    } else if (it.mimeType === 'application/vnd.google-apps.document') {
      docs.push({ ...it, location });
    }
  }
  return docs;
}

let all = [];
for (const f of FOLDERS) {
  const docs = await collectDocs(f.id, f.location);
  console.log(`${f.label}: ${docs.length} docs`);
  all = all.concat(docs);
}
// de-dupe by file id (folders can nest/overlap)
all = [...new Map(all.map((d) => [d.id, d])).values()];
const fresh = all.filter((d) => !exists(`drive_${d.id}`));
console.log(`total docs: ${all.length}, new: ${fresh.length}`);

let imported = 0;
let skipped = 0;
for (let i = 0; i < fresh.length; i += 10) {
  const batch = fresh.slice(i, i + 10);
  const { docs } = await bridge('getDocs', { ids: batch.map((d) => d.id) });
  for (const doc of docs) {
    const src = batch.find((b) => b.id === doc.id);
    if (doc.error || !doc.text || doc.text.trim().length < 200) {
      skipped++;
      console.log(`  skip ${doc.name || doc.id}: ${doc.error || 'too short/blank'}`);
      continue;
    }
    const meta = parseName(doc.name, doc.created);
    upsertCall(db, {
      id: `drive_${doc.id}`,
      conversation_id: 'drive_backfill',
      contact_id: null,
      contact_name: meta.contact,
      location_id: src.location === 'Schaumburg' ? 'Y5bMONHRAsqpEoPu6lQQ' : 'QNvlhVaj9ZcX1BgVjd0u',
      location_name: src.location,
      direction: null,
      staff: meta.staff,
      started_at: meta.startedAt,
      duration_sec: null,
      recording_url: null,
      transcript: doc.text.trim(),
      transcript_source: 'drive_backfill',
    });
    imported++;
  }
  console.log(`  progress: ${Math.min(i + 10, fresh.length)}/${fresh.length}`);
}
console.log(`IMPORT DONE: ${imported} imported, ${skipped} skipped. The next poll classifies/scores/extracts them.`);
