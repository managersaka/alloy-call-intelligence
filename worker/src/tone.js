// Tier A tone/delivery signals for PHONE calls, derived from GHL's structured
// transcription (speaker-labeled, timestamped sentences). No audio needed —
// mono 8kHz recordings can't be channel-split, but the transcript timing gives
// talk-ratio, pace, pauses, and interruptions, which is what the rubrics measure.
// Tier B (actual vocal warmth/emotion via an audio model) is separate.
import { getTranscription } from './ghl.js';

const num = (x) => (typeof x === 'number' ? x : parseFloat(x));

// Accepts the raw transcription payload (array of sentence objects) and returns
// prosody metrics, or null if it isn't timestamped/speaker-labeled.
export function prosodyFromTranscription(raw) {
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.transcriptions) ? raw.transcriptions : null;
  if (!arr || arr.length < 3) return null;
  const sents = arr
    .map((s) => ({
      ch: s.mediaChannel ?? s.channel ?? s.speaker ?? 0,
      start: num(s.startTime),
      end: num(s.endTime),
      words: String(s.transcript ?? s.text ?? '').trim().split(/\s+/).filter(Boolean).length,
    }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start);
  if (sents.length < 3) return null;

  sents.sort((a, b) => a.start - b.start);
  const byCh = {};
  let words = 0;
  let speech = 0;
  for (const s of sents) {
    (byCh[s.ch] ||= { talk: 0, words: 0 });
    byCh[s.ch].talk += s.end - s.start;
    byCh[s.ch].words += s.words;
    words += s.words;
    speech += s.end - s.start;
  }
  const channels = Object.keys(byCh);
  const totalTalk = channels.reduce((a, c) => a + byCh[c].talk, 0) || 1;
  const talkRatio = channels
    .map((c) => ({ channel: Number(c), pct: Math.round((byCh[c].talk / totalTalk) * 100) }))
    .sort((a, b) => b.pct - a.pct);

  // pauses (gaps on the shared timeline) + interruptions (a sentence starting
  // before the previous, different-channel sentence ended)
  let longestPause = 0;
  let pausesOver3 = 0;
  let interruptions = 0;
  for (let i = 1; i < sents.length; i++) {
    const gap = sents[i].start - sents[i - 1].end;
    if (gap > 0) {
      longestPause = Math.max(longestPause, gap);
      if (gap >= 3) pausesOver3++;
    } else if (gap < -0.4 && sents[i].ch !== sents[i - 1].ch) {
      interruptions++;
    }
  }
  const paceWpm = speech > 0 ? Math.round(words / (speech / 60)) : null;

  return {
    talk_ratio: talkRatio, // e.g. [{channel:2,pct:61},{channel:1,pct:39}]
    pace_wpm: paceWpm,
    longest_pause_s: Math.round(longestPause * 10) / 10,
    pauses_over_3s: pausesOver3,
    interruptions,
    summary:
      `talk split ${talkRatio.map((t) => `ch${t.channel} ${t.pct}%`).join(' / ')}; ` +
      `pace ~${paceWpm} wpm; longest pause ${Math.round(longestPause)}s; ` +
      `${pausesOver3} pauses ≥3s; ${interruptions} interruptions ` +
      `(one speaker cutting the other off). Map channels to coach/member from the transcript; ` +
      `use this for the talk-ratio, pacing, and "used silence" judgments.`,
  };
}

// For a ghl_native call: re-fetch the structured transcription and compute
// prosody. Cheap (GHL calls are free) and works on history while GHL retains it.
export async function phoneTone(loc, call) {
  if (call.transcript_source !== 'ghl_native' || !loc) return null;
  try {
    const raw = await getTranscription(loc.token, loc.locationId, call.id);
    return prosodyFromTranscription(raw);
  } catch {
    return null; // transcription expired/unavailable — degrade to text-only scoring
  }
}
