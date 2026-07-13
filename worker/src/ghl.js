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

/** Search conversations for one location, most recent first; optionally one contact's. */
export async function searchConversations(token, locationId, { limit = 100, contactId } = {}) {
  const q = new URLSearchParams({ locationId, limit: String(limit), sortBy: 'last_message_date', sort: 'desc' });
  if (contactId) q.set('contactId', contactId);
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

/** Calendar events in a time window (epoch ms) — used to match Plaud recordings to scheduled SPS. */
export async function getCalendarEvents(token, locationId, calendarId, startMs, endMs) {
  const q = new URLSearchParams({ locationId, calendarId, startTime: String(startMs), endTime: String(endMs) });
  return ghlFetch(`/calendars/events?${q}`, token);
}

export function isCallMessage(msg) {
  return msg?.messageType === 'TYPE_CALL' || msg?.type === 'TYPE_CALL';
}

// --- Prime lead-responder additions (contacts + opportunities use a newer API version) ---

export async function getContact(token, contactId) {
  return ghlFetch(`/contacts/${contactId}`, token, { headers: { Version: '2021-07-28' } });
}

/** Opportunities for one contact — used to tell leads (no won opp) from members. */
export async function searchOpportunities(token, locationId, contactId) {
  const q = new URLSearchParams({ location_id: locationId, contact_id: contactId, limit: '20' });
  return ghlFetch(`/opportunities/search?${q}`, token, { headers: { Version: '2021-07-28' } });
}
