// Lightweight Markdown → email-safe HTML for the coaching reports. No deps —
// email clients strip <style>, so everything is inline. Handles only the
// constructs the rubric reports actually emit: #/##/### headings, **bold**,
// *italic*, `code`, - / N. lists, > blockquotes, --- rules, and pipe tables.

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Inline spans. Escape first, then insert our own (trusted) tags.
function inline(s) {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/`([^`]+)`/g, '<code style="background:#f0f0f0;padding:1px 4px;border-radius:3px;font-size:90%">$1</code>');
}

const isTableSep = (line) => /-/.test(line) && /^\s*\|?[\s:|-]+\|?\s*$/.test(line);
const rowCells = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());

function tableHtml(rows) {
  const head = rowCells(rows[0]);
  let h = '<table style="border-collapse:collapse;width:100%;margin:10px 0;font-size:14px">';
  h += '<thead><tr>' + head.map((c) => `<th style="border:1px solid #ddd;padding:6px 10px;background:#f5f5f5;text-align:left">${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
  for (const r of rows.slice(1)) {
    h += '<tr>' + rowCells(r).map((c) => `<td style="border:1px solid #ddd;padding:6px 10px">${inline(c)}</td>`).join('') + '</tr>';
  }
  return h + '</tbody></table>';
}

const isStructural = (l, next) =>
  /^\s*(#{1,6}\s|[-*]\s|\d+\.\s|>\s?)/.test(l) ||
  /^\s*([-*_])\1{2,}\s*$/.test(l) ||
  (l.includes('|') && next != null && isTableSep(next));

export function mdToHtml(md) {
  const lines = String(md || '').replace(/\r/g, '').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // table: a piped line followed by a separator row
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const tbl = [line];
      i += 2; // header + separator
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) tbl.push(lines[i++]);
      out.push(tableHtml(tbl));
      continue;
    }
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      const lvl = m[1].length;
      const size = lvl <= 1 ? 20 : lvl === 2 ? 17 : 15;
      out.push(`<div style="font-size:${size}px;font-weight:700;color:${lvl <= 2 ? '#1a1a1a' : '#333'};margin:16px 0 6px">${inline(m[2])}</div>`);
      i++; continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { out.push('<hr style="border:none;border-top:1px solid #e0e0e0;margin:14px 0">'); i++; continue; }
    if (/^\s*>\s?/.test(line)) {
      const q = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote style="border-left:3px solid #c0c0c0;margin:10px 0;padding:6px 12px;color:#444;background:#fafafa">${q.map(inline).join('<br>')}</blockquote>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ''));
      out.push('<ul style="margin:6px 0;padding-left:22px">' + items.map((t) => `<li style="margin:3px 0;line-height:1.5">${inline(t)}</li>`).join('') + '</ul>');
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+\.\s+/, ''));
      out.push('<ol style="margin:6px 0;padding-left:22px">' + items.map((t) => `<li style="margin:3px 0;line-height:1.5">${inline(t)}</li>`).join('') + '</ol>');
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !isStructural(lines[i], lines[i + 1])) para.push(lines[i++]);
    out.push(`<p style="margin:8px 0;line-height:1.5">${para.map(inline).join('<br>')}</p>`);
  }
  return out.join('\n');
}

// Full styled report body: a score/priority header card + the rendered report.
export function reportEmailHtml(meta) {
  const scoreColor = meta.score >= 70 ? '#1a7f37' : meta.score >= 50 ? '#b7791f' : '#c0392b';
  const chip = (label, val) => (val ? `<span style="display:inline-block;margin:0 14px 4px 0;font-size:13px;color:#555"><strong style="color:#222">${esc(label)}:</strong> ${esc(val)}</span>` : '');
  return (
    `<div style="font-family:${FONT};max-width:720px;margin:0 auto;color:#222;font-size:14px">` +
      `<div style="border:1px solid #e5e5e5;border-radius:8px;padding:14px 16px;background:#fbfbfb;margin-bottom:14px">` +
        `<div style="font-size:22px;font-weight:700;margin-bottom:8px">${esc(meta.score)}<span style="font-size:14px;color:#888">/100</span> <span style="font-size:13px;color:${scoreColor};font-weight:600">${esc(meta.callType || '')}${meta.clarity ? ' &middot; ' + esc(meta.clarity) : ''}</span></div>` +
        chip('Caller', meta.caller) + chip('Studio', meta.studio) + chip('Contact', meta.contact) + chip('When', meta.when) + chip('Length', meta.lengthMin) +
        (meta.coachingPriority ? `<div style="margin-top:10px;padding:8px 10px;background:#fff8e1;border-left:3px solid #f5b301;font-size:14px"><strong>Coaching priority:</strong> ${esc(meta.coachingPriority)}</div>` : '') +
        `<div style="margin-top:10px;font-size:12px;color:#999">Private to you. The team scorecard only sees scores and the shareable summary.</div>` +
      `</div>` +
      mdToHtml(meta.reportMarkdown) +
    `</div>`
  );
}
