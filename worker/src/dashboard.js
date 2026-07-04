// Read-only dashboard at GET /call-intel — served behind Caddy basic auth.
// Server-rendered from SQLite on each load; no client JS beyond <details>.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const MIN_EVAL_SEC = Number(process.env.MIN_EVAL_SEC || 180);
const MIN_N = Number(process.env.MIN_N || 5);

export function registerDashboard(app, db) {
  app.get('/call-intel', (req, res) => {
    try {
      res.type('html').send(render(db));
    } catch (e) {
      res.status(500).type('text').send(`dashboard error: ${e.message}`);
    }
  });
}

function render(db) {
  const week = db.prepare(`
    SELECT COUNT(*) total,
           SUM(classification = 'sales') sales,
           SUM(classification = 'REVIEW') review,
           SUM(clarity_outcome = 'fog') fog,
           SUM(clarity_outcome = 'booked') booked
    FROM calls WHERE started_at >= datetime('now', '-7 days')`).get();
  const scoredWeek = db.prepare(`
    SELECT COUNT(*) n FROM call_scores s JOIN calls c ON c.id = s.call_id
    WHERE c.started_at >= datetime('now', '-7 days') AND s.call_type != 'misrouted'`).get();

  const rubric4w = db.prepare(`
    SELECT s.caller, s.call_type, COUNT(*) n, ROUND(AVG(s.weighted_total), 1) avg,
           ROUND(AVG(s.booked), 2) booked_rate
    FROM call_scores s JOIN calls c ON c.id = s.call_id
    WHERE c.started_at >= datetime('now', '-28 days') AND s.call_type != 'misrouted'
      AND (c.duration_sec IS NULL OR c.duration_sec >= ${MIN_EVAL_SEC})
    GROUP BY s.caller, s.call_type ORDER BY n DESC`).all();

  const clarity4w = db.prepare(`
    SELECT staff caller, COUNT(*) n,
           ROUND(AVG(clarity_outcome = 'fog'), 2) fog_rate,
           ROUND(AVG(clarity_outcome = 'booked'), 2) booked_rate
    FROM calls
    WHERE classification = 'sales' AND clarity_outcome IS NOT NULL
      AND started_at >= datetime('now', '-28 days')
    GROUP BY staff ORDER BY n DESC`).all();

  const recent = db.prepare(`
    SELECT c.started_at, c.duration_sec, c.location_name, c.contact_name,
           s.caller, s.call_type, s.weighted_total, s.clarity_outcome, s.booked,
           s.shareable_summary, s.coaching_priority, s.private_report
    FROM call_scores s JOIN calls c ON c.id = s.call_id
    WHERE s.call_type != 'misrouted'
    ORDER BY c.started_at DESC LIMIT 25`).all();

  const reviewQueue = db.prepare(`
    SELECT started_at, location_name, contact_name, staff, duration_sec, summary
    FROM calls WHERE classification = 'REVIEW' AND started_at >= datetime('now', '-14 days')
    ORDER BY started_at DESC LIMIT 15`).all();

  const tile = (label, value, sub = '') => `
    <div class="tile"><div class="tile-v">${value}</div><div class="tile-l">${label}</div>${sub ? `<div class="tile-s">${sub}</div>` : ''}</div>`;

  const fogRate = week.sales ? week.fog / week.sales : null;

  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Alloy Call Intelligence</title>
<link href="https://fonts.googleapis.com/css2?family=Saira+Semi+Condensed:wght@600;700&family=Barlow:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root { --lime:#E1E000; --black:#2C2A29; --silver:#A6A8AC; }
  * { box-sizing: border-box; margin: 0; }
  body { font-family: Barlow, sans-serif; background: #f4f4f2; color: var(--black); padding: 0 0 40px; }
  header { background: var(--black); color: #fff; padding: 18px 28px; display: flex; align-items: baseline; gap: 14px; }
  header h1 { font-family: 'Saira Semi Condensed', sans-serif; text-transform: uppercase; font-size: 22px; letter-spacing: 1px; }
  header h1 span { color: var(--lime); }
  header .sub { color: var(--silver); font-size: 13px; }
  main { max-width: 1100px; margin: 0 auto; padding: 24px 20px; }
  h2 { font-family: 'Saira Semi Condensed', sans-serif; text-transform: uppercase; font-size: 16px; letter-spacing: .5px; margin: 28px 0 10px; border-left: 4px solid var(--lime); padding-left: 10px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
  .tile { background: #fff; border-radius: 8px; padding: 14px 16px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .tile-v { font-family: 'Saira Semi Condensed', sans-serif; font-size: 30px; font-weight: 700; }
  .tile-l { color: var(--silver); font-size: 12px; text-transform: uppercase; letter-spacing: .5px; margin-top: 2px; }
  .tile-s { font-size: 12px; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.08); font-size: 14px; }
  th { background: var(--black); color: #fff; text-align: left; padding: 8px 12px; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .5px; }
  td { padding: 8px 12px; border-top: 1px solid #eee; vertical-align: top; }
  .low-n { color: var(--silver); }
  .fog { color: #c0392b; font-weight: 600; }
  .booked { color: #1e8e3e; font-weight: 600; }
  details { margin-top: 6px; }
  summary { cursor: pointer; color: #555; font-size: 13px; }
  pre { white-space: pre-wrap; font-family: Barlow, sans-serif; font-size: 13px; background: #fafaf8; border: 1px solid #eee; border-radius: 6px; padding: 12px; margin-top: 8px; }
  .note { color: var(--silver); font-size: 12px; margin-top: 6px; }
</style></head><body>
<header><h1>Alloy <span>Call Intelligence</span></h1><div class="sub">generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC · read-only</div></header>
<main>
<h2>Last 7 days</h2>
<div class="tiles">
  ${tile('Calls', week.total ?? 0)}
  ${tile('Sales calls', week.sales ?? 0)}
  ${tile('Rubric-scored', scoredWeek.n ?? 0)}
  ${tile('Booked', week.booked ?? 0)}
  ${tile('Fog rate (sales)', pct(fogRate))}
  ${tile('Needs review', week.review ?? 0)}
</div>

<h2>Rubric score — rolling 4 weeks (graded conversations ≥ ${MIN_EVAL_SEC / 60} min)</h2>
<table><tr><th>Caller</th><th>Type</th><th>n</th><th>Avg score</th><th>Booked rate</th></tr>
${rubric4w.map((r) => `<tr${r.n < MIN_N ? ' class="low-n"' : ''}><td>${esc(r.caller)}</td><td>${esc(r.call_type)}</td><td>${r.n}${r.n < MIN_N ? ` (min ${MIN_N})` : ''}</td><td>${r.n < MIN_N ? '—' : r.avg}</td><td>${pct(r.booked_rate)}</td></tr>`).join('') || '<tr><td colspan="5">No graded calls in window</td></tr>'}
</table>
<div class="note">Below min-n=${MIN_N} the average is withheld (grey rows show counts only). QC and SPS never blend.</div>

<h2>Clarity — rolling 4 weeks (ALL sales calls incl. short dials)</h2>
<table><tr><th>Caller</th><th>n</th><th>Fog rate</th><th>Booked rate</th></tr>
${clarity4w.map((r) => `<tr${r.n < MIN_N ? ' class="low-n"' : ''}><td>${esc(r.caller)}</td><td>${r.n}</td><td class="${r.fog_rate >= 0.5 ? 'fog' : ''}">${pct(r.fog_rate)}</td><td>${pct(r.booked_rate)}</td></tr>`).join('') || '<tr><td colspan="4">No sales calls in window</td></tr>'}
</table>
<div class="note">Fog = call ended with no booking, no named objection, no dated follow-up. The standard applies to every sales call regardless of length.</div>

<h2>Recent scored calls</h2>
<table><tr><th>When</th><th>Caller</th><th>Contact</th><th>Studio</th><th>Type</th><th>Score</th><th>Clarity</th><th>Summary</th></tr>
${recent.map((r) => `<tr>
  <td>${esc((r.started_at || '').slice(0, 16).replace('T', ' '))}<br><span class="note">${r.duration_sec ? Math.round(r.duration_sec / 60) + ' min' : ''}</span></td>
  <td>${esc(r.caller)}</td><td>${esc(r.contact_name)}</td><td>${esc(r.location_name)}</td>
  <td>${esc(r.call_type)}</td><td><b>${r.weighted_total ?? '—'}</b></td>
  <td class="${r.clarity_outcome === 'fog' ? 'fog' : r.clarity_outcome === 'booked' ? 'booked' : ''}">${esc(r.clarity_outcome)}</td>
  <td>${esc(r.shareable_summary)}<details><summary>coaching priority + private report</summary><b>${esc(r.coaching_priority)}</b><pre>${esc(r.private_report)}</pre></details></td>
</tr>`).join('')}
</table>

<h2>Review queue — low-confidence classifications (14 days)</h2>
<table><tr><th>When</th><th>Studio</th><th>Contact</th><th>Staff</th><th>Length</th><th>Classifier summary</th></tr>
${reviewQueue.map((r) => `<tr><td>${esc((r.started_at || '').slice(0, 16).replace('T', ' '))}</td><td>${esc(r.location_name)}</td><td>${esc(r.contact_name)}</td><td>${esc(r.staff)}</td><td>${r.duration_sec ?? '—'}s</td><td>${esc(r.summary)}</td></tr>`).join('') || '<tr><td colspan="6">Empty</td></tr>'}
</table>
</main></body></html>`;
}
