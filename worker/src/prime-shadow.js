// Prime lead-responder — SHADOW MODE. Polls GHL conversations for recent
// inbound TEXT messages, decides lead vs member, and has Prime DRAFT a reply
// from the studio knowledgebase. NOTHING IS EVER SENT — drafts land in the
// prime_shadow table and go out in a daily digest (prime-digest.js) next to
// what staff actually replied, so the drafts can be graded against reality.
// Run: node src/prime-shadow.js   (cron every 15 min, flock'd)
import 'dotenv/config';
import { openDb, claim, cleanStaleClaims } from './db.js';
import { searchConversations, getMessages, getContact, searchOpportunities } from './ghl.js';
import { draftLeadReply } from './claude.js';

const LOCATIONS = JSON.parse(process.env.GHL_LOCATIONS_JSON || '[]');
const LOOKBACK_H = Number(process.env.PRIME_LOOKBACK_H || 24);
const CONVO_LIMIT = Number(process.env.PRIME_CONVERSATIONS || 40);
const MAX_DRAFTS_PER_RUN = Number(process.env.PRIME_MAX_DRAFTS || 25);
// Text-ish channels a lead actually converses on. Email is excluded (drip noise).
const TEXT_TYPES = new Set(['TYPE_SMS', 'TYPE_FACEBOOK', 'TYPE_INSTAGRAM', 'TYPE_WEBCHAT', 'TYPE_LIVE_CHAT', 'TYPE_GMB']);

const db = openDb();
db.exec(`CREATE TABLE IF NOT EXISTS prime_shadow (
  id TEXT PRIMARY KEY,
  conversation_id TEXT, location_name TEXT, contact_id TEXT, contact_name TEXT,
  inbound_at TEXT, inbound_text TEXT, channel TEXT,
  is_lead INTEGER, member_check TEXT,
  action TEXT, draft TEXT, reason TEXT, escalation TEXT,
  actual_reply TEXT, actual_by TEXT, actual_at TEXT,
  digested INTEGER DEFAULT 0, created TEXT DEFAULT (datetime('now'))
)`);

const isText = (m) => TEXT_TYPES.has(m.messageType || m.type) && (m.body || '').trim();

// Lead vs member: a won opportunity or a member-ish tag means member.
async function leadCheck(loc, contactId) {
  try {
    const c = await getContact(loc.token, contactId);
    const tags = (c?.contact?.tags || []).map((t) => String(t).toLowerCase());
    if (tags.some((t) => /(^|\s|-)member(s)?($|\s|-)|won|active client/.test(t))) return { lead: 0, how: 'tag' };
    const opp = await searchOpportunities(loc.token, loc.locationId, contactId);
    const opps = opp?.opportunities || [];
    if (opps.some((o) => String(o.status).toLowerCase() === 'won')) return { lead: 0, how: 'won_opp' };
    return { lead: 1, how: opps.length ? 'open_opp' : 'no_opp' };
  } catch (e) {
    return { lead: 1, how: `check_failed: ${e.message.slice(0, 80)}` }; // shadow-safe: treat as lead
  }
}

function renderContext(list, uptoMs, contactName) {
  // Only messages at/before the inbound being answered — Prime must not see
  // the staff reply that may already exist (that's the comparison, not input).
  return list
    .filter((m) => isText(m) && new Date(m.dateAdded).getTime() <= uptoMs)
    .sort((a, b) => new Date(a.dateAdded) - new Date(b.dateAdded))
    .slice(-25)
    .map((m) => `${m.direction === 'inbound' ? (contactName || 'LEAD') : 'STUDIO'} (${m.dateAdded}): ${m.body.trim()}`)
    .join('\n');
}

export async function shadowOnce() {
  cleanStaleClaims(db);
  const cutoffMs = Date.now() - LOOKBACK_H * 3600_000;
  let drafted = 0;
  for (const loc of LOCATIONS) {
    try {
      const conv = await searchConversations(loc.token, loc.locationId, { limit: CONVO_LIMIT });
      for (const c of conv?.conversations || []) {
        if ((c.lastMessageDate || 0) < cutoffMs) continue;
        if (drafted >= MAX_DRAFTS_PER_RUN) break;
        const msgs = await getMessages(loc.token, c.id);
        const list = msgs?.messages?.messages || msgs?.messages || [];
        // Latest inbound text within the lookback window is "the message to answer".
        const inbound = list
          .filter((m) => m.direction === 'inbound' && isText(m) && new Date(m.dateAdded).getTime() >= cutoffMs)
          .sort((a, b) => new Date(b.dateAdded) - new Date(a.dateAdded))[0];
        if (!inbound) continue;
        const exists = db.prepare('SELECT 1 FROM prime_shadow WHERE id = ?').get(inbound.id);
        if (exists || !claim(db, `prime:${inbound.id}`)) continue;

        const contactName = c.fullName || c.contactName || null;
        const base = {
          id: inbound.id, conversation_id: c.id, location_name: loc.name,
          contact_id: c.contactId || null, contact_name: contactName,
          inbound_at: inbound.dateAdded, inbound_text: inbound.body.trim().slice(0, 2000),
          channel: inbound.messageType || inbound.type,
        };
        const who = await leadCheck(loc, c.contactId);
        if (!who.lead) {
          db.prepare(`INSERT OR IGNORE INTO prime_shadow (id, conversation_id, location_name, contact_id, contact_name,
              inbound_at, inbound_text, channel, is_lead, member_check, action)
            VALUES (:id, :conversation_id, :location_name, :contact_id, :contact_name,
              :inbound_at, :inbound_text, :channel, 0, :how, 'skipped_member')`).run({ ...base, how: who.how });
          continue;
        }
        try {
          const inboundMs = new Date(inbound.dateAdded).getTime();
          const context = renderContext(list, inboundMs, contactName);
          const out = await draftLeadReply(
            { location: loc.name, contact: contactName, channel: base.channel, now: new Date().toISOString() },
            context,
          );
          db.prepare(`INSERT OR IGNORE INTO prime_shadow (id, conversation_id, location_name, contact_id, contact_name,
              inbound_at, inbound_text, channel, is_lead, member_check, action, draft, reason, escalation)
            VALUES (:id, :conversation_id, :location_name, :contact_id, :contact_name,
              :inbound_at, :inbound_text, :channel, 1, :how, :action, :draft, :reason, :escalation)`).run({
            ...base, how: who.how,
            action: out.action || 'reply', draft: out.draft || null,
            reason: out.reason || null, escalation: out.escalation || null,
          });
          drafted++;
          console.log(`prime-shadow: drafted ${out.action} for ${contactName || base.contact_id} (${loc.name})`);
        } catch (e) {
          // Release so the next run retries this message.
          db.prepare('DELETE FROM claims WHERE key = ?').run(`prime:${inbound.id}`);
          console.error(`prime-shadow: draft failed for ${inbound.id}: ${e.message}`);
        }
      }
    } catch (e) {
      console.error(`prime-shadow: poll error for ${loc.name}: ${e.message}`);
    }
  }
  console.log(`prime-shadow: run complete, ${drafted} draft(s)`);
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop());
if (isMain) shadowOnce().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
