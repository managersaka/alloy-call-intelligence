// Live GHL validation: auth, conversation search, call messages, transcription.
// Run with cwd = worker/ so dotenv finds .env. Prints shapes + truncated samples only.
import 'dotenv/config';
import { searchConversations, getMessages, getTranscription, isCallMessage } from '../src/ghl.js';

const LOCATIONS = JSON.parse(process.env.GHL_LOCATIONS_JSON || '[]');
const USERS = JSON.parse(process.env.GHL_USERS_JSON || '{}');

for (const loc of LOCATIONS) {
  console.log(`\n=== ${loc.name} (${loc.locationId}) ===`);
  try {
    const conv = await searchConversations(loc.token, loc.locationId, { limit: 20 });
    const list = conv?.conversations || [];
    console.log(`conversations returned: ${list.length} (total: ${conv?.total ?? '?'})`);
    let callsFound = 0;
    let transcriptTried = false;
    for (const c of list) {
      if (callsFound >= 3 && transcriptTried) break;
      const msgs = await getMessages(loc.token, c.id);
      const mlist = msgs?.messages?.messages || msgs?.messages || [];
      const calls = mlist.filter(isCallMessage);
      for (const m of calls) {
        callsFound++;
        const dur = m.meta?.call?.duration ?? null;
        console.log(`  CALL msg ${m.id} | ${m.direction} | ${dur}s | ${m.dateAdded} | staff: ${USERS[m.userId] || m.userId || '(none)'} | contact: ${c.fullName || c.contactName || c.contactId}`);
        if (!transcriptTried && dur && dur >= 45) {
          transcriptTried = true;
          try {
            const t = await getTranscription(loc.token, loc.locationId, m.id);
            const shape = Array.isArray(t) ? `array[${t.length}]` : typeof t;
            const sample = Array.isArray(t)
              ? t.slice(0, 2).map((s) => JSON.stringify(s)).join('\n      ')
              : String(typeof t === 'string' ? t : JSON.stringify(t)).slice(0, 300);
            console.log(`    TRANSCRIPT OK â€” shape: ${shape}\n      ${sample.slice(0, 400)}`);
          } catch (e) {
            console.log(`    TRANSCRIPT FAILED: ${e.message.slice(0, 200)}`);
          }
        }
        if (callsFound >= 6) break;
      }
    }
    if (!callsFound) console.log('  no TYPE_CALL messages in the 20 most recent conversations');
  } catch (e) {
    console.error(`  LOCATION FAILED: ${e.message.slice(0, 300)}`);
  }
}
