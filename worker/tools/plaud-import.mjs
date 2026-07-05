// Plaud SPS intake: sweep the shared "Plaud Recordings" Drive folder, work out
// WHICH STUDIO and WHO each recording is, and ingest for the SPS analyzer.
//
// Protocol: the director opens each recording by stating the session type and
// member name ("this is an SPS with Jane Doe"). Resolution order:
//   1. Spoken intro (regex, then Haiku on the opening) -> declared type + member name
//   2. Calendar cross-check on each studio's SPS calendar:
//      a. member-NAME match against event titles (deterministic; also yields contactId)
//      b. else time-window match if only one studio had SPS bookings near the recording
//   3. Staff-name scan of the transcript (per-studio roster)
//   4. Give up gracefully: location 'Unknown', logged for review.
//
// Usage: node tools/plaud-import.mjs            (sweep PLAUD_FOLDER_ID)
//        node tools/plaud-import.mjs --probe "2026-06-22T08:00:00-05:00" ["Kathryn Oliver"]
import 'dotenv/config';
import { bridge } from '../src/bridge.js';
import { openDb, upsertCall } from '../src/db.js';
import { getCalendarEvents } from '../src/ghl.js';
import { extractPlaudIntro } from '../src/claude.js';

const LOCATIONS = JSON.parse(process.env.GHL_LOCATIONS_JSON || '[]');
const SPS_CALENDARS = JSON.parse(process.env.SPS_CALENDARS_JSON || '{}');
const FOLDER = process.env.PLAUD_FOLDER_ID;
const MATCH_WINDOW_MS = Number(process.env.PLAUD_MATCH_WINDOW_H || 3) * 3600_000;

const STAFF_BY_LOCATION = {
  Schaumburg: ['Christian', 'Simanonis'],
  Lincolnshire: ['Colin', 'Yording', 'Eli', 'McKnight'],
};

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z\s]/g, '').trim();

// Tier 1: the spoken declaration. Cheap regexes first; Haiku for messy speech.
async function parseIntro(text) {
  const head = text.slice(0, 2500);
  let m = head.match(/\b(?:sps|starting\s+point)\b[^.\n]{0,80}?(?:with|for)\s+([A-Z][\w'-]+(?:\s+[A-Z][\w'-]+)?)/i);
  if (m) return { declared_type: 'sps', member_name: m[1] };
  m = head.match(/\baccountability\b[^.\n]{0,80}?(?:with|for)\s+([A-Z][\w'-]+(?:\s+[A-Z][\w'-]+)?)/i);
  if (m) return { declared_type: 'accountability', member_name: m[1] };
  try {
    return await extractPlaudIntro(head);
  } catch (e) {
    console.warn(`  intro extraction failed: ${e.message.slice(0, 100)}`);
    return { declared_type: null, member_name: null };
  }
}

// Tier 2: SPS calendars — name match beats time match.
async function calendarMatch(recordedAt, memberName) {
  const t = Date.parse(recordedAt);
  if (!t) return null;
  const candidates = [];
  for (const loc of LOCATIONS) {
    const calId = SPS_CALENDARS[loc.name];
    if (!calId) continue;
    try {
      const { events } = await getCalendarEvents(loc.token, loc.locationId, calId, t - MATCH_WINDOW_MS, t + MATCH_WINDOW_MS);
      for (const e of events || []) {
        candidates.push({
          location: loc.name,
          gapMs: Math.abs(Date.parse(e.startTime) - t),
          title: e.title,
          contact: (e.title || '').replace(/\s*-\s*Starting Point.*$/i, '').trim() || null,
          contactId: e.contactId || null,
        });
      }
    } catch (err) {
      console.warn(`  calendar query failed for ${loc.name}: ${err.message.slice(0, 120)}`);
    }
  }
  if (!candidates.length) return null;
  // (a) name match — deterministic
  if (memberName) {
    const target = norm(memberName);
    const [first] = target.split(/\s+/);
    const named = candidates.filter((c) => {
      const ct = norm(c.contact);
      return ct && (ct.includes(target) || target.includes(ct) || ct.split(/\s+/)[0] === first);
    });
    if (named.length) {
      named.sort((a, b) => a.gapMs - b.gapMs);
      return { ...named[0], how: 'calendar-name', ambiguous: false };
    }
  }
  // (b) time-only — unambiguous single studio, or clearly closer
  candidates.sort((a, b) => a.gapMs - b.gapMs);
  const locations = new Set(candidates.map((c) => c.location));
  if (locations.size === 1) return { ...candidates[0], how: 'calendar-time', ambiguous: false };
  const [best, ...rest] = candidates;
  const otherBest = rest.find((c) => c.location !== best.location);
  if (otherBest && otherBest.gapMs - best.gapMs > 45 * 60_000) return { ...best, how: 'calendar-time', ambiguous: false };
  return { ...best, how: 'calendar-time', ambiguous: true };
}

