// Alloy Call Intelligence — Phase 1 worker
// Two feeds (belt & suspenders, same pattern as alloy_leadflow.gs):
//   1. POST /webhook/ghl-call  ← GHL workflow "call completed" custom-webhook action
//   2. pollOnce()              ← nightly sweep via PIT for anything the webhook missed
// Pipeline: ingest → transcript → classify → (if sales) evaluate → store.

import 'dotenv/config';
import express from 'express';
import { openDb, upsertCall, setClassification, insertScore, unprocessedCalls, unscoredSalesCalls, unscoredAccountabilityCalls, qaPendingCalls, insertQaRows, claim, releaseClaim, cleanStaleClaims } from './db.js';
import { searchConversations, getMessages, getTranscription, isCallMessage } from './ghl.js';
import { classifyCall, evaluateSalesCall, evaluateSps, evaluateAccountability, extractQa } from './claude.js';
import { phoneTone, prosodyFromTranscription } from './tone.js';
import { phoneDeliveryRead, deliveryReadFromFile, deliverySummary, audioEnabled } from './audio.js';
import { fetchPlaudShare } from './plaud.js';
import { rmSync } from 'node:fs';
import { bridge, bridgeEnabled } from './bridge.js';
import { registerDashboard } from './dashboard.js';

const db = openDb();
const app = express();
app.use(express.json({ limit: '2mb' }));
registerDashboard(app, db); // GET /call-intel (Caddy adds basic auth in front)

// Location registry: locationId → { name, token }
const LOCATIONS = JSON.parse(process.env.GHL_LOCATIONS_JSON || '[]');
const locById = Object.fromEntries(LOCATIONS.map((l) => [l.locationId, l]));
const locByName = Object.fromEntries(LOCATIONS.map((l) => [l.name, l]));

// GHL userId → display name (both locations merged; poll only returns userId)
const USERS = JSON.parse(process.env.GHL_USERS_JSON || '{}');
const staffName = (idOrName) => (idOrName ? USERS[idOrName] || idOrName : null);

// Report delivery: staff display name → email. Reports for calls older than
// REPORT_MAX_AGE_DAYS are stored but not emailed (protects against backfills).
const STAFF_EMAILS = JSON.parse(process.env.STAFF_EMAILS_JSON || '{}');
const REPORT_FALLBACK_EMAIL = process.env.REPORT_FALLBACK_EMAIL || null;
const REPORT_MAX_AGE_DAYS = Number(process.env.REPORT_MAX_AGE_DAYS || 3);

// SPS reports go to a fixed oversight set — the studio head + the two owners
// (Prashant, Nimisha) — regardless of who ran the session. The studio head is
// chosen by detected studio; the owners are always included so a studio misread
// never drops the report. Phone calls keep per-staff routing (see deliverReport).
const STUDIO_HEAD = { Lincolnshire: 'Colin Yording', Schaumburg: 'Christian Simanonis' };
const SPS_OVERSIGHT = ['Prashant Singri', 'Nimisha Singri'];
// Studio head is held back until the reports are validated — owners get them first.
// Set SPS_INCLUDE_STUDIO_HEAD=true (no code change) to also send To: the studio head.
const SPS_INCLUDE_STUDIO_HEAD = process.env.SPS_INCLUDE_STUDIO_HEAD === 'true';

const CONFIDENCE_THRESHOLD = Number(process.env.REVIEW_THRESHOLD || 0.7);
const MIN_CALL_SEC = Number(process.env.MIN_CALL_SEC || 45); // under this: voicemail tag, auto-classify without a Claude call
const MIN_EVAL_SEC = Number(process.env.MIN_EVAL_SEC || 180); // sales calls under this: clarity tracked (classifier), but no full-rubric eval
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET; // set the same value in the GHL workflow header

