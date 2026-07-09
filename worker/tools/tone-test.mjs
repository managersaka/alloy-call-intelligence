import 'dotenv/config';
import { getTranscription } from '../src/ghl.js';
import { prosodyFromTranscription } from '../src/tone.js';

const LOCATIONS = JSON.parse(process.env.GHL_LOCATIONS_JSON || '[]');
const loc = LOCATIONS.find((l) => l.name === 'Lincolnshire');
const id = process.argv[2] || 'K1qizV6O0uMzhPVdqdXH';
const raw = await getTranscription(loc.token, loc.locationId, id);
console.log('sentences:', Array.isArray(raw) ? raw.length : typeof raw);
console.log('prosody:', JSON.stringify(prosodyFromTranscription(raw), null, 1));
