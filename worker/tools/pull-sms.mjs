// Pull ALL text-ish conversation messages (SMS/FB/IG/GMB/chat/email bodies) for both
// Alloy locations into JSONL archives. Run from /opt/alloy-call-intelligence/worker.
// v2: persistent output dir (survives reboot), fetch timeouts, resume via .done files.
import 'dotenv/config';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';

const BASE = 'https://services.leadconnectorhq.com';
const VERSION = '2021-04-15';
const OUTDIR = '/opt/alloy-call-intelligence/worker/data/sms-archive';
mkdirSync(OUTDIR, { recursive: true });
const LOCS = JSON.parse(process.env.GHL_LOCATIONS_JSON); // [{locationId, name, token}]

const KEEP = new Set(['TYPE_SMS', 'TYPE_FACEBOOK', 'TYPE_INSTAGRAM', 'TYPE_GMB', 'TYPE_LIVE_CHAT', 'TYPE_WEBCHAT', 'TYPE_WHATSAPP', 'TYPE_EMAIL']);

let reqCount = 0;
async function ghl(path, token) {
  reqCount++;
  if (reqCount % 80 === 0) await new Promise(r => setTimeout(r, 10000)); // ~100 req/10s limit
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(`${BASE}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Version: VERSION, Accept: 'application/json' },
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 429) { await new Promise(r => setTimeout(r, 11000)); continue; }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`GHL ${res.status} ${path}: ${body.slice(0, 150)}`);
      }
      return res.json();
    } catch (e) {
      if (attempt === 5) throw e;
      if (String(e).includes('GHL 5') || e.name === 'TimeoutError' || e.name === 'AbortError' || String(e).includes('fetch failed')) {
        await new Promise(r => setTimeout(r, 5000 * attempt));
        continue;
      }
      throw e;
    }
  }
}

async function* allConversations(token, locationId) {
  let startAfterDate;
  let seen = 0;
  while (true) {
    const q = new URLSearchParams({ locationId, limit: '100', sortBy: 'last_message_date', sort: 'desc' });
    if (startAfterDate) q.set('startAfterDate', String(startAfterDate));
    const data = await ghl(`/conversations/search?${q}`, token);
    const convs = data.conversations || [];
    if (seen === 0 && convs.length) console.log(`${locationId}: total conversations reported = ${data.total}`);
    if (!convs.length) return;
    for (const c of convs) yield c;
    seen += convs.length;
    const last = convs[convs.length - 1];
    const next = last.lastMessageDate || last.dateUpdated || last.dateAdded;
    if (!next || next === startAfterDate) return;
    startAfterDate = next;
    if (seen >= (data.total || Infinity)) return;
  }
}

async function* allMessages(token, conversationId) {
  let lastMessageId;
  while (true) {
    const q = new URLSearchParams({ limit: '100' });
    if (lastMessageId) q.set('lastMessageId', lastMessageId);
    const data = await ghl(`/conversations/${conversationId}/messages?${q}`, token);
    const box = data.messages || data;
    const msgs = Array.isArray(box) ? box : (box.messages || []);
    if (!msgs.length) return;
    for (const m of msgs) yield m;
    const nextPage = Array.isArray(box) ? false : box.nextPage;
    lastMessageId = Array.isArray(box) ? undefined : box.lastMessageId;
    if (!nextPage || !lastMessageId) return;
  }
}

for (const loc of LOCS) {
  const locName = loc.name;
  const token = loc.token;
  if (!token) { console.error(`no token for ${locName}`); continue; }
  const out = `${OUTDIR}/sms-archive-${locName.toLowerCase()}.jsonl`;
  const doneFile = `${OUTDIR}/sms-archive-${locName.toLowerCase()}.done`;
  const done = new Set(existsSync(doneFile) ? readFileSync(doneFile, 'utf8').split('\n').filter(Boolean) : []);
  console.log(`${locName}: resuming with ${done.size} conversations already archived`);
  let nConv = 0, nMsg = 0, nSkip = 0, t0 = Date.now();
  for await (const c of allConversations(token, loc.locationId)) {
    if (done.has(c.id)) { nSkip++; continue; }
    nConv++;
    let buf = [];
    try {
      for await (const m of allMessages(token, c.id)) {
        const type = m.messageType || m.type;
        if (!KEEP.has(type)) continue;
        const body = (m.body || '').trim();
        if (!body) continue;
        buf.push({
          loc: locName, convId: c.id, contactId: c.contactId,
          contact: c.fullName || c.contactName || null,
          msgId: m.id, type, direction: m.direction,
          date: m.dateAdded, body: body.slice(0, 4000),
          userId: m.userId || null, source: m.source || null, status: m.status || null,
        });
      }
    } catch (e) { console.error(`conv ${c.id}: ${e.message}`); continue; } // not marked done -> retried next run
    if (buf.length) { appendFileSync(out, buf.map(r => JSON.stringify(r)).join('\n') + '\n'); nMsg += buf.length; }
    appendFileSync(doneFile, c.id + '\n');
    done.add(c.id);
    if (nConv % 200 === 0) console.log(`${locName}: ${nConv} new convs (+${nSkip} skipped), ${nMsg} msgs, ${Math.round((Date.now() - t0) / 1000)}s`);
  }
  console.log(`DONE ${locName}: ${nConv} new conversations (+${nSkip} already done), ${nMsg} new messages -> ${out}`);
}
console.log('ALL DONE');