// ---------- Feed 1: real-time webhook ----------
app.post('/webhook/ghl-call', async (req, res) => {
  // Secret via header (preferred) or ?secret= (GHL webhook actions without custom headers).
  const supplied = req.headers['x-webhook-secret'] || req.query.secret;
  if (WEBHOOK_SECRET && supplied !== WEBHOOK_SECRET) {
    return res.status(401).json({ ok: false });
  }
  res.json({ ok: true }); // ack fast; process async
  try {
    const p = req.body || {};
    console.log('webhook payload keys:', Object.keys(p).join(','));
    // GHL workflow payloads vary by trigger config — map the fields you wire up.
    const locationId = p.locationId || p.location_id || p.location?.id;
    const contactId = p.contactId || p.contact_id;
    const loc = locById[locationId];
    if (!loc) return console.warn('webhook: unknown location', locationId);
    // Recording/transcript can lag ~1 min after call end — delay before fetch.
    await sleep(90_000);
    if (p.messageId || p.message_id) {
      await ingestCallMessage(loc, {
        id: p.messageId || p.message_id,
        conversationId: p.conversationId || p.conversation_id,
        contactId,
        contactName: p.contactName || p.full_name || p.name,
        direction: p.direction,
        staff: staffName(p.userId) || p.userName || p.assignedUser,
        startedAt: p.dateAdded || new Date().toISOString(),
        durationSec: p.callDuration ? Number(p.callDuration) : null,
      });
    } else if (contactId) {
      // No messageId in the payload — sweep this contact's conversations instead.
      await ingestByContact(loc, contactId);
    } else {
      return console.warn('webhook: no messageId or contactId in payload');
    }
    await processQueue();
  } catch (e) {
    console.error('webhook processing error:', e.message);
  }
});

// Ingest all recent call messages for one contact (webhook fallback path).
async function ingestByContact(loc, contactId) {
  const conv = await searchConversations(loc.token, loc.locationId, { limit: 5, contactId });
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
        staff: staffName(m.userId),
        startedAt: m.dateAdded,
        durationSec: m.meta?.call?.duration ?? null,
      });
    }
  }
}

// ---------- Feed 3: Plaud share links (in-person SPS/Deep Dive) ----------
// A "Plaud Links" sheet's onEdit trigger POSTs { link } here the instant a link
// is pasted. One public share is self-contained: transcript + audio + metadata.
// Processed inline (audio presigned URL is fresh) → SPS rubric + Tier A/B tone.
app.post('/webhook/plaud', async (req, res) => {
  const supplied = req.headers['x-webhook-secret'] || req.query.secret;
  if (WEBHOOK_SECRET && supplied !== WEBHOOK_SECRET) return res.status(401).json({ ok: false });
  const link = (req.body && (req.body.link || req.body.url)) || req.query.link;
  if (!link) return res.status(400).json({ ok: false, error: 'no link' });
  res.json({ ok: true }); // ack fast; process async
  try {
    await processPlaudLink(link);
  } catch (e) {
    console.error('plaud processing error:', e.message);
  }
});

async function processPlaudLink(link) {
  const s = await fetchPlaudShare(link);
  if (!claim(db, `score:${s.id}`)) return console.log(`plaud ${s.id} already claimed`);
  try {
    const call = {
      id: s.id,
      kind: 'sps',
      conversation_id: 'plaud_link',
      contact_id: null,
      contact_name: s.member,
      location_id: locByName[s.studio]?.locationId || 'unknown',
      location_name: s.studio,
      direction: null,
      staff: s.studio === 'Lincolnshire' ? 'Colin Yording' : s.studio === 'Schaumburg' ? 'Christian Simanonis' : null,
      started_at: s.date,
      duration_sec: s.duration_sec,
      recording_url: null,
      transcript: s.transcript,
      transcript_source: 'plaud',
    };
    upsertCall(db, call);
    const prosody = prosodyFromTranscription(s.sentences);
    const audioRead = s.audioPath ? await deliveryReadFromFile(s.audioPath, { call_type: 'sps' }) : null;
    if (s.audioPath) { try { rmSync(s.audioPath, { force: true }); } catch {} }
    const toneMeta = [prosody?.summary, deliverySummary(audioRead)].filter(Boolean).join('\n') || undefined;
    const { json, private_report } = await evaluateSps(s.transcript, {
      caller: call.staff,
      location: s.studio,
      duration_sec: s.duration_sec,
      recent_failure_patterns: recentPatterns(call),
      tone: toneMeta,
    });
    await persistScore(call, json, private_report);
    console.log(`plaud scored ${s.id} (${s.studio}, ${s.member || '?'}) ${json.weighted_total}`);
  } catch (e) {
    releaseClaim(db, `score:${s.id}`);
    throw e;
  }
}

