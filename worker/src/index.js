// Alloy Call Intelligence — Phase 1 worker
// Two feeds (belt & suspenders, same pattern as alloy_leadflow.gs):
//   1. POST /webhook/ghl-call  ← GHL workflow "call completed" custom-webhook action
//   2. pollOnce()              ← nightly sweep via PIT for anything the webhook missed
// Pipeline: ingest → transcript → classify → (if sales) evaluate → store.

import 'dotenv/config';
import express from 'express';
import { openDb, upsertCall, setClassification, insertScore, unprocessedCalls, unscoredSalesCalls } from './db.js';
import { searchConversations, getMessages, getTranscription, isCallMessage } from './ghl.js';
import { classifyCall, evaluateSalesCall } from './claude.js';

const db = openDb();
const app = express();
app.use(express.json({ limit: '2mb' }));

// Location registry: locationId → { name, token }
const LOCATIONS = JSON.parse(process.env.GHL_LOCATIONS_JSON || '[]');
const locById = Object.fromEntries(LOCATIONS.map((l) => [l.locationId, l]));

const CONFIDENCE_THRESHOLD = Number(process.env.REVIEW_THRESHOLD || 0.7);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET; // set the same value in the GHL workflow header

// ---------- Feed 1: real-time webhook ----------
app.post('/webhook/ghl-call', async (req, res) => {
  if (WEBHOOK_SECRET && req.headers['x-webhook-secret'] !== WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false });
  }
  res.json({ ok: true }); // ack fast; process async
  try {
    const p = req.body || {};
    // GHL workflow payloads vary by trigger config — map the fields you wire up.
    const locationId = p.locationId || p.location_id;
    const loc = locById[locationId];
    if (!loc) return console.warn('webhook: unknown location', locationId);
    // Recording/transcript can lag ~1 min after call end — delay before fetch.
    await sleep(90_000);
    await ingestCallMessage(loc, {
      id: p.messageId || p.message_id,
      conversationId: p.conversationId || p.conversation_id,
      contactId: p.contactId,
      contactName: p.contactName || p.full_name,
      direction: p.direction,
      staff: p.userName || p.assignedUser,
      startedAt: p.dateAdded || new Date().toISOString(),
      durationSec: p.callDuration ? Number(p.callDuration) : null,
    });
    await processQueue();
  } catch (e) {
    console.error('webhook processing error:', e.message);
  }
});

// ---------- Feed 2: polling sweep ----------
export async function pollOnce() {
  for (const loc of LOCATIONS) {
    try {
      const conv = await searchConversations(loc.token, loc.locationId);
      for (const c of conv?.conversations || []) {
        const msgs = await getMessages(loc.token, c.id);
        const list = msgs?.messages?.messages || msgs?.messages || [];
        for (const m of list.filter(isCallMessage)) {
          await ingestCallMessage(loc, {
            id: m.id,
            conversationId: c.id,
            contactId: c.contactId,
            contactName: c.fullName || c.contactName,
            direction: m.direction,
            staff: m.userId || null,
            startedAt: m.dateAdded,
            durationSec: m.meta?.call?.duration ?? null,
          });
        }
      }
    } catch (e) {
      console.error(`poll error for ${loc.name}:`, e.message);
    }
  }
  await processQueue();
}

// ---------- Ingest one call ----------
async function ingestCallMessage(loc, m) {
  if (!m.id) return;
  let transcript = null;
  let source = null;
  try {
    const t = await getTranscription(loc.token, loc.locationId, m.id);
    transcript = normalizeTranscript(t);
    source = transcript ? 'ghl_native' : null;
  } catch (e) {
    console.warn(`no native transcript for ${m.id} (${e.message}) — leaving for whisper fallback`);
    // Whisper fallback: download recording via getRecording() and run local whisper.
    // Intentionally not automated in Phase 1 — short calls without transcripts are usually voicemail tag.
  }
  upsertCall(db, {
    id: m.id,
    conversation_id: m.conversationId || '',
    contact_id: m.contactId || null,
    contact_name: m.contactName || null,
    location_id: loc.locationId,
    location_name: loc.name,
    direction: m.direction || null,
    staff: m.staff || null,
    started_at: m.startedAt || null,
    duration_sec: m.durationSec || null,
    recording_url: null,
    transcript,
    transcript_source: source,
  });
}

