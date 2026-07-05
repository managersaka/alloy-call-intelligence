// Plaud SPS intake: sweep the shared Plaud Drive folder, figure out WHICH STUDIO
// each recording belongs to, and ingest as kind='sps' for the SPS analyzer.
//
// Location decision, in order of trust:
//   1. Device hint in the filename (PLAUD_DEVICE_HINTS env: substring -> studio;
//      name each Plaud device after its studio and this is deterministic)
//   2. Calendar cross-check: recording time vs scheduled SPS on each studio's
//      SPS calendar (SPS_CALENDARS env). A match also yields the prospect's
//      name (event title) and, when present, the assigned director.
//   3. Staff-name scan of the transcript text (per-studio roster)
//   4. Give up gracefully: import with location 'Unknown' and log for review.
//
// Usage: node tools/plaud-import.mjs            (sweep PLAUD_FOLDER_ID)
//        node tools/plaud-import.mjs --probe "2026-06-22T08:00:00-05:00"
//        (probe mode: prints what the calendar matcher would decide, no import)
import 'dotenv/config';
import { bridge } from '../src/bridge.js';
import { openDb, upsertCall } from '../src/db.js';
import { getCalendarEvents } from '../src/ghl.js';

const LOCATIONS = JSON.parse(process.env.GHL_LOCATIONS_JSON || '[]');
const SPS_CALENDARS = JSON.parse(process.env.SPS_CALENDARS_JSON || '{}'); // { "Schaumburg": "calId", ... }
const DEVICE_HINTS = JSON.parse(process.env.PLAUD_DEVICE_HINTS_JSON || '{}'); // { "SCH": "Schaumburg", ... }
const FOLDER = process.env.PLAUD_FOLDER_ID;
const MATCH_WINDOW_MS = Number(process.env.PLAUD_MATCH_WINDOW_H || 3) * 3600_000;

const STAFF_BY_LOCATION = {
  Schaumburg: ['Christian', 'Simanonis'],
  Lincolnshire: ['Colin', 'Yording', 'Eli', 'McKnight'],
};

async function calendarMatch(recordedAt) {
  const t = Date.parse(recordedAt);
  if (!t) return null;
  const matches = [];
  for (const loc of LOCATIONS) {
    const calId = SPS_CALENDARS[loc.name];
    if (!calId) continue;
    try {
      const { events } = await getCalendarEvents(loc.token, loc.locationId, calId, t - MATCH_WINDOW_MS, t + MATCH_WINDOW_MS);
      for (const e of events || []) {
        matches.push({
          location: loc.name,
          gapMs: Math.abs(Date.parse(e.startTime) - t),
          title: e.title,
          contact: (e.title || '').replace(/\s*-\s*Starting Point.*$/i, '').trim() || null,
          assignedUserId: e.assignedUserId || null,
          contactId: e.contactId || null,
        });
      }
    } catch (err) {
      console.warn(`calendar query failed for ${loc.name}: ${err.message.slice(0, 120)}`);
    }
  }
  if (!matches.length) return null;
  matches.sort((a, b) => a.gapMs - b.gapMs);
  const locations = new Set(matches.map((m) => m.location));
  // Unambiguous only if all candidate events in the window are at one studio,
  // or the closest event is >45 min closer than the closest at the other studio.
  if (locations.size === 1) return { ...matches[0], ambiguous: false };
  const [best, ...rest] = matches;
  const otherBest = rest.find((m) => m.location !== best.location);
  if (otherBest && otherBest.gapMs - best.gapMs > 45 * 60_000) return { ...best, ambiguous: false };
  return { ...best, ambiguous: true };
}

function deviceHint(name) {
  for (const [needle, loc] of Object.entries(DEVICE_HINTS)) {
    if (name.toLowerCase().includes(needle.toLowerCase())) return loc;
  }
  return null;
}

function staffScan(text) {
  const head = text.slice(0, 4000);
  for (const [loc, names] of Object.entries(STAFF_BY_LOCATION)) {
    if (names.some((n) => new RegExp(`\\b${n}\\b`, 'i').test(head))) return loc;
  }
  return null;
}

// Plaud filenames commonly carry a timestamp; try several patterns, else file createdTime.
function parseRecordedAt(name, created) {
  let m = name.match(/(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})[\sT_-]+(\d{2})[:._]?(\d{2})/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] + 5, +m[5])).toISOString(); // assume CT ≈ UTC-5
  m = name.match(/(\d{4})[\s/-](\d{1,2})[\s/-](\d{1,2})/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 17)).toISOString();
  return created || null;
}

// ---- probe mode ----
const probeIdx = process.argv.indexOf('--probe');
if (probeIdx !== -1) {
  const when = process.argv[probeIdx + 1];
  const match = await calendarMatch(when);
  console.log('probe', when, '→', JSON.stringify(match, null, 1));
  process.exit(0);
}

// ---- sweep mode ----
if (!FOLDER) {
  console.log('PLAUD_FOLDER_ID not set — Plaud intake idle (set it once the folder exists).');
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
    let location = deviceHint(doc.name);
    let how = location ? 'device-hint' : null;
    let contact = null;
    let match = null;
    if (!location) {
      match = await calendarMatch(recordedAt);
      if (match && !match.ambiguous) {
        location = match.location;
        contact = match.contact;
        how = 'calendar';
      }
    }
    if (!location) {
      location = staffScan(doc.text);
      how = location ? 'staff-scan' : null;
    }
    if (!location) {
      location = 'Unknown';
      how = 'UNRESOLVED — review';
    }
    const loc = LOCATIONS.find((l) => l.name === location);
    upsertCall(db, {
      kind: 'sps',
      id: `drive_${doc.id}`,
      conversation_id: 'plaud',
      contact_id: match?.contactId || null,
      contact_name: contact,
      location_id: loc?.locationId || null,
      location_name: location,
      direction: null,
      staff: location === 'Lincolnshire' ? 'Colin Yording' : location === 'Schaumburg' ? 'Christian Simanonis' : null,
      started_at: recordedAt,
      duration_sec: null,
      recording_url: null,
      transcript: doc.text.trim(),
      transcript_source: 'plaud',
    });
    console.log(`  imported ${doc.name} → ${location} (${how})${contact ? ` | prospect: ${contact}` : ''}`);
  }
}
console.log('PLAUD SWEEP DONE');
