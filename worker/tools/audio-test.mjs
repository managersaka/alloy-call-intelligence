import 'dotenv/config';
import { DatabaseSync } from 'node:sqlite';
import { phoneDeliveryRead } from '../src/audio.js';

const db = new DatabaseSync(process.env.DB_PATH || './data/calls.db');
const L = JSON.parse(process.env.GHL_LOCATIONS_JSON);
const by = Object.fromEntries(L.map((l) => [l.locationId, l]));
const c = db.prepare(`SELECT * FROM calls WHERE transcript_source='ghl_native' AND duration_sec BETWEEN 300 AND 600 AND classification='sales' ORDER BY started_at DESC LIMIT 1`).get();
console.log('call:', c.id, c.classification, c.duration_sec + 's', c.location_name);
const t0 = Date.now();
const r = await phoneDeliveryRead(by[c.location_id], c);
console.log('elapsed', Math.round((Date.now() - t0) / 1000) + 's');
console.log(JSON.stringify(r, null, 1));
