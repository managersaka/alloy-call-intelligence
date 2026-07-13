// Prime shadow digest — daily email (via the bridge, sender "Prime Call Coach")
// showing each inbound lead text, Prime's draft, and what staff ACTUALLY sent,
// side by side. Marks rows digested. Run: node src/prime-digest.js (cron 7:10a CT).
import 'dotenv/config';
import { openDb } from './db.js';
import { getMessages } from './ghl.js';
import { bridge, bridgeEnabled } from './bridge.js';

const LOCATIONS = JSON.parse(process.env.GHL_LOCATIONS_JSON || '[]');
const locByName = Object.fromEntries(LOCATIONS.map((l) => [l.name, l]));
const USERS = JSON.parse(process.env.GHL_USERS_JSON || '{}');
const TO = process.env.PRIME_DIGEST_TO || process.env.REPORT_FALLBACK_EMAIL;
const TEXT_TYPES = new Set(['TYPE_SMS', 'TYPE_FACEBOOK', 'TYPE_INSTAGRAM', 'TYPE_WEBCHAT', 'TYPE_LIVE_CHAT', 'TYPE_GMB']);

const db = openDb();
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');

// The staff's actual reply = first outbound text after the inbound timestamp.
async function fetchActual(row) {
  const loc = locByName[row.location_name];
  if (!loc) return null;
  try {
    const msgs = await getMessages(loc.token, row.conversation_id);
    const list = msgs?.messages?.messages || msgs?.messages || [];
    const t0 = new Date(row.inbound_at).getTime();
    const reply = list
      .filter((m) => m.direction === 'outbound' && TEXT_TYPES.has(m.messageType || m.type) && (m.body || '').trim())
      .filter((m) => new Date(m.dateAdded).getTime() > t0)
      .sort((a, b) => new Date(a.dateAdded) - new Date(b.dateAdded))[0];
    if (!reply) return null;
    return { text: reply.body.trim().slice(0, 2000), by: USERS[reply.userId] || null, at: reply.dateAdded };
  } catch { return null; }
}

async function run() {
  // Rows older than 2h so staff have had a chance to answer; everything undigested.
  const rows = db.prepare(`
    SELECT * FROM prime_shadow
    WHERE digested = 0 AND inbound_at <= datetime('now', '-2 hours')
    ORDER BY location_name, inbound_at
  `).all();
  if (!rows.length) { console.log('prime-digest: nothing to send'); return; }

  const drafts = rows.filter((r) => r.action !== 'skipped_member');
  for (const r of drafts) {
    const actual = await fetchActual(r);
    if (actual) {
      db.prepare('UPDATE prime_shadow SET actual_reply=?, actual_by=?, actual_at=? WHERE id=?')
        .run(actual.text, actual.by, actual.at, r.id);
      Object.assign(r, { actual_reply: actual.text, actual_by: actual.by, actual_at: actual.at });
    }
  }

  const n = { reply: 0, escalate: 0, stay_silent: 0, skipped_member: 0 };
  rows.forEach((r) => { n[r.action] = (n[r.action] || 0) + 1; });

  const blocks = drafts.map((r) => `
    <div style="border:1px solid #ddd;border-radius:8px;padding:12px;margin:12px 0">
      <div style="color:#666;font-size:12px">${esc(r.location_name)} · ${esc(r.contact_name || r.contact_id)} · ${esc(r.inbound_at)} · ${esc(r.channel)} · lead-check: ${esc(r.member_check)}</div>
      <div style="margin:8px 0"><b>Lead:</b> ${esc(r.inbound_text)}</div>
      <div style="margin:8px 0;padding:8px;background:#eef7ee;border-radius:6px"><b>Prime (${esc(r.action)}${r.escalation ? ' → ' + esc(r.escalation) : ''}):</b> ${esc(r.draft || '—')}<br><span style="color:#666;font-size:12px">${esc(r.reason || '')}</span></div>
      <div style="margin:8px 0;padding:8px;background:#eef2f7;border-radius:6px"><b>Staff actually sent${r.actual_by ? ' (' + esc(r.actual_by) + ')' : ''}:</b> ${r.actual_reply ? esc(r.actual_reply) : '<i>(no reply yet)</i>'}</div>
    </div>`).join('');

  const today = new Date().toISOString().slice(0, 10);
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:720px">
      <h2>Prime shadow digest — ${today}</h2>
      <p>${drafts.length} lead message(s) drafted (${n.reply || 0} reply · ${n.escalate || 0} escalate · ${n.stay_silent || 0} stay-silent) · ${n.skipped_member || 0} member message(s) skipped.<br>
      Nothing was sent to anyone — these are drafts vs what staff actually sent.</p>
      ${blocks}
    </div>`;

  if (!bridgeEnabled() || !TO) { console.error('prime-digest: bridge or PRIME_DIGEST_TO not configured'); return; }
  await bridge('report', { to: TO, subject: `Prime shadow digest — ${today} (${drafts.length} drafts)`, html });
  const mark = db.prepare('UPDATE prime_shadow SET digested = 1 WHERE id = ?');
  rows.forEach((r) => mark.run(r.id));
  console.log(`prime-digest: sent ${drafts.length} drafts to ${TO}`);
}

run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