// ---------- Feed 2: polling sweep ----------
// POLL_CONVERSATIONS trades depth for speed: 25 for the every-10-min quick poll,
// 100 (default) for the nightly full sweep. Cron wraps runs in flock so poll
// processes never overlap; claims guard against webhook-process overlap.
export async function pollOnce() {
  cleanStaleClaims(db);
  const limit = Number(process.env.POLL_CONVERSATIONS || 100);
  for (const loc of LOCATIONS) {
    try {
      const conv = await searchConversations(loc.token, loc.locationId, { limit });
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
            staff: staffName(m.userId),
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
// this pass (one bad transcript can't loop forever) or that returned 'skip'
// (claimed by another process — it will complete them, not us).
async function drain(nextBatch, handle) {
  const skip = new Set();
  while (true) {
    const batch = nextBatch().filter((c) => !skip.has(c.id));
    if (!batch.length) break;
    for (const call of batch) {
      try {
        if ((await handle(call)) === 'skip') skip.add(call.id);
      } catch (e) {
        skip.add(call.id);
        console.error(`processing failed for ${call.id}:`, e.message);
      }
    }
  }
}

async function processQueueOnce() {
  await drain(() => unprocessedCalls(db), async (call) => {
    if (!claim(db, `classify:${call.id}`)) return 'skip'; // another process has it
    try {
      if (call.duration_sec != null && call.duration_sec < MIN_CALL_SEC) {
        setClassification(db, call.id, {
          classification: 'admin_other',
          confidence: 1,
          summary: `auto-skipped: ${call.duration_sec}s call, under ${MIN_CALL_SEC}s threshold`,
          outcome: 'too short to classify',
          next_action: 'none',
        });
        console.log(`skipped ${call.id}: ${call.duration_sec}s < ${MIN_CALL_SEC}s`);
        return;
      }
      const c = await classifyCall(call.transcript);
      const classification = c.confidence < CONFIDENCE_THRESHOLD ? 'REVIEW' : c.classification;
      setClassification(db, call.id, {
        classification,
        confidence: c.confidence,
        summary: c.summary,
        outcome: c.outcome,
        next_action: c.next_action,
        clarity_outcome: classification === 'sales' ? c.clarity_outcome || null : null,
      });
      console.log(`classified ${call.id}: ${classification} (${c.confidence})`);
    } catch (e) {
      releaseClaim(db, `classify:${call.id}`); // let the next run retry
      throw e;
    }
  });
  const scoreWith = (pickEvaluator) => async (call) => {
    if (!claim(db, `score:${call.id}`)) return 'skip'; // another process has it
    let json, private_report;
    try {
      const tone = await phoneTone(locById[call.location_id], call); // Tier A: prosody from transcript timing
      const audioRead = await phoneDeliveryRead(locById[call.location_id], call); // Tier B: vocal delivery read
      const toneMeta = [tone?.summary, deliverySummary(audioRead)].filter(Boolean).join('\n') || undefined;
      ({ json, private_report } = await pickEvaluator(call)(call.transcript, {
        caller: call.staff,
        location: call.location_name,
        direction: call.direction,
        duration_sec: call.duration_sec,
        source: call.transcript_source, // ghl_native can never be an SPS (in-person only)
        recent_failure_patterns: recentPatterns(call), // lets the report call out streaks
        tone: toneMeta, // Tier A timing stats + Tier B vocal delivery read
      }));
    } catch (e) {
      releaseClaim(db, `score:${call.id}`); // let the next run retry
      throw e;
    }
    await persistScore(call, json, private_report);
  };
  // Sales: kind='sps' (in-person Otter/Plaud transcript) → Prashant's SPS rubric;
  // everything else → the phone qualification-call rubric.
  await drain(() => unscoredSalesCalls(db, MIN_EVAL_SEC),
    scoreWith((call) => (call.kind === 'sps' ? evaluateSps : evaluateSalesCall)));
  // Accountability sessions (phone check-ins + in-person Deep Dives) → acct rubric.
  await drain(() => unscoredAccountabilityCalls(db, MIN_EVAL_SEC),
    scoreWith(() => evaluateAccountability));
  // Phase 2: Q&A extraction for the agent knowledgebase (sales/member/accountability calls).
  await drain(() => qaPendingCalls(db, MIN_CALL_SEC), async (call) => {
    if (!claim(db, `qa:${call.id}`)) return 'skip';
    try {
      const { qa } = await extractQa(call.transcript);
      insertQaRows(db, call.id, Array.isArray(qa) ? qa : []);
      const novel = (qa || []).filter((r) => r.novel).length;
      console.log(`qa ${call.id}: ${(qa || []).length} pairs${novel ? ` (${novel} novel)` : ''}`);
    } catch (e) {
      releaseClaim(db, `qa:${call.id}`);
      throw e;
    }
  });
}

// The caller's failure patterns from their last 5 scored calls — so this
// report can say "third call in a row you skipped intake capture".
function recentPatterns(call) {
  if (!call.staff) return [];
  try {
    const rows = db.prepare(`
      SELECT s.failure_patterns FROM call_scores s JOIN calls c ON c.id = s.call_id
      WHERE s.caller = ? AND s.call_type != 'misrouted' AND (c.started_at < ? OR ? IS NULL)
      ORDER BY c.started_at DESC LIMIT 5`).all(call.staff, call.started_at, call.started_at);
    const counts = {};
    for (const r of rows) for (const p of JSON.parse(r.failure_patterns || '[]')) counts[p] = (counts[p] || 0) + 1;
    return Object.entries(counts).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([p, n]) => `${p} (${n} of last ${rows.length} calls)`);
  } catch {
    return [];
  }
}

export const DASHBOARD_BASE = process.env.DASHBOARD_BASE || 'https://alloy-members.duckdns.org/call-intel';

// One row per analysis into the central Analysis Index sheet (best-effort).
async function pushIndexRow(call, json) {
  if (!bridgeEnabled() || json.call_type === 'misrouted') return;
  try {
    const claimed = db.prepare('UPDATE call_scores SET indexed = 1 WHERE call_id = ? AND indexed = 0').run(call.id);
    if (claimed.changes !== 1) return; // already in the sheet
    await bridge('appendIndexRows', {
      rows: [{
        date: (call.started_at || '').slice(0, 16).replace('T', ' '),
        studio: call.location_name,
        teamMember: call.staff || json.caller || '',
        contact: call.contact_name || '',
        type: json.call_type,
        score: json.weighted_total,
        clarity: json.clarity_outcome,
        booked: Boolean(json.booked),
        coachingPriority: json.coaching_priority || '',
        summary: json.shareable_summary || '',
        reportUrl: `${DASHBOARD_BASE}/report/${call.id}`,
      }],
    });
  } catch (e) {
    db.prepare('UPDATE call_scores SET indexed = 0 WHERE call_id = ?').run(call.id); // retry via backfill
    console.error(`index push failed for ${call.id}:`, e.message);
  }
}

// Shared tail of scoring: store the score row, log, email the report, index it.
async function persistScore(call, json, private_report) {
  insertScore(db, {
    call_id: call.id,
    rubric_version: json.rubric_version,
    call_type: json.call_type,
    caller: call.staff || json.caller || null, // our attribution, not the model's echo
    location_name: call.location_name,
    sub_scores: JSON.stringify(json.sub_scores || {}),
    weighted_total: json.weighted_total ?? null,
    // session subtype + growth-ask (accountability) ride along in the pass_fail blob
    pass_fail: JSON.stringify({
      ...(json.pass_fail || {}),
      ...(json.growth_ask ? { growth_ask: json.growth_ask } : {}),
      ...(json.session_type ? { session_type: json.session_type } : {}),
    }),
    clarity_outcome: json.clarity_outcome || null,
    booked: json.booked ? 1 : 0,
    failure_patterns: JSON.stringify(json.failure_patterns || []),
    shareable_summary: json.shareable_summary || null,
    private_report,
    coaching_priority: json.coaching_priority || null,
  });
  console.log(`scored ${call.id}: ${json.call_type} ${json.weighted_total}`);
  await deliverReport(call, json, private_report);
  await pushIndexRow(call, json);
}

// ---------- Phase 3: private report to the caller, minutes after the call ----------
async function deliverReport(call, json, private_report) {
  if (!bridgeEnabled() || json.call_type === 'misrouted') return;
  const ageDays = call.started_at ? (Date.now() - Date.parse(call.started_at)) / 86400_000 : Infinity;
  if (ageDays > REPORT_MAX_AGE_DAYS) return; // backfill — store only, never email
  const isSps = json.call_type === 'sps' || call.kind === 'sps';
  let recipients;
  if (isSps) {
    const head = SPS_INCLUDE_STUDIO_HEAD ? STUDIO_HEAD[call.location_name] : null; // held back until validated
    recipients = [head && STAFF_EMAILS[head], ...SPS_OVERSIGHT.map((n) => STAFF_EMAILS[n])];
  } else {
    recipients = [STAFF_EMAILS[call.staff]]; // phone calls: the person who took the call
  }
  recipients = [...new Set(recipients.filter(Boolean))];
  if (!recipients.length && REPORT_FALLBACK_EMAIL) recipients = [REPORT_FALLBACK_EMAIL];
  if (!recipients.length) return console.warn(`no recipients for "${call.staff}" (${call.location_name}) — report not delivered`);
  const [to, ...cc] = recipients;
  try {
    const when = (call.started_at || '').slice(0, 16).replace('T', ' ');
    const header = [
      `Caller: ${call.staff || 'unknown'}   Studio: ${call.location_name}`,
      `Contact: ${call.contact_name || 'unknown'}   When: ${when}   Length: ${call.duration_sec ? Math.round(call.duration_sec / 60) + ' min' : '?'}`,
      `Score: ${json.weighted_total}/100 (${json.call_type})   Clarity: ${json.clarity_outcome}`,
      ``,
      `COACHING PRIORITY: ${json.coaching_priority || '—'}`,
      ``,
      `This report is private to you. The team scorecard only sees scores and the shareable summary.`,
      `--------------------------------------------------------------------`,
      ``,
    ].join('\n');
    await bridge('report', {
      to,
      cc: cc.length ? cc.join(',') : undefined,
      subject: `${json.call_type === 'sps' ? 'SPS review' : json.call_type === 'accountability' ? 'Accountability review' : 'Call review'}: ${call.contact_name || 'unknown contact'} — ${json.weighted_total}/100${json.clarity_outcome ? `, ${json.clarity_outcome}` : ''}`,
      text: header + private_report,
    });
    console.log(`report emailed to ${[to, ...cc].join(', ')} for ${call.id}`);
  } catch (e) {
    console.error(`report delivery failed for ${call.id}:`, e.message);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = process.env.PORT || 3131;
if (process.argv.includes('--poll')) {
  pollOnce().then(() => process.exit(0));
} else {
  app.listen(PORT, () => console.log(`call-intelligence worker on :${PORT}`));
}
