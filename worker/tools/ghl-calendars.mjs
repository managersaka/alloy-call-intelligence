// Probe GHL calendars per location — find the SPS calendars + sample events.
// Used by the Plaud location-matcher (recording time ↔ scheduled SPS).
import 'dotenv/config';

const LOCATIONS = JSON.parse(process.env.GHL_LOCATIONS_JSON || '[]');
const BASE = 'https://services.leadconnectorhq.com';

async function ghl(token, path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Version: '2021-04-15', Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

for (const loc of LOCATIONS) {
  console.log(`\n=== ${loc.name}`);
  try {
    const { calendars } = await ghl(loc.token, `/calendars/?locationId=${loc.locationId}`);
    for (const c of calendars || []) console.log(`  cal: ${c.name} (${c.id})${/sps|starting/i.test(c.name) ? '  <-- SPS?' : ''}`);
    // sample: events in the last 14 days on calendars that look SPS-ish
    const spsCals = (calendars || []).filter((c) => /sps|starting|consult|assessment/i.test(c.name));
    const start = Date.now() - 14 * 86400_000;
    const end = Date.now() + 7 * 86400_000;
    for (const c of spsCals) {
      const { events } = await ghl(loc.token, `/calendars/events?locationId=${loc.locationId}&calendarId=${c.id}&startTime=${start}&endTime=${end}`);
      console.log(`  events on "${c.name}": ${(events || []).length}`);
      for (const e of (events || []).slice(0, 3)) console.log(`    ${e.startTime} | ${e.title} | contact ${e.contactId?.slice(0, 8)} | user ${e.assignedUserId?.slice(0, 8)}`);
    }
  } catch (e) {
    console.error(`  FAILED: ${e.message}`);
  }
}
