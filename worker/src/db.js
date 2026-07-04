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
  return db;
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
