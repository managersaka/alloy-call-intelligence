// One-time authorization trigger — run this once in the editor to grant scopes.
// Kept as the ONLY function in this file so the editor Run picker is reliable.
function authorize() {
  var ss = SpreadsheetApp.openById('1vvfcTeVv4KQHNS9xJXtRz68jzrT1i0Q8dyiOEM3QsV0');
  Logger.log('sheet ok: ' + ss.getName());
  Logger.log('mail quota: ' + MailApp.getRemainingDailyQuota());
  var folder = DriveApp.getFolderById('1s6OjmVyeuh5bYO649gMQ0a4tdu5HU_19');
  Logger.log('drive ok: ' + folder.getName());
  var doc = DocumentApp.openById('1llreoo1j-EnwH0htBmpysGoHAX6FPw8-epuypMsbHus');
  Logger.log('docs ok: ' + doc.getName() + ' (' + doc.getBody().getText().length + ' chars)');
}
