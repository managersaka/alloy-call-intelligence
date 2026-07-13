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
    if (body.action === 'listFolder') return json_(listFolder_(body));
    if (body.action === 'getDocs') return json_(getDocs_(body));
    if (body.action === 'moveFile') return json_(moveFile_(body));
    if (body.action === 'ensureSiblingFolder') return json_(ensureSiblingFolder_(body));
    if (body.action === 'appendIndexRows') return json_(appendIndexRows_(body));
    if (body.action === 'setupPlaudLinks') return json_(setupPlaudLinks());
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

// ---- Drive read-only export (for the transcript backfill) ----
// Native DriveApp/DocumentApp — the Drive REST API 403s from default-GCP scripts.

function listFolder_(body) {
  if (!body.folderId) return { ok: false, error: 'no folderId' };
  var folder = DriveApp.getFolderById(body.folderId);
  var items = [];
  var folders = folder.getFolders();
  while (folders.hasNext()) {
    var f = folders.next();
    items.push({ id: f.getId(), name: f.getName(), mimeType: 'application/vnd.google-apps.folder' });
  }
  var files = folder.getFiles();
  while (files.hasNext()) {
    var file = files.next();
    items.push({ id: file.getId(), name: file.getName(), mimeType: file.getMimeType(), createdTime: file.getDateCreated().toISOString() });
  }
  return { ok: true, items: items };
}

function getDocs_(body) {
  var ids = body.ids || [];
  if (ids.length > 15) return { ok: false, error: 'max 15 ids per call' };
  var docs = [];
  for (var i = 0; i < ids.length; i++) {
    try {
      var file = DriveApp.getFileById(ids[i]);
      if (file.getMimeType() !== 'application/vnd.google-apps.document') {
        docs.push({ id: ids[i], name: file.getName(), error: 'not a google doc: ' + file.getMimeType() });
        continue;
      }
      var text = DocumentApp.openById(ids[i]).getBody().getText();
      docs.push({ id: ids[i], name: file.getName(), created: file.getDateCreated().toISOString(), text: text });
    } catch (err) {
      docs.push({ id: ids[i], error: String(err) });
    }
  }
  return { ok: true, docs: docs };
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
    if (body.patterns && body.patterns.length) {
      rows.push([]);
      rows.push(['RECURRING FAILURE PATTERNS — last 4 weeks vs the 4 weeks before (rising or persistent = coach on it)']);
      rows.push(['Team member', 'Pattern', 'Last 4w', 'Prior 4w', 'Trend']);
      body.patterns.forEach(function (p) {
        rows.push([p.caller, p.pattern, p.now, p.prior, p.trend]);
      });
    }
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
  // Branding (Prashant 2026-07-12): assistant-facing artifacts are "Prime".
  // PRIME_FROM (Script Property) is a Gmail send-as alias, e.g. prime@alloytraining.com;
  // requires the alias to exist on the deploying account AND the mail.google.com scope
  // (Phase 2). Until then MailApp sends from the account with the Prime display name.
  var props = PropertiesService.getScriptProperties();
  var replyTo = props.getProperty('PRIME_REPLY_TO') || 'p.singri@alloypersonaltraining.com';
  var opts = {
    to: body.to,
    cc: body.cc || '',
    subject: body.subject || 'Your call review',
    htmlBody: body.html || ('<pre style="font-family:inherit;white-space:pre-wrap">' + (body.text || '') + '</pre>'),
    name: 'Prime Call Coach',
    replyTo: replyTo,
  };
  var from = props.getProperty('PRIME_FROM');
  if (from && typeof GmailApp !== 'undefined') {
    try {
      if (GmailApp.getAliases().indexOf(from) !== -1) {
        GmailApp.sendEmail(body.to, opts.subject, body.text || '', {
          cc: opts.cc, htmlBody: opts.htmlBody, name: opts.name, replyTo: replyTo, from: from,
        });
        return { ok: true, sentTo: body.to, cc: opts.cc, from: from };
      }
    } catch (e) { /* alias/scope not ready — fall through to MailApp */ }
  }
  MailApp.sendEmail(opts);
  return { ok: true, sentTo: body.to, cc: opts.cc };
}

// Central "Analysis Index" spreadsheet — one row per scored call/SPS, with a
// link to the full report on the dashboard. Find-or-create next to the Plaud
// folder (i.e. inside "Transcripts and Evals"); id cached in Script Properties.
var INDEX_HEADER = ['Date', 'Studio', 'Team Member', 'Contact', 'Type', 'Score', 'Clarity', 'Booked', 'Coaching Priority', 'Summary', 'Full Report'];

