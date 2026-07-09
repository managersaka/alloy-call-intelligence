// Tier B — the vocal delivery read. Sends the actual audio to an audio-native
// model (Gemini) for what a transcript can't carry: warmth, energy, pace feel,
// confidence, authenticity (genuine vs performative), and use of silence.
// Output is folded into the `tone` metadata the Sonnet rubric already consumes.
//
// Cost note: this is the one deliberate exception to subscription-first — audio
// analysis genuinely needs an audio model. Gemini flash, ~pennies per call.
import 'dotenv/config';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { getRecording } from './ghl.js';

const KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_AUDIO_MODEL || 'gemini-2.5-flash';
const MAX_MP3_BYTES = 18 * 1024 * 1024; // inline-request ceiling

export const audioEnabled = () => Boolean(KEY);

const PROMPT = (callType) => `You are a delivery coach for a small-group personal training studio. You are listening to a recording of a ${callType || 'coaching'} conversation. The WORDS are analyzed separately — judge ONLY vocal delivery, the things a transcript loses.

Assess: warmth/rapport, energy, pace (rushed vs measured), confidence/authority, authenticity (genuine vs performative or scripted), and use of silence (did they let moments land or fill every gap). Pull 1-3 specific moments where TONE helped or hurt (paraphrase what was said + what the delivery did).

Respond ONLY with JSON:
{"warmth":"1-10 + short phrase","energy":"1-10 + short phrase","pace":"rushed|measured|slow + note","confidence":"1-10 + short phrase","authenticity":"genuine|mixed|performative + why","silence_use":"good|filled-every-gap|awkward + note","notable_moments":["..."],"summary":"2-3 sentences a coach can act on"}`;

// Core: given a local audio file path, return the structured delivery read.
export async function deliveryReadFromFile(path, meta = {}) {
  if (!audioEnabled()) return null;
  const mp3 = `${path}.mp3`;
  try {
    // shrink to a small mono mp3 — cheap to send, plenty for prosody/emotion.
    // 24kbps mono keeps even a ~90-min in-person SPS under the inline ceiling.
    execSync(`ffmpeg -y -i "${path}" -ac 1 -ar 16000 -b:a 24k "${mp3}" >/dev/null 2>&1`);
    const bytes = readFileSync(mp3);
    if (bytes.byteLength > MAX_MP3_BYTES) return { summary: `(audio ${Math.round(bytes.byteLength / 1e6)}MB too large for inline delivery read — skipped)` };
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: PROMPT(meta.call_type) }, { inline_data: { mime_type: 'audio/mpeg', data: bytes.toString('base64') } }] }],
        generationConfig: { temperature: 0.4, responseMimeType: 'application/json' },
      }),
    });
    if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
    let json;
    try { json = JSON.parse(text); } catch { return { summary: text.slice(0, 400) }; }
    return json;
  } catch (e) {
    // Tier B is an enhancement, never a gate — a Gemini rate-limit/quota (429) or
    // any audio failure must not abort scoring. Degrade to Tier A prosody only.
    console.warn(`tier-B delivery read skipped: ${String(e.message).slice(0, 160)}`);
    return null;
  } finally {
    try { rmSync(mp3); } catch {}
  }
}

// Compact one-liner for the rubric `tone` metadata (merged with Tier A stats).
export function deliverySummary(read) {
  if (!read) return null;
  if (read.summary && !read.warmth) return `Delivery (audio): ${read.summary}`;
  return `Delivery (audio) — warmth ${read.warmth}; energy ${read.energy}; pace ${read.pace}; confidence ${read.confidence}; authenticity ${read.authenticity}; silence ${read.silence_use}. ${read.summary || ''}`.trim();
}

// Phone: fetch the GHL recording (mono 8kHz wav), run the delivery read.
export async function phoneDeliveryRead(loc, call) {
  if (!audioEnabled() || call.transcript_source !== 'ghl_native' || !loc) return null;
  const tmp = `/tmp/aci-audio-${call.id}`;
  try {
    const buf = await getRecording(loc.token, loc.locationId, call.id);
    writeFileSync(tmp, Buffer.from(buf));
    return await deliveryReadFromFile(tmp, { call_type: call.classification });
  } catch (e) {
    console.warn(`delivery read failed for ${call.id}: ${e.message.slice(0, 120)}`);
    return null;
  } finally {
    try { rmSync(tmp); } catch {}
  }
}
