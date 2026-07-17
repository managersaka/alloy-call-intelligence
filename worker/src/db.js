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
  try { db.exec('ALTER TABLE calls ADD COLUMN kind TEXT'); } catch { /* already there */ } // 'sps' = in-person SPS transcript (Otter/Plaud import)
  try { db.exec('ALTER TABLE call_scores ADD COLUMN indexed INTEGER DEFAULT 0'); } catch { /* already there */ } // pushed to the Analysis Index sheet
  // Cross-process work claims: the webhook server and cron polls are separate
  // processes sharing this DB; a claim ensures a call is classified/scored
  // (and its report emailed) exactly once.
  db.exec(`CREATE TABLE IF NOT EXISTS claims (key TEXT PRIMARY KEY, at TEXT DEFAULT (datetime('now')))`);
  // Per-call scoring failure ledger. A call that fails deterministically (oversized
  // transcript, malformed model output, etc.) used to release its claim and be
  // retried on EVERY 10-min poll forever — 87 such calls generated 6,506 failed
  // `claude` spawns in a single day (2026-07-17), burning subscription usage and
  // starving live calls. After SCORE_ATTEMPT_CAP failures a call is dead-lettered:
  // excluded from the unscored selectors, its last error kept for diagnosis.
  db.exec(`CREATE TABLE IF NOT EXISTS score_attempts (
    call_id TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT, last_at TEXT DEFAULT (datetime('now')))`);
  return db;
}

// After this many failed scoring attempts a call is dead-lettered (stops retrying).
// Generous enough to ride out transient CLI/API blips; tight enough to kill a runaway.
export const SCORE_ATTEMPT_CAP = 5;

/** Record a failed scoring attempt; returns the new attempt count. */
export function recordScoreFailure(db, callId, errMsg) {
  db.prepare(`
    INSERT INTO score_attempts (call_id, attempts, last_error, last_at)
    VALUES (?, 1, ?, datetime('now'))
    ON CONFLICT(call_id) DO UPDATE SET
      attempts = attempts + 1, last_error = excluded.last_error, last_at = datetime('now')
  `).run(callId, (errMsg || '').slice(0, 500));
  return db.prepare('SELECT attempts FROM score_attempts WHERE call_id = ?').get(callId)?.attempts ?? 1;
}

/** Clear the failure ledger for a call that finally scored (hygiene; selectors already exclude scored calls). */
export function clearScoreAttempts(db, callId) {
  db.prepare('DELETE FROM score_attempts WHERE call_id = ?').run(callId);
}

/** Dead-lettered calls (attempts >= cap) — for the watchdog + root-cause diagnosis. */
export function deadLetteredScores(db, cap = SCORE_ATTEMPT_CAP) {
  return db.prepare(`
    SELECT call_id, attempts, last_error, last_at FROM score_attempts
    WHERE attempts >= ? ORDER BY attempts DESC
  `).all(cap);
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
                       direction, staff, started_at, duration_sec, recording_url, transcript, transcript_source, kind)
    VALUES (:id, :conversation_id, :contact_id, :contact_name, :location_id, :location_name,
            :direction, :staff, :started_at, :duration_sec, :recording_url, :transcript, :transcript_source, :kind)
    ON CONFLICT(id) DO UPDATE SET
      transcript = COALESCE(excluded.transcript, calls.transcript),
      transcript_source = COALESCE(excluded.transcript_source, calls.transcript_source),
      duration_sec = COALESCE(excluded.duration_sec, calls.duration_sec),
      kind = COALESCE(excluded.kind, calls.kind)
  `).run({ kind: null, ...call });
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

// Accountability sessions (phone or in-person) awaiting the acct rubric.
export function unscoredAccountabilityCalls(db, minEvalSec = 0, limit = 10) {
  return db.prepare(`
    SELECT c.* FROM calls c
    LEFT JOIN call_scores s ON s.call_id = c.id
    LEFT JOIN score_attempts a ON a.call_id = c.id
    WHERE c.classification = 'accountability' AND s.id IS NULL AND c.transcript IS NOT NULL
      AND (c.duration_sec IS NULL OR c.duration_sec >= ?)
      AND (a.attempts IS NULL OR a.attempts < ?)
    LIMIT ?
  `).all(minEvalSec, SCORE_ATTEMPT_CAP, limit);
}

export function unscoredSalesCalls(db, minEvalSec = 0, limit = 10) {
  // Full-rubric evaluation only for real conversations (>= minEvalSec); shorter
  // sales calls keep their classifier clarity_outcome but are never rubric-scored.
  // Unknown duration => still evaluate (rare; better to over-grade than miss a real call).
  // Dead-lettered calls (>= SCORE_ATTEMPT_CAP failures) are excluded so one bad
  // transcript can't loop every poll forever.
  return db.prepare(`
    SELECT c.* FROM calls c
    LEFT JOIN call_scores s ON s.call_id = c.id
    LEFT JOIN score_attempts a ON a.call_id = c.id
    WHERE c.classification = 'sales' AND s.id IS NULL AND c.transcript IS NOT NULL
      AND (c.duration_sec IS NULL OR c.duration_sec >= ?)
      AND (a.attempts IS NULL OR a.attempts < ?)
    LIMIT ?
  `).all(minEvalSec, SCORE_ATTEMPT_CAP, limit);
}
