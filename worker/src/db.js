// SQLite via node:sqlite (built into Node >= 22.5) — no native build step.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'calls.db');

export function openDb() {
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  const schema = readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');
  db.exec(schema);
  // Migrations for DBs created before the column existed (CREATE IF NOT EXISTS won't alter).
  try { db.exec('ALTER TABLE calls ADD COLUMN clarity_outcome TEXT'); } catch { /* already there */ }
  try { db.exec('ALTER TABLE calls ADD COLUMN qa_done INTEGER DEFAULT 0'); } catch { /* already there */ }
  // Cross-process work claims: the webhook server and cron polls are separate
  // processes sharing this DB; a claim ensures a call is classified/scored
  // (and its report emailed) exactly once.
  db.exec(`CREATE TABLE IF NOT EXISTS claims (key TEXT PRIMARY KEY, at TEXT DEFAULT (datetime('now')))`);
  return db;
}

export function claim(db, key) {
  return db.prepare('INSERT OR IGNORE INTO claims (key) VALUES (?)').run(key).changes === 1;
}

export function releaseClaim(db, key) {
  db.prepare('DELETE FROM claims WHERE key = ?').run(key);
}

// Claims from crashed processes: anything older than 2h is abandoned work.
export function cleanStaleClaims(db) {
  return db.prepare(`DELETE FROM claims WHERE at < datetime('now', '-2 hours')`).run().changes;
}

export function upsertCall(db, call) {
  db.prepare(`
    INSERT INTO calls (id, conversation_id, contact_id, contact_name, location_id, location_name,
                       direction, staff, started_at, duration_sec, recording_url, transcript, transcript_source)
    VALUES (:id, :conversation_id, :contact_id, :contact_name, :location_id, :location_name,
            :direction, :staff, :started_at, :duration_sec, :recording_url, :transcript, :transcript_source)
    ON CONFLICT(id) DO UPDATE SET
      transcript = COALESCE(excluded.transcript, calls.transcript),
      transcript_source = COALESCE(excluded.transcript_source, calls.transcript_source),
      duration_sec = COALESCE(excluded.duration_sec, calls.duration_sec)
  `).run(call);
}

export function setClassification(db, id, { classification, confidence, summary, outcome, next_action, clarity_outcome }) {
  db.prepare(`
    UPDATE calls SET classification=?, class_confidence=?, summary=?, outcome=?, next_action=?, clarity_outcome=?, processed=1
    WHERE id=?
  `).run(classification, confidence, summary, outcome, next_action, clarity_outcome ?? null, id);
}

export function insertScore(db, s) {
  db.prepare(`
    INSERT OR REPLACE INTO call_scores
      (call_id, rubric_version, call_type, caller, location_name, sub_scores, weighted_total,
       pass_fail, clarity_outcome, booked, failure_patterns, shareable_summary, private_report, coaching_priority)
    VALUES (:call_id, :rubric_version, :call_type, :caller, :location_name, :sub_scores, :weighted_total,
            :pass_fail, :clarity_outcome, :booked, :failure_patterns, :shareable_summary, :private_report, :coaching_priority)
  `).run(s);
}

export function unprocessedCalls(db, limit = 20) {
  return db.prepare(`SELECT * FROM calls WHERE processed = 0 AND transcript IS NOT NULL LIMIT ?`).all(limit);
}

// Classified conversations that haven't had Q&A extracted yet (admin_other/REVIEW excluded).
export function qaPendingCalls(db, minCallSec = 45, limit = 15) {
  return db.prepare(`
    SELECT * FROM calls
    WHERE processed = 1 AND qa_done = 0 AND transcript IS NOT NULL
      AND classification IN ('sales', 'member_request', 'accountability')
      AND (duration_sec IS NULL OR duration_sec >= ?)
    LIMIT ?
  `).all(minCallSec, limit);
}

export function insertQaRows(db, callId, rows) {
  const stmt = db.prepare(`
    INSERT INTO qa_extractions (call_id, question_verbatim, answer_given, taxonomy_id, novel_flag)
    VALUES (?, ?, ?, ?, ?)`);
  for (const r of rows) {
    stmt.run(callId, r.question_verbatim, r.answer_given ?? null, r.taxonomy_id ?? null, r.novel ? 1 : 0);
  }
  db.prepare('UPDATE calls SET qa_done = 1 WHERE id = ?').run(callId);
}

export function unscoredSalesCalls(db, minEvalSec = 0, limit = 10) {
  // Full-rubric evaluation only for real conversations (>= minEvalSec); shorter
  // sales calls keep their classifier clarity_outcome but are never rubric-scored.
  // Unknown duration => still evaluate (rare; better to over-grade than miss a real call).
  return db.prepare(`
    SELECT c.* FROM calls c
    LEFT JOIN call_scores s ON s.call_id = c.id
    WHERE c.classification = 'sales' AND s.id IS NULL AND c.transcript IS NOT NULL
      AND (c.duration_sec IS NULL OR c.duration_sec >= ?)
    LIMIT ?
  `).all(minEvalSec, limit);
}
