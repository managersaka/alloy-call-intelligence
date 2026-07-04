// Bridge client — POSTs to the "Alloy Call Intelligence Bridge" Apps Script
// web app (Alloy account), which writes the Call Quality tab and sends
// coaching-report emails via MailApp. Secret-gated; see bridge/ in repo root.
import 'dotenv/config';

const URL = process.env.BRIDGE_URL;
const SECRET = process.env.BRIDGE_SECRET;

export const bridgeEnabled = () => Boolean(URL && SECRET);

export async function bridge(action, payload = {}) {
  if (!bridgeEnabled()) throw new Error('bridge not configured (BRIDGE_URL/BRIDGE_SECRET)');
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, secret: SECRET, ...payload }),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`bridge non-json response (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!data.ok) throw new Error(`bridge ${action} failed: ${data.error}`);
  return data;
}