function staffScan(text) {
  const head = text.slice(0, 4000);
  for (const [loc, names] of Object.entries(STAFF_BY_LOCATION)) {
    if (names.some((n) => new RegExp(`\\b${n}\\b`, 'i').test(head))) return loc;
  }
  return null;
}

function parseRecordedAt(name, created) {
  let m = name.match(/(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})[\sT_-]+(\d{2})[:._]?(\d{2})/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] + 5, +m[5])).toISOString(); // filenames are local CT ≈ UTC-5
  m = name.match(/(\d{4})[\s/-](\d{1,2})[\s/-](\d{1,2})/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 17)).toISOString();
  return created || null;
}

// ---- probe mode ----
const probeIdx = process.argv.indexOf('--probe');
if (probeIdx !== -1) {
  const when = process.argv[probeIdx + 1];
  const who = process.argv[probeIdx + 2] || null;
  console.log('probe', when, who || '(no name)', '→', JSON.stringify(await calendarMatch(when, who), null, 1));
  process.exit(0);
}

// ---- sweep mode ----
if (!FOLDER) {
  console.log('PLAUD_FOLDER_ID not set — Plaud intake idle.');
  process.exit(0);
}

const db = openDb();
const exists = (id) => db.prepare('SELECT 1 FROM calls WHERE id = ?').get(id);
const { items } = await bridge('listFolder', { folderId: FOLDER });
const docs = items.filter((i) => i.mimeType === 'application/vnd.google-apps.document' && !exists(`drive_${i.id}`));
console.log(`plaud folder: ${items.length} items, ${docs.length} new docs`);

for (let i = 0; i < docs.length; i += 10) {
  const { docs: batch } = await bridge('getDocs', { ids: docs.slice(i, i + 10).map((d) => d.id) });
  for (const doc of batch) {
    if (doc.error || !doc.text || doc.text.trim().length < 500) {
      console.log(`  skip ${doc.name || doc.id}: ${doc.error || 'too short'}`);
      continue;
    }
    const recordedAt = parseRecordedAt(doc.name, doc.created);
    const intro = await parseIntro(doc.text);
    const match = await calendarMatch(recordedAt, intro.member_name);
    let location = match && !match.ambiguous ? match.location : null;
    let how = location ? match.how : null;
    if (!location) {
      location = staffScan(doc.text);
      how = location ? 'staff-scan' : null;
    }
    if (!location) {
      location = 'Unknown';
      how = 'UNRESOLVED — review';
    }
    const isSps = intro.declared_type === 'sps' || (match?.how === 'calendar-name') || /\bsps\b/i.test(doc.name);
    const loc = LOCATIONS.find((l) => l.name === location);
    upsertCall(db, {
      kind: isSps ? 'sps' : null, // undeclared/other sessions fall to the classifier
      id: `drive_${doc.id}`,
      conversation_id: 'plaud',
      contact_id: match?.contactId || null,
      contact_name: intro.member_name || match?.contact || null,
      location_id: loc?.locationId || 'unknown',
      location_name: location,
      direction: null,
      staff: intro.director_name || (location === 'Lincolnshire' ? 'Colin Yording' : location === 'Schaumburg' ? 'Christian Simanonis' : null),
      started_at: recordedAt,
      duration_sec: null,
      recording_url: null,
      transcript: doc.text.trim(),
      transcript_source: 'plaud',
    });
    console.log(`  imported ${doc.name} → ${location} (${how}) | type: ${isSps ? 'sps' : intro.declared_type || '?'} | member: ${intro.member_name || match?.contact || '?'}`);
  }
}
console.log('PLAUD SWEEP DONE');
