// Probe: fetch one real GHL phone recording, inspect its format (channels/codec/
// duration) to decide the tone-extraction approach.
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { getRecording } from '../src/ghl.js';

const LOCATIONS = JSON.parse(process.env.GHL_LOCATIONS_JSON || '[]');
const locById = Object.fromEntries(LOCATIONS.map((l) => [l.location_id || l.locationId, l]));
const db = new DatabaseSync(process.env.DB_PATH || './data/calls.db');

// a recent phone call (sales or accountability) with real duration and a native transcript
const call = db.prepare(`
  SELECT id, location_id, duration_sec, classification FROM calls
  WHERE transcript_source = 'ghl_native' AND duration_sec >= 180
    AND classification IN ('sales','accountability')
  ORDER BY started_at DESC LIMIT 1`).get();
if (!call) { console.log('no candidate call'); process.exit(0); }
console.log('probing call', call.id, call.classification, call.duration_sec + 's', 'loc', call.location_id);

const loc = LOCATIONS.find((l) => l.locationId === call.location_id);
if (!loc) { console.log('no token for location', call.location_id); process.exit(1); }

try {
  const buf = await getRecording(loc.token, loc.locationId, call.id);
  const path = '/tmp/probe.audio';
  writeFileSync(path, Buffer.from(buf));
  console.log('downloaded bytes:', buf.byteLength);
  const info = execSync(`ffprobe -v error -show_entries stream=codec_name,channels,sample_rate,duration -show_entries format=format_name,duration -of default=nw=1 ${path}`).toString();
  console.log('--- ffprobe ---\n' + info);
  // per-channel loudness (if 2ch, tells us talk separation is viable)
  const vol = execSync(`ffmpeg -i ${path} -af "channelsplit,astats=metadata=1:reset=0" -f null - 2>&1 | grep -iE "channel:|RMS level|Number of samples" | head -12 || true`).toString();
  console.log('--- per-channel stats ---\n' + vol);
} catch (e) {
  console.error('recording fetch/probe failed:', e.message.slice(0, 250));
}
