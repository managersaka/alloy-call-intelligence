// List GHL users per location (id, name, email) — for the staff email map.
import 'dotenv/config';

const LOCATIONS = JSON.parse(process.env.GHL_LOCATIONS_JSON || '[]');
for (const loc of LOCATIONS) {
  try {
    const res = await fetch(`https://services.leadconnectorhq.com/users/?locationId=${loc.locationId}`, {
      headers: { Authorization: `Bearer ${loc.token}`, Version: '2021-07-28', Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 150)}`);
    const data = await res.json();
    console.log(`=== ${loc.name}`);
    for (const u of data.users || []) console.log(`${u.id} | ${u.name || (u.firstName + ' ' + u.lastName)} | ${u.email}`);
  } catch (e) {
    console.error(`${loc.name} FAILED: ${e.message}`);
  }
}
