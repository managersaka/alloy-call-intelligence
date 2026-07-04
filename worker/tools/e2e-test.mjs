// One-call end-to-end: real GHL transcript â†’ normalize â†’ classify (cli mode).
import 'dotenv/config';
import { getTranscription } from '../src/ghl.js';
import { classifyCall } from '../src/claude.js';

const LOCATIONS = JSON.parse(process.env.GHL_LOCATIONS_JSON || '[]');
const loc = LOCATIONS.find((l) => l.name === 'Lincolnshire');
const MSG_ID = process.argv[2] || 'o8TLtGPlXKt697FpJ6H6';

// mirror of index.js normalizeTranscript
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

const raw = await getTranscription(loc.token, loc.locationId, MSG_ID);
const transcript = normalizeTranscript(raw);
console.log(`normalized transcript: ${transcript.length} chars, ${transcript.split('\n').length} lines`);
const t0 = Date.now();
const r = await classifyCall(transcript);
console.log(`classified in ${((Date.now() - t0) / 1000).toFixed(1)}s:`);
console.log(JSON.stringify(r, null, 2));
