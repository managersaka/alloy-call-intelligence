// One-time authorization trigger — run this once in the editor to grant scopes.
// Kept as the ONLY function in this file so the editor Run picker is reliable.
function authorize() {
  var ss = SpreadsheetApp.openById('1vvfcTeVv4KQHNS9xJXtRz68jzrT1i0Q8dyiOEM3QsV0');
  Logger.log('sheet ok: ' + ss.getName());
  Logger.log('mail quota: ' + MailApp.getRemainingDailyQuota());
}
