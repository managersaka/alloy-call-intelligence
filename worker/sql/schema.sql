-- Alloy Call Intelligence — SQLite schema v1
-- System of record. Sheets is a reporting view only.

PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS calls (
  id            TEXT PRIMARY KEY,          -- GHL message id (TYPE_CALL)
  conversation_id TEXT NOT NULL,
  contact_id    TEXT,
  contact_name  TEXT,
  location_id   TEXT NOT NULL,             -- GHL sub-account/location
  location_name TEXT,                      -- 'Schaumburg' | 'Lincolnshire'
  direction     TEXT,                      -- 'inbound' | 'outbound'
  staff         TEXT,                      -- caller/user attributed by GHL
  started_at    TEXT,                      -- ISO 8601
  duration_sec  INTEGER,
  recording_url TEXT,
  transcript    TEXT,
  transcript_source TEXT,                  -- 'ghl_native' | 'whisper' | 'drive_backfill'
  classification TEXT,                     -- 'sales' | 'member_request' | 'accountability' | 'admin_other' | 'REVIEW'
  class_confidence REAL,
  summary       TEXT,
  outcome       TEXT,                      -- free text from classifier
  next_action   TEXT,
  ingested_at   TEXT DEFAULT (datetime('now')),
  processed     INTEGER DEFAULT 0          -- pipeline stage flag
);

CREATE TABLE IF NOT EXISTS qa_extractions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id       TEXT NOT NULL REFERENCES calls(id),
  question_verbatim TEXT NOT NULL,
  answer_given  TEXT,
  taxonomy_id   TEXT,                      -- maps to protocol section e.g. 'G1.pricing', 'G3.pause'
  novel_flag    INTEGER DEFAULT 0,         -- 1 = question not in current taxonomy (drift signal)
  answer_variance_flag INTEGER DEFAULT 0,  -- 1 = answer conflicts with kb_entries approved answer
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kb_entries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  taxonomy_id   TEXT UNIQUE NOT NULL,
  canonical_question TEXT NOT NULL,
  approved_answer_text  TEXT,              -- SMS template
  approved_answer_voice TEXT,              -- talking points
  approved_answer_email TEXT,
  protocol_section TEXT,                   -- pointer into protocol doc
  source_call_ids TEXT,                    -- JSON array of evidence calls
  status        TEXT DEFAULT 'draft',      -- 'draft' | 'approved' | 'needs_verification'
  updated_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS call_scores (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id       TEXT UNIQUE NOT NULL REFERENCES calls(id),
  rubric_version TEXT NOT NULL,
  call_type     TEXT NOT NULL,             -- 'qualification_call' | 'sps' | 'misrouted'
  caller        TEXT,
  location_name TEXT,
  sub_scores    TEXT NOT NULL,             -- JSON object {component: score}
  weighted_total REAL,
  pass_fail     TEXT,                      -- JSON object {competency: bool}
  clarity_outcome TEXT,                    -- 'booked' | 'named_objection' | 'dated_followup' | 'fog'
  booked        INTEGER DEFAULT 0,         -- trend-only; NEVER blended into score
  failure_patterns TEXT,                   -- JSON array
  shareable_summary TEXT,                  -- team-visible
  private_report TEXT,                     -- full report, caller-only
  coaching_priority TEXT,
  scored_at     TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_calls_class ON calls(classification, started_at);
CREATE INDEX IF NOT EXISTS idx_scores_caller ON call_scores(caller, call_type, scored_at);
CREATE INDEX IF NOT EXISTS idx_qa_taxonomy ON qa_extractions(taxonomy_id, novel_flag);
