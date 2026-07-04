// GHL (LeadConnector) API client — Private Integration Token auth.
// NOTE: Verify endpoint paths against https://marketplace.gohighlevel.com/docs
// before first run — the transcription endpoints are newer and paths may shift.
// Known-good doc pages as of 2026-07:
//   - "Get transcription by Message ID"      (conversations/get-message-transcription)
//   - "Download transcription by Message ID"  (conversations/download-message-transcription)
//   - Messages by conversation, filter TYPE_CALL, then fetch recording by message id.

import 'dotenv/config';

const BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-04-15'; // conversations API version header

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Version: VERSION,
    Accept: 'application/json',
  };
}

async function ghlFetch(path, token, opts = {}) {
  const res = await fetch(`${BASE}${path}`, { ...opts, headers: { ...headers(token), ...(opts.headers || {}) } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GHL ${res.status} ${path}: ${body.slice(0, 300)}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res.text();
}

/** Search conversations updated since a timestamp for one location. */
export async function searchConversations(token, locationId, { limit = 100 } = {}) {
  const q = new URLSearchParams({ locationId, limit: String(limit), sortBy: 'last_message_date', sort: 'desc' });
  return ghlFetch(`/conversations/search?${q}`, token);
}

/** All messages in a conversation; caller filters for TYPE_CALL. */
export async function getMessages(token, conversationId, { limit = 100 } = {}) {
  const q = new URLSearchParams({ limit: String(limit) });
  return ghlFetch(`/conversations/${conversationId}/messages?${q}`, token);
}

/** Native transcription for a call message (requires Voice Intelligence enabled). */
export async function getTranscription(token, locationId, messageId) {
  // TODO(verify): confirm exact path in marketplace docs before production.
  return ghlFetch(`/conversations/locations/${locationId}/messages/${messageId}/transcription`, token);
}

/** Recording audio (fallback path for Whisper). Returns ArrayBuffer. */
export async function getRecording(token, locationId, messageId) {
  const res = await fetch(`${BASE}/conversations/messages/${messageId}/locations/${locationId}/recording`, {
    headers: headers(token),
  });
  if (!res.ok) throw new Error(`GHL recording ${res.status} for message ${messageId}`);
  return res.arrayBuffer();
}

export function isCallMessage(msg) {
  return msg?.messageType === 'TYPE_CALL' || msg?.type === 'TYPE_CALL';
}