function indexSheet_() {
  // The sheet lives wherever Prashant files it (currently the EOS Tracking
  // Spreadsheets shared location) — open by cached id (move-proof), else find
  // by name ANYWHERE in Drive; only create as a last resort.
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('INDEX_SHEET_ID');
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch (e) { /* fall through */ }
  }
  var existing = DriveApp.searchFiles("title contains 'Alloy Call Intelligence' and title contains 'Analysis Index' and trashed = false");
  var ss;
  if (existing.hasNext()) {
    ss = SpreadsheetApp.openById(existing.next().getId());
  } else {
    ss = SpreadsheetApp.create('Alloy Call Intelligence — Analysis Index');
    var sh = ss.getSheets()[0];
    sh.setName('Analyses');
    sh.getRange(1, 1, 1, INDEX_HEADER.length).setValues([INDEX_HEADER]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  props.setProperty('INDEX_SHEET_ID', ss.getId());
  return ss;
}

function appendIndexRows_(body) {
  var rows = body.rows || [];
  if (!rows.length) return { ok: true, appended: 0 };
  var ss = indexSheet_();
  var sh = ss.getSheetByName('Analyses') || ss.getSheets()[0];
  var start = sh.getLastRow() + 1;
  var grid = rows.map(function (r) {
    return [r.date, r.studio, r.teamMember, r.contact, r.type, r.score, r.clarity, r.booked ? 'yes' : '', r.coachingPriority, r.summary,
      r.reportUrl ? '=HYPERLINK("' + r.reportUrl + '","open report")' : ''];
  });
  sh.getRange(start, 1, grid.length, INDEX_HEADER.length).setValues(grid);
  // newest first is nicer to scroll: sort by date desc (skip header)
  if (sh.getLastRow() > 2) sh.getRange(2, 1, sh.getLastRow() - 1, INDEX_HEADER.length).sort({ column: 1, ascending: false });
  return { ok: true, appended: grid.length, spreadsheetUrl: ss.getUrl() };
}

// Move a file into a folder (used to file non-studio Plaud recordings).
function moveFile_(body) {
  var file = DriveApp.getFileById(body.fileId);
  file.moveTo(DriveApp.getFolderById(body.toFolderId));
  return { ok: true, moved: file.getName() };
}

// Find-or-create a folder next to a known folder (same parent). Returns its id.
function ensureSiblingFolder_(body) {
  var sibling = DriveApp.getFolderById(body.siblingFolderId);
  var parents = sibling.getParents();
  if (!parents.hasNext()) return { ok: false, error: 'sibling has no parent' };
  var parent = parents.next();
  var existing = parent.getFoldersByName(body.name);
  if (existing.hasNext()) return { ok: true, folderId: existing.next().getId(), created: false };
  return { ok: true, folderId: parent.createFolder(body.name).getId(), created: true };
}

// ---- Plaud Links: paste a share link, it processes instantly (onEdit trigger) ----
var PLAUD_WEBHOOK_URL = 'https://alloy-members.duckdns.org/webhook/plaud';

// Installable onEdit trigger. Fires on any edit; acts only on the "Plaud Links"
// tab, column A, when a Plaud share link is pasted → POSTs it to the droplet.
// Columns: A = Member name (optional), B = Plaud link (trigger), C = Status.
// Filling left-to-right puts the member name in before the link is pasted, so
// there's no race — the link paste fires this and reads the name already in A.
function onPlaudLinkEdit(e) {
  try {
    var sh = e.range.getSheet();
    if (sh.getName() !== 'Plaud Links') return;
    if (e.range.getColumn() !== 2 || e.range.getRow() < 2) return; // trigger on the LINK column (B)
    var row = e.range.getRow();
    var link = String(e.value || e.range.getValue() || '').trim();
    var member = String(sh.getRange(row, 1).getValue() || '').trim(); // member name (col A), optional
    var status = sh.getRange(row, 3); // status in col C
    if (!/web\.plaud\.ai\/s\/pub_/.test(link)) { if (link) status.setValue('not a Plaud share link'); return; }
    var sec = PropertiesService.getScriptProperties().getProperty('WEBHOOK_SECRET');
    if (!sec) { status.setValue('⚠️ WEBHOOK_SECRET not set'); return; }
    status.setValue('⏳ sending…');
    var resp = UrlFetchApp.fetch(PLAUD_WEBHOOK_URL + '?secret=' + encodeURIComponent(sec), {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ link: link, member: member }), muteHttpExceptions: true,
    });
    status.setValue(resp.getResponseCode() === 200
      ? '✅ processing — report in a few minutes'
      : '⚠️ error ' + resp.getResponseCode());
  } catch (err) {
    try { e.range.getSheet().getRange(e.range.getRow(), 3).setValue('⚠️ ' + err); } catch (e2) {}
  }
}

// One-time: create the "Plaud Links" tab in the Analysis Index sheet + install
// the onEdit trigger. Run once from the editor.
function setupPlaudLinks() {
  var ss = indexSheet_();
  var sh = ss.getSheetByName('Plaud Links') || ss.insertSheet('Plaud Links', 0);
  // (Re)apply the 3-column layout every run so it's safe to call idempotently.
  sh.getRange(1, 1, 1, 3).setValues([[
    'Member name (optional — leave blank if the coach states it in the recording)',
    'Paste Plaud share link (with audio) — pasting here starts processing',
    'Status',
  ]]).setFontWeight('bold');
  sh.setColumnWidth(1, 260);
  sh.setColumnWidth(2, 500);
  sh.setColumnWidth(3, 280);
  sh.setFrozenRows(1);
  var have = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'onPlaudLinkEdit'; });
  if (!have) ScriptApp.newTrigger('onPlaudLinkEdit').forSpreadsheet(ss).onEdit().create();
  Logger.log('Plaud Links ready: ' + ss.getUrl() + ' (Member | Link | Status); trigger installed: ' + !have);
  return { ok: true, url: ss.getUrl(), triggerAlreadyInstalled: have };
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
