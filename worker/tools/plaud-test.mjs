// Validate the Plaud share-link pipeline end to end on one link.
// node tools/plaud-test.mjs "<share link>"
import 'dotenv/config';
import { rmSync } from 'node:fs';
import { fetchPlaudShare } from '../src/plaud.js';
import { prosodyFromTranscription } from '../src/tone.js';
import { deliveryReadFromFile, deliverySummary } from '../src/audio.js';

const link = process.argv[2];
if (!link) { console.log('usage: plaud-test.mjs "<link>"'); process.exit(1); }

const t0 = Date.now();
const s = await fetchPlaudShare(link);
console.log('=== share ===');
console.log({ id: s.id, studio: s.studio, owner: s.owner, member: s.member, filename: s.filename, date: s.date, duration_sec: s.duration_sec, transcriptChars: s.transcript.length, sentences: s.sentences.length, audio: s.audioPath ? 'downloaded' : 'none' });
console.log('first trans element:', s._debugFirstTrans);
console.log('transcript head:', s.transcript.slice(0, 300).replace(/\n/g, ' | '));

// Tier A prosody from the plaud sentences
const prosody = prosodyFromTranscription(s.sentences);
console.log('=== Tier A prosody ===', prosody ? prosody.summary : 'n/a (no timestamps in trans_result)');

// Tier B delivery read on the audio
if (s.audioPath) {
  const read = await deliveryReadFromFile(s.audioPath, { call_type: 'sps' });
  console.log('=== Tier B delivery read ===');
  console.log(deliverySummary(read));
  rmSync(s.audioPath, { force: true });
}
console.log(`total ${Math.round((Date.now() - t0) / 1000)}s`);
