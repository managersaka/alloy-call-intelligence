// Alloy Call Intelligence Bridge — web app endpoint for the droplet worker.
// Actions (POST JSON, secret-gated via Script Property BRIDGE_SECRET):
//   test   → liveness check
//   rollup → write the weekly Call Quality tab into both L10 sheets
//   report → email a private coaching report to the caller
// Deploy: Execute as me, access Anyone. Secret lives in Script Properties (not code).

var L10_SHEETS = {
  Schaumburg: '1vvfcTeVv4KQHNS9xJXtRz68jzrT1i0Q8dyiOEM3QsV0',
  Lincolnshire: '1Dn35yeFRDoSpp9sgE5rg2bhY6unjs4XrU9xGRgMLyVk',
};
var TAB_NAME = 'Call Quality';

function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad json' }); }
  var secret = PropertiesService.getScriptProperties().getProperty('BRIDGE_SECRET');
  if (!secret || body.secret !== secret) return json_({ ok: false, error: 'unauthorized' });
  try {
    if (body.action === 'test') return json_({ ok: true, pong: true });
    if (body.action === 'rollup') return json_(writeRollup_(body));
    if (body.action === 'report') return json_(sendReport_(body));
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

function writeRollup_(body) {
  var written = [];
  for (var loc in L10_SHEETS) {
    var ss = SpreadsheetApp.openById(L10_SHEETS[loc]);
    var sh = ss.getSheetByName(TAB_NAME) || ss.insertSheet(TAB_NAME);
    sh.clearContents();
    var rows = [];
    rows.push(['ALLOY CALL QUALITY — updated ' + (body.generatedAt || new Date().toISOString())]);
    rows.push([]);
    rows.push(['RUBRIC SCORE — rolling 4 weeks, graded conversations only (sales calls ≥3 min)']);
    rows.push(['Caller', 'Call type', 'n', 'Avg score', 'Booked rate', 'Scorecard']);
    (body.rolling || []).forEach(function (r) {
      rows.push([r.caller, r.call_type, r.n, r.avg || '', r.bookedRate || '', r.scorecard]);
    });
    rows.push([]);
    rows.push(['CLARITY — rolling 4 weeks, ALL sales calls (incl. short dials). Fog = ended with no booking, no named objection, no dated follow-up']);
    rows.push(['Caller', 'n', 'Fog rate', 'Booked rate', 'Scorecard']);
    (body.clarity || []).forEach(function (r) {
      rows.push([r.caller, r.n, r.fogRate, r.bookedRate, r.scorecard]);
    });
    rows.push([]);
    rows.push(['Notes: min-n=5 (below that the count shows, not a score). QC and SPS never blend. Baseline period: first 2 weeks are data-collection only.']);
    var width = 6;
    var grid = rows.map(function (r) { while (r.length < width) r.push(''); return r.slice(0, width); });
    sh.getRange(1, 1, grid.length, width).setValues(grid);
    sh.getRange(4, 1, 1, width).setFontWeight('bold');
    sh.getRange(4 + (body.rolling || []).length + 2, 1, 1, width).setFontWeight('bold');
    written.push(loc);
  }
  return { ok: true, written: written };
}

function sendReport_(body) {
  if (!body.to) return { ok: false, error: 'no recipient' };
  MailApp.sendEmail({
    to: body.to,
    subject: body.subject || 'Your call review',
    htmlBody: body.html || ('<pre style="font-family:inherit;white-space:pre-wrap">' + (body.text || '') + '</pre>'),
    name: 'Alloy Call Coach',
  });
  return { ok: true, sentTo: body.to };
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
