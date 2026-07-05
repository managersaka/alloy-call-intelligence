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
  const opening = head.slice(0, 800);
  const spokenLoc =
    /schaumburg/i.test(opening) && !/lincolnshire/i.test(opening) ? 'Schaumburg'
    : /lincolnshire/i.test(opening) && !/schaumburg/i.test(opening) ? 'Lincolnshire'
    : null;
  let m = head.match(/\b(?:sps|starting\s+point)\b[^.\n]{0,80}?(?:with|for)\s+([A-Z][\w'-]+(?:\s+[A-Z][\w'-]+)?)/i);
  if (m) return { declared_type: 'sps', member_name: m[1], location: spokenLoc };
  m = head.match(/\baccountability\b[^.\n]{0,80}?(?:with|for)\s+([A-Z][\w'-]+(?:\s+[A-Z][\w'-]+)?)/i);
  if (m) return { declared_type: 'accountability', member_name: m[1], location: spokenLoc };
  try {
    const r = await extractPlaudIntro(head);
    return { ...r, location: r.location || spokenLoc };
  } catch (e) {
    console.warn(`  intro extraction failed: ${e.message.slice(0, 100)}`);
    return { declared_type: null, member_name: null, location: spokenLoc };
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
// Decision per doc:
//   member session (declared SPS/accountability, or calendar NAME match) -> import for analysis
//   unambiguous time-only SPS-calendar match, undeclared                 -> leave in place, flag review
//   everything else (Prashant's meetings, interviews, lectures, tests)   -> MOVE to "Prashant Files"
// plaud_files memoizes decisions so nightly sweeps never re-process a doc.
if (!FOLDER) {
  console.log('PLAUD_FOLDER_ID not set — Plaud intake idle.');
  process.exit(0);
}

const db = openDb();
db.exec(`CREATE TABLE IF NOT EXISTS plaud_files (id TEXT PRIMARY KEY, name TEXT, decision TEXT, at TEXT DEFAULT (datetime('now')))`);
const decided = (id) => db.prepare('SELECT 1 FROM plaud_files WHERE id = ?').get(id);
const remember = (id, name, decision) =>
  db.prepare('INSERT OR REPLACE INTO plaud_files (id, name, decision) VALUES (?, ?, ?)').run(id, name, decision);

const { folderId: prashantFolder } = await bridge('ensureSiblingFolder', { siblingFolderId: FOLDER, name: 'Prashant Files' });

const { items } = await bridge('listFolder', { folderId: FOLDER });
const docs = items.filter((i) => i.mimeType === 'application/vnd.google-apps.document' && !decided(i.id));
console.log(`plaud folder: ${items.length} items, ${docs.length} undecided docs`);

for (let i = 0; i < docs.length; i += 10) {
  const { docs: batch } = await bridge('getDocs', { ids: docs.slice(i, i + 10).map((d) => d.id) });
  for (const doc of batch) {
    if (doc.error) {
      console.log(`  skip ${doc.name || doc.id}: ${doc.error}`);
      continue; // transient — retry next sweep
    }
    if (!doc.text || doc.text.trim().length < 500) {
      await bridge('moveFile', { fileId: doc.id, toFolderId: prashantFolder });
      remember(doc.id, doc.name, 'moved-short');
      console.log(`  filed to Prashant Files (too short): ${doc.name}`);
      continue;
    }
    const recordedAt = parseRecordedAt(doc.name, doc.created);
    const intro = await parseIntro(doc.text);
    const match = await calendarMatch(recordedAt, intro.member_name);
    const memberSession = Boolean(intro.declared_type && intro.declared_type !== 'other') || match?.how === 'calendar-name';

    if (!memberSession) {
      if (match && !match.ambiguous && match.how === 'calendar-time') {
        // Could be an SPS where the director forgot the declaration — do not move, do not import.
        remember(doc.id, doc.name, 'review');
        console.log(`  REVIEW (undeclared, but ${match.location} had an SPS booked nearby): ${doc.name}`);
      } else {
        await bridge('moveFile', { fileId: doc.id, toFolderId: prashantFolder });
        remember(doc.id, doc.name, 'moved');
        console.log(`  filed to Prashant Files: ${doc.name}`);
      }
      continue;
    }

    // Tier 0: the director stated the studio out loud — trust it above everything.
    let location = ['Schaumburg', 'Lincolnshire'].includes(intro.location) ? intro.location : null;
    let how = location ? 'spoken' : null;
    if (!location && match && !match.ambiguous) {
      location = match.location;
      how = match.how;
    }
    if (!location) {
      location = staffScan(doc.text);
      how = location ? 'staff-scan' : null;
    }
    if (!location) {
      location = 'Unknown';
      how = 'UNRESOLVED — review';
    }
    const isSps = intro.declared_type === 'sps' || match?.how === 'calendar-name' || /\bsps\b/i.test(doc.name);
    const loc = LOCATIONS.find((l) => l.name === location);
    upsertCall(db, {
      kind: isSps ? 'sps' : null, // declared accountability etc. fall to the classifier
      id: `drive_${doc.id}`,
      conversation_id: 'plaud',
      contact_id: match?.how === 'calendar-name' ? match.contactId : null,
      contact_name: intro.member_name || (match?.how === 'calendar-name' ? match.contact : null),
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
    remember(doc.id, doc.name, 'imported');
    console.log(`  imported ${doc.name} → ${location} (${how}) | type: ${isSps ? 'sps' : intro.declared_type || '?'} | member: ${intro.member_name || match?.contact || '?'}`);
  }
}
console.log('PLAUD SWEEP DONE');
