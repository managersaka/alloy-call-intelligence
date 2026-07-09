// Plaud share-link intake. ONE public share link is fully self-contained:
// transcript (data_file.trans_result), audio (presigned S3 via /audio), title,
// duration, owner. The API is token-only (public share) — no login, no browser.
// Confirmed endpoints (2026-07-09):
//   GET api.plaud.ai/share/access/<token>        -> { data_file:{filename,duration,start_time,
//                                                      trans_result[],outline_result[],...}, owner_name, is_audio }
//   GET api.plaud.ai/share/access/<token>/audio  -> { status, temp_url }  (S3 presigned, 1h)
import 'dotenv/config';
import { writeFileSync } from 'node:fs';

const API = 'https://api.plaud.ai/share/access';
const OWNERS = JSON.parse(process.env.PLAUD_OWNERS_JSON || '{}'); // owner_name -> 'Schaumburg'|'Lincolnshire'

export function parsePlaudToken(link) {
  const s = String(link || '');
  const m = s.match(/\/s\/(pub_[^/?#\s]+)/) || s.match(/(pub_[A-Za-z0-9_.:\-]+)/);
  return m ? m[1] : null;
}

// The public share API 403s bare server requests — it expects the web-app's
// Origin/Referer + a browser UA. These are all it checks (no cookie/login).
const BROWSER_HEADERS = {
  accept: 'application/json, text/plain, */*',
  origin: 'https://web.plaud.ai',
  referer: 'https://web.plaud.ai/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
};

async function pget(url) {
  const r = await fetch(url, { headers: BROWSER_HEADERS });
  if (!r.ok) throw new Error(`plaud ${r.status} ${url.slice(-46)}`);
  return r.json();
}

// Plaud trans_result[] -> flat labeled transcript + timestamped sentences in the
// shape prosodyFromTranscription() expects ({mediaChannel,startTime,endTime,transcript}).
// Plaud times are MILLISECONDS -> convert to seconds. Element (2026-07-09):
//   {content, speaker:"Colin"|"Speaker 1", start_time:32360, end_time:37340}
function normalizeTrans(arr) {
  if (!Array.isArray(arr)) return { text: '', sentences: [] };
  const sentences = [];
  let text = '';
  for (const s of arr) {
    const content = String(s.content ?? s.text ?? s.transcript ?? s.sentence ?? s.asr_text ?? '').trim();
    if (!content) continue;
    const startMs = Number(s.start_time ?? s.startTime ?? s.start ?? s.begin_time ?? s.bg ?? s.s);
    const endMs = Number(s.end_time ?? s.endTime ?? s.end ?? s.ed ?? s.e);
    const spk = s.speaker ?? s.original_speaker ?? s.role ?? s.speaker_id ?? s.spk ?? 0;
    text += `${spk}: ${content}\n`;
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
      sentences.push({ mediaChannel: spk, startTime: startMs / 1000, endTime: endMs / 1000, transcript: content });
    }
  }
  return { text: text.trim(), sentences };
}

function studioFor(owner, transcriptText) {
  if (owner && OWNERS[owner]) return OWNERS[owner];
  const head = (transcriptText || '').slice(0, 5000);
  if (/\bchristian\b/i.test(head)) return 'Schaumburg';
  if (/\bcolin\b|\beli\b/i.test(head)) return 'Lincolnshire';
  return 'Unknown';
}

function parseMemberDate(filename) {
  const name = String(filename || '');
  let date = null;
  const dm = name.match(/(\d{1,2})[-/](\d{1,2})(?:[-/](\d{2,4}))?/);
  if (dm) {
    const y = dm[3] ? (dm[3].length === 2 ? 2000 + Number(dm[3]) : Number(dm[3])) : 2026;
    date = new Date(Date.UTC(y, Number(dm[1]) - 1, Number(dm[2]), 17)).toISOString();
  }
  const member = name.replace(/^[\d\s./:-]+/, '').replace(/^.*?(consultation|session|deep dive|sps)[:\s-]*/i, '').trim().slice(0, 80) || null;
  return { date, member };
}

// Fetch everything for a share link. Returns call fields + fresh audio path
// (temp_url expires in 1h, download immediately) + raw first trans element (debug).
export async function fetchPlaudShare(link) {
  const token = parsePlaudToken(link);
  if (!token) throw new Error('no plaud share token in link');
  const share = await pget(`${API}/${token}`);
  const df = share.data_file || {};
  const { text, sentences } = normalizeTrans(df.trans_result);
  if (!text || text.length < 200) throw new Error('share has no usable transcript (transcribed + shared with transcript?)');
  const owner = share.owner_name || '';
  const studio = studioFor(owner, text);
  const { date, member } = parseMemberDate(df.filename);

  let audioPath = null;
  if (share.is_audio) {
    try {
      const a = await pget(`${API}/${token}/audio`);
      if (a.temp_url) {
        const buf = await (await fetch(a.temp_url)).arrayBuffer();
        audioPath = `/tmp/plaud-${token.split('::')[0]}.ogg`;
        writeFileSync(audioPath, Buffer.from(buf));
      }
    } catch (e) {
      console.warn(`plaud audio fetch failed: ${e.message.slice(0, 120)}`);
    }
  }

  return {
    id: `plaud_${token.split('::')[0]}`,
    kind: 'sps',
    owner,
    studio,
    member,
    filename: df.filename,
    date,
    duration_sec: df.duration ? Math.round(df.duration / 1000) : null, // Plaud duration is ms
    transcript: text,
    sentences,
    audioPath,
    _debugFirstTrans: JSON.stringify((df.trans_result || [])[0] || {}).slice(0, 220),
  };
}