// The transcription endpoint returns an array of sentence objects
// ({ mediaChannel, sentenceIndex, transcript, ... }); older shapes were flat.
function normalizeTranscript(t) {
  if (t == null) return null;
  if (typeof t === 'string') return t.trim() || null;
  const sentences = Array.isArray(t) ? t : Array.isArray(t.transcriptions) ? t.transcriptions : null;
  if (sentences) {
    const text = sentences
      .map((s) => (typeof s === 'string' ? s : [s.mediaChannel != null ? `[ch${s.mediaChannel}]` : null, s.transcript ?? s.text].filter(Boolean).join(' ')))
      .filter(Boolean)
      .join('\n');
    return text.trim() || null;
  }
  return t.transcription || t.transcript || null;
}

// ---------- Classify + evaluate ----------
// Webhook bursts and the nightly poll can both call this; serialize so the same
// call is never sent to the Claude API twice. A run scheduled while another is
// in flight coalesces into one follow-up pass.
let queueRunning = false;
let queueRerun = false;
async function processQueue() {
  if (queueRunning) {
    queueRerun = true;
    return;
  }
  queueRunning = true;
  try {
    do {
      queueRerun = false;
      await processQueueOnce();
    } while (queueRerun);
  } finally {
    queueRunning = false;
  }
}

// Drain a batched queue query until empty, skipping calls that already failed
// this pass so one bad transcript can't loop forever.
async function drain(nextBatch, handle) {
  const failed = new Set();
  while (true) {
    const batch = nextBatch().filter((c) => !failed.has(c.id));
    if (!batch.length) break;
    for (const call of batch) {
      try {
        await handle(call);
      } catch (e) {
        failed.add(call.id);
        console.error(`processing failed for ${call.id}:`, e.message);
      }
    }
  }
}

async function processQueueOnce() {
  await drain(() => unprocessedCalls(db), async (call) => {
    const c = await classifyCall(call.transcript);
    const classification = c.confidence < CONFIDENCE_THRESHOLD ? 'REVIEW' : c.classification;
    setClassification(db, call.id, {
      classification,
      confidence: c.confidence,
      summary: c.summary,
      outcome: c.outcome,
      next_action: c.next_action,
    });
    console.log(`classified ${call.id}: ${classification} (${c.confidence})`);
  });
  await drain(() => unscoredSalesCalls(db), async (call) => {
    const { json, private_report } = await evaluateSalesCall(call.transcript, {
      caller: call.staff,
      location: call.location_name,
      direction: call.direction,
      duration_sec: call.duration_sec,
    });
    insertScore(db, {
      call_id: call.id,
      rubric_version: json.rubric_version,
      call_type: json.call_type,
      caller: json.caller || call.staff,
      location_name: call.location_name,
      sub_scores: JSON.stringify(json.sub_scores || {}),
      weighted_total: json.weighted_total ?? null,
      pass_fail: JSON.stringify(json.pass_fail || {}),
      clarity_outcome: json.clarity_outcome || null,
      booked: json.booked ? 1 : 0,
      failure_patterns: JSON.stringify(json.failure_patterns || []),
      shareable_summary: json.shareable_summary || null,
      private_report,
      coaching_priority: json.coaching_priority || null,
    });
    console.log(`scored ${call.id}: ${json.call_type} ${json.weighted_total}`);
    // TODO Phase 3: deliver private_report to the caller (email/SMS/Slack).
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = process.env.PORT || 3131;
if (process.argv.includes('--poll')) {
  pollOnce().then(() => process.exit(0));
} else {
  app.listen(PORT, () => console.log(`call-intelligence worker on :${PORT}`));
}
