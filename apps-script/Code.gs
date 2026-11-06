/**
 * ReplyTrack — Google Apps Script web app
 *
 * The team web app. It lives in its own Apps Script project (script.google.com → New project),
 * and the team lead deploys it ONCE: "Execute as: User accessing the web app",
 * "Who has access: Anyone with Google account". Each request runs as the team member who sends
 * it (the extension sends their Google login) and opens THEIR sheet by the ID the extension
 * sends — so it can only ever touch sheets that person can edit anyway. If it finds it is NOT
 * running as the person calling it (deployed with "Execute as: Me" by mistake), it refuses
 * every request.
 *
 * Every request is a POST with a JSON body:
 *   { "sheet": "<spreadsheet id>", "tab": "MY LEADS", "action": "...", ... }
 *
 * Actions
 *   ping                                         → checks the tab, the columns, the dropdown, write access
 *   read                                         → every row, all columns (for {placeholders})
 *   markSent     { profileUrl, sentAt }          → Outreach Status "Sent" + Sent Date (the day of sentAt;
 *                                                  no sentAt → Sent Date left empty)
 *   markAccepted { profileUrl }                  → "Accepted but not replied" in Response / Notes
 *   addReplies   { profileUrl, replies, sentAt } → their messages in Response / Notes; "Sent" → "Replied"
 *   clearAdmin   { profileUrl, row, adminText, notesText }
 *                                                → after an Admin Reply was seen in the LinkedIn
 *                                                  conversation: clears Admin Reply and Response / Notes
 *   saveScraped  { columns, rows }               → the scraper's leads into the SCRAP tab (made if missing):
 *                                                  one row per person (by "key"), filled in as more is found
 *
 * Answer (JSON): { "ok": true, ... }  or  { "ok": false, "error": "..." }
 *   with "account": the Google account the request ran as.
 *   errors: "tab not found" | "missing column: <name>" | "profile not in tab" | "cell full"
 *         | "admin reply changed — not cleared" | "no \"Admin Reply\" column" | "bad request"
 *         | "busy, try again" | "error: ..." | "no sheet link" | "no sheets permission — ..."
 *         | "no access to sheet" | "no edit access to sheet: ..."
 *         | "not running as you — ..." (the deployment isn't "Execute as: User accessing the web app")
 *
 * Columns: LinkedIn Profile, Personalized Message and Outreach Status are required. Sent Date,
 * Response / Notes and Admin Reply are optional — without one, only what needs it is off.
 *
 * Safety rules — enforced here, whatever the extension asks:
 *   - Only these columns are ever written: Outreach Status, Sent Date, Response / Notes, and
 *     Admin Reply (only ever cleared, after a verified send). Every other column is read-only.
 *   - Outreach Status only ever gets "Sent" (from empty or "Not Started") or "Replied" (from "Sent"),
 *     and only if that value is in the cell's dropdown.
 *   - A cell with a formula is never written: it is skipped and logged. A column filled by one
 *     formula at the top (ARRAYFORMULA, IMPORTRANGE, QUERY, …) is never written at all.
 *   - Text in Response / Notes is never deleted or overwritten — new replies are added below it —
 *     except the exact text "Accepted but not replied", and the clear after a verified Admin Reply.
 *   - Clearing removes the contents only: formatting and dropdowns stay.
 *   - Columns are never added, removed or moved — except in the scraper's own SCRAP tab, which
 *     this script creates and keeps (its header row gets any new scraper column).
 *   - In SCRAP a value is only ever added or updated, never cleared, and a cell with a formula is
 *     left alone. Everything there is stored as plain text (a phone like +91… stays as typed).
 */

// ============================================================================
// SETTINGS
// ============================================================================

// The template's "Make a copy" link. The page team members see when they
// open the web app shows a "Make a copy of the sheet" button with it. '' = no button.
var TEMPLATE_COPY_URL = 'https://docs.google.com/spreadsheets/d/18kqx2r4G5340pEwYITB-Pd1Il6wJSw9xuYwxI5eyans/copy';

// Headers in ROW 1 of the tab. Matching ignores upper/lower case and extra spaces.
var COLUMNS = {
  profile: 'LinkedIn Profile',      // read — https://www.linkedin.com/in/... links      (required)
  message: 'Personalized Message',  // read — the connection note                      (required)
  status: 'Outreach Status',        // write — "Sent", "Replied" (a dropdown)          (required)
  sentDate: 'Sent Date',            // write                                           (optional)
  notes: 'Response / Notes',        // write                                           (optional)
  admin: 'Admin Reply',             // read — cleared only after a verified send       (optional)
};
var REQUIRED = ['profile', 'message', 'status'];
// The only columns this script may ever write to.
var WRITABLE = ['status', 'sentDate', 'notes', 'admin'];

var SENDABLE = ['', 'not started'];        // Outreach Status a connection request may be sent from
var SENT = 'Sent';
var REPLIED = 'Replied';
var ACCEPTED_TEXT = 'Accepted but not replied';

var DEFAULT_TIME_ZONE = 'Asia/Kolkata';   // used when the spreadsheet has no time zone set
var DATE_FORMAT = 'dd mmm yyyy';          // Sent Date, if the cell has no date format yet → 24 Oct 2026
var TIME_FORMAT = 'd MMM yyyy, h:mm a';   // reply times → 27 Oct 2026, 11:42 PM
var ENTRY_SEPARATOR = '\n\n';             // blank line between messages in one cell
var CELL_LIMIT = 50000;                   // Google Sheets maximum characters per cell
var LOCK_WAIT_MS = 30000;                 // how long a write waits for another one to finish

// "[27 Oct 2026, 11:42 PM] text" — one message in a Response / Notes cell.
var ENTRY_RE = /^\[(\d{1,2}) ([A-Za-z]{3,9})\.? (\d{4}), (\d{1,2}):(\d{2}) ?([AP])\.?M\.?\] ?([\s\S]*)$/i;
// Where the next message starts: a blank line followed by "[27 Oct 2026, 11:42 PM]".
var ENTRY_START_RE = /\n[ \t]*\n(?=\[\d{1,2} [A-Za-z]{3,9}\.? \d{4}, \d{1,2}:\d{2} ?[AP]\.?M\.?\])/i;
// A formula that fills a whole column from one cell. Writing below it would break it.
var SPILL_RE = /^=\s*(ARRAYFORMULA|IMPORTRANGE|QUERY|FILTER|SORTN?|UNIQUE|FLATTEN|MAP|BYROW|BYCOL|SEQUENCE|TRANSPOSE|IMPORTDATA|IMPORTHTML|IMPORTXML|IMPORTFEED)\s*\(/i;
// A Google Sheets id, as the extension sends it.
var SHEET_ID_RE = /^[A-Za-z0-9_-]{20,}$/;
// What Google says when this account may open a file but not change it.
var NO_EDIT_RE = /permission|not have access|edit access|access denied|read[- ]only/i;

// ----------------------------------------------------------------------------
// Who is calling?
// ----------------------------------------------------------------------------

// The Google account this request runs as — only when that is the person who
// sent it ("Execute as: User accessing the web app"). '' otherwise.
function teamUser_() {
  var me = '';
  var caller = '';
  try {
    me = Session.getEffectiveUser().getEmail() || '';
  } catch (err) {}
  try {
    caller = Session.getActiveUser().getEmail() || '';
  } catch (err) {}
  return me && caller && me.toLowerCase() === caller.toLowerCase() ? me : '';
}

var NOT_AS_YOU = 'not running as you — deploy the team web app with "Execute as: User accessing the web app"';

// Google's permission screen lets people leave "Google Sheets" unticked. Then nothing can be read
// or written, so the team web app says so instead of "no access to sheet".
var SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
var NO_SHEETS_PERMISSION = 'no sheets permission — tick "Google Sheets" on Google\'s permission screen';
var NO_SCOPE_RE = /required permissions|permissions are not sufficient|permission to call/i;

// '' when this person gave the Google Sheets permission; otherwise Google's link to give it
// ('missing' when Google has no link).
function sheetsPermissionMissing_() {
  try {
    var info = ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL, [SHEETS_SCOPE]);
    if (info.getAuthorizationStatus() === ScriptApp.AuthorizationStatus.REQUIRED) return info.getAuthorizationUrl() || 'missing';
  } catch (err) {}
  return '';
}

// ----------------------------------------------------------------------------
// Web app entry points
// ----------------------------------------------------------------------------

// Opening the web app URL in a browser: the page a team member sees after approving Google's
// permission screen.
function doGet() {
  var email = teamUser_();
  return connectedPage_(email, email ? sheetsPermissionMissing_() : '');
}

var ACTIONS = {
  ping: { run: ping_, write: false },
  read: { run: read_, write: false },
  markSent: { run: markSent_, write: true },
  markAccepted: { run: markAccepted_, write: true },
  addReplies: { run: addReplies_, write: true },
  clearAdmin: { run: clearAdmin_, write: true },
  saveScraped: { run: saveScraped_, write: true, ownTab: true },
};

function doPost(e) {
  var data;
  try {
    data = JSON.parse((e && e.postData && e.postData.contents) || '');
  } catch (err) {
    return out_({ ok: false, error: 'bad request' });
  }
  if (!data || typeof data !== 'object') return out_({ ok: false, error: 'bad request' });

  var account = teamUser_();
  if (!account) {
    console.warn('[ReplySync] Request rejected: %s', NOT_AS_YOU);
    return out_({ ok: false, error: NOT_AS_YOU });
  }
  var answer = function (obj) {
    obj.account = account;
    return out_(obj);
  };
  var action = ACTIONS[data.action];
  if (!action) return answer({ ok: false, error: 'bad request' });

  var id = String(data.sheet || '').trim();
  if (!SHEET_ID_RE.test(id)) return answer({ ok: false, error: 'no sheet link' });
  if (sheetsPermissionMissing_()) return answer({ ok: false, error: NO_SHEETS_PERMISSION });
  var ss;
  try {
    ss = SpreadsheetApp.openById(id);
  } catch (err) {
    var why = err && err.message ? err.message : String(err);
    console.warn('[ReplySync] %s could not open the sheet: %s', account, why);
    return answer({ ok: false, error: NO_SCOPE_RE.test(why) ? NO_SHEETS_PERMISSION : 'no access to sheet' });
  }

  // Writes one at a time per person (each has their own sheet), so a reply and a status
  // update can't collide.
  var lock = null;
  if (action.write) {
    lock = LockService.getUserLock();
    try {
      lock.waitLock(LOCK_WAIT_MS);
    } catch (err) {
      return answer({ ok: false, error: 'busy, try again' });
    }
  }
  try {
    var result;
    if (action.ownTab) {
      result = action.run(ss, data); // works in its own tab (SCRAP), not in MY LEADS
    } else {
      var ctx = open_(ss, data.tab);
      if (typeof ctx === 'string') return answer({ ok: false, error: ctx });
      result = action.run(ctx, data);
    }
    if (action.write) {
      SpreadsheetApp.flush();
      console.log('%s %s %s -> %s', prefix_(data.action), data.action, data.profileUrl || '', JSON.stringify(result));
    }
    return answer(result);
  } catch (err) {
    var msg = err && err.message ? err.message : String(err);
    console.error(prefix_(data.action) + ' ' + (err && err.stack ? err.stack : err));
    if (action.write && NO_EDIT_RE.test(msg)) return answer({ ok: false, error: 'no edit access to sheet: ' + msg });
    return answer({ ok: false, error: 'error: ' + msg });
  } finally {
    if (lock) lock.releaseLock();
  }
}

function prefix_(action) {
  return action === 'markSent' || action === 'markAccepted' ? '[Outreach]' : '[ReplySync]';
}

// ----------------------------------------------------------------------------
// The tab and its columns
// ----------------------------------------------------------------------------

// -> { sheet, headers, col (1-based column numbers; 0 = optional column not there), missing
//    (names of the optional columns not there), lastRow, tz, cache } or an error string.
function open_(ss, tabName) {
  var sheet = findTab_(ss, tabName);
  if (!sheet) return 'tab not found';
  var lastCol = sheet.getLastColumn();
  var headers = lastCol ? sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0] : [];
  var col = {};
  var missing = [];
  for (var k in COLUMNS) {
    var i = findColumn_(headers, COLUMNS[k]);
    if (i >= 0) col[k] = i + 1;
    else if (REQUIRED.indexOf(k) >= 0) return 'missing column: ' + COLUMNS[k];
    else {
      col[k] = 0;
      missing.push(COLUMNS[k]);
    }
  }
  return {
    sheet: sheet,
    headers: headers,
    col: col,
    missing: missing,
    lastRow: sheet.getLastRow(),
    tz: ss.getSpreadsheetTimeZone() || DEFAULT_TIME_ZONE,
    cache: {},
  };
}

function ping_(ctx) {
  var problems = [];
  WRITABLE.forEach(function (k) {
    if (ctx.col[k] && spillColumn_(ctx, k)) problems.push('"' + COLUMNS[k] + '" is filled by a formula, so it is never written');
  });
  var edit = editProblem_(ctx);
  if (edit) problems.push(edit);
  var leads = profiles_(ctx).filter(function (u) { return String(u || '').trim(); }).length;
  return {
    ok: true,
    tab: ctx.sheet.getName(),
    rows: leads, // rows with a LinkedIn Profile
    timeZone: ctx.tz,
    statusValues: statusList_(ctx, 0) || [],
    missing: ctx.missing,
    problems: problems,
  };
}

// Every row, every column, as shown in the sheet. The profile column holds the link itself
// (also when the cell shows other text with the link behind it, or uses =HYPERLINK()).
function read_(ctx) {
  var n = Math.max(0, ctx.lastRow - 1);
  var rows = [];
  var sentMs = [];
  if (n) {
    rows = ctx.sheet.getRange(2, 1, n, ctx.headers.length).getDisplayValues();
    var urls = profiles_(ctx);
    var dates = ctx.col.sentDate ? ctx.sheet.getRange(2, ctx.col.sentDate, n, 1).getValues() : null;
    for (var i = 0; i < n; i++) {
      rows[i][ctx.col.profile - 1] = urls[i];
      var d = dates ? dates[i][0] : null;
      sentMs.push(d instanceof Date && !isNaN(d.getTime()) ? d.getTime() : null);
    }
  }
  return {
    ok: true,
    tab: ctx.sheet.getName(),
    timeZone: ctx.tz,
    header: ctx.headers,
    first: 2,
    rows: rows,
    sentMs: sentMs,
    statusValues: statusList_(ctx, 0) || [],
    missing: ctx.missing,
  };
}

// ----------------------------------------------------------------------------
// Writes
// ----------------------------------------------------------------------------

// A connection request was sent (now, earlier, or found already pending): "Sent" + Sent Date,
// in every row of that person whose Outreach Status is still empty or "Not Started". Any
// other status is never touched. Without sentAt (or without a Sent Date column) only the status.
function markSent_(ctx, data) {
  var rows = rowsFor_(ctx, data.profileUrl);
  if (!rows.length) return { ok: false, error: 'profile not in tab' };
  var when = validTime_(data.sentAt);
  var written = [];
  var skipped = [];
  rows.forEach(function (row) {
    var statusCell = ctx.sheet.getRange(row, ctx.col.status);
    var current = statusCell.getDisplayValue();
    if (SENDABLE.indexOf(norm_(current)) < 0) return skipped.push({ row: row, why: 'Outreach Status is "' + current + '"' });
    var why = blocked_(ctx, row, 'status');
    if (why) return skip_(skipped, row, why, '[Outreach]');
    var value = allowed_(ctx, row, SENT);
    if (!value) return skip_(skipped, row, '"' + SENT + '" is not in the Outreach Status dropdown', '[Outreach]');
    statusCell.setValue(value);
    written.push(row);

    if (!when || !ctx.col.sentDate) return; // date unknown (e.g. found already pending), or no Sent Date column
    var dateCell = ctx.sheet.getRange(row, ctx.col.sentDate);
    var dateWhy = blocked_(ctx, row, 'sentDate');
    if (dateWhy) skip_(skipped, row, dateWhy, '[Outreach]');
    else if (String(dateCell.getDisplayValue()).trim()) skipped.push({ row: row, why: 'Sent Date already filled — kept' });
    else writeDate_(dateCell, when, ctx.tz);
  });
  return { ok: true, written: written, skipped: skipped };
}

// They accepted: "Accepted but not replied" — only where Outreach Status is "Sent" and
// Response / Notes is empty. Off without a Response / Notes column.
function markAccepted_(ctx, data) {
  if (!ctx.col.notes) return { ok: true, written: [], skipped: [], off: 'no "' + COLUMNS.notes + '" column' };
  var rows = rowsFor_(ctx, data.profileUrl);
  if (!rows.length) return { ok: false, error: 'profile not in tab' };
  var written = [];
  var skipped = [];
  rows.forEach(function (row) {
    var status = ctx.sheet.getRange(row, ctx.col.status).getDisplayValue();
    if (norm_(status) !== norm_(SENT)) return skipped.push({ row: row, why: 'Outreach Status is "' + status + '"' });
    var cell = ctx.sheet.getRange(row, ctx.col.notes);
    if (String(cell.getDisplayValue()).trim()) return skipped.push({ row: row, why: 'Response / Notes is not empty' });
    var why = blocked_(ctx, row, 'notes');
    if (why) return skip_(skipped, row, why, '[Outreach]');
    setText_(cell, ACCEPTED_TEXT);
    written.push(row);
  });
  return { ok: true, written: written, skipped: skipped };
}

// Their messages, each as "[27 Oct 2026, 11:42 PM] text", oldest first, never twice.
// Empty cell or exactly "Accepted but not replied" → replaced. Anything else → kept exactly
// as it is (formatting too), and the new messages are added below it.
// Without a Response / Notes column only the status changes ("Sent" → "Replied").
function addReplies_(ctx, data) {
  var rows = rowsFor_(ctx, data.profileUrl);
  if (!rows.length) return { ok: false, error: 'profile not in tab' };
  var skipped = [];
  if (!ctx.col.notes) {
    rows.forEach(function (row) { markReplied_(ctx, row, skipped); });
    return { ok: true, written: rows, skipped: skipped, statusOnly: true };
  }
  var replies = cleanReplies_(data.replies, data.sentAt);
  var now = new Date();
  var plans = [];

  // Work out every change first; write only when all of them are fine.
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var why = blocked_(ctx, row, 'notes');
    if (why) {
      skip_(skipped, row, why, '[ReplySync]');
      continue;
    }
    var cell = ctx.sheet.getRange(row, ctx.col.notes);
    var shown = cell.getDisplayValue();
    var fresh = newReplies_(shown, replies);
    if (!fresh.length) continue; // every message is already in the cell
    var block = fresh
      .map(function (r) { return '[' + Utilities.formatDate(r.sentAt ? new Date(r.sentAt) : now, ctx.tz, TIME_FORMAT) + '] ' + r.text; })
      .join(ENTRY_SEPARATOR);
    var trimmed = String(shown).trim();
    var replace = !trimmed || trimmed === ACCEPTED_TEXT;
    if ((replace ? 0 : shown.length + ENTRY_SEPARATOR.length) + block.length > CELL_LIMIT) return { ok: false, error: 'cell full' };
    plans.push({ row: row, cell: cell, shown: shown, block: block, replace: replace, rich: replace ? null : cell.getRichTextValue() });
  }

  var written = [];
  plans.forEach(function (p) {
    if (p.replace) setText_(p.cell, p.block);
    else appendText_(p.cell, p.rich, p.shown, p.block);
    written.push(p.row);
    markReplied_(ctx, p.row, skipped);
  });
  return { ok: true, written: written, skipped: skipped };
}

// They replied: "Sent" → "Replied". Any other status is never touched.
function markReplied_(ctx, row, skipped) {
  var statusCell = ctx.sheet.getRange(row, ctx.col.status);
  if (norm_(statusCell.getDisplayValue()) !== norm_(SENT)) return;
  var why = blocked_(ctx, row, 'status');
  var value = allowed_(ctx, row, REPLIED);
  if (why) skip_(skipped, row, why, '[ReplySync]');
  else if (!value) skip_(skipped, row, '"' + REPLIED + '" is not in the Outreach Status dropdown', '[ReplySync]');
  else statusCell.setValue(value);
}

// The Admin Reply was seen in the LinkedIn conversation: clear Admin Reply and Response / Notes
// in that row (contents only — formatting and dropdowns stay). Only if the Admin Reply is still
// the text that was sent. Replies added to Response / Notes after the extension read it are kept.
// Without a Response / Notes column only the Admin Reply is cleared.
function clearAdmin_(ctx, data) {
  if (!ctx.col.admin) return { ok: false, error: 'no "' + COLUMNS.admin + '" column' };
  var target = profileKey_(data.profileUrl);
  var wanted = norm_(data.adminText);
  if (!target || !wanted) return { ok: false, error: 'bad request' };
  var urls = profiles_(ctx);
  var matches = function (row) {
    return row >= 2 && row <= ctx.lastRow && profileKey_(urls[row - 2]) === target &&
      norm_(ctx.sheet.getRange(row, ctx.col.admin).getDisplayValue()) === wanted;
  };
  var row = Number(data.row);
  if (!matches(row)) {
    // The rows moved (sorting, inserted rows): find that person's row with that Admin Reply.
    var found = [];
    for (var r = 2; r <= ctx.lastRow; r++) if (matches(r)) found.push(r);
    if (found.length !== 1) return { ok: false, error: found.length ? 'several rows match — not cleared' : 'admin reply changed — not cleared' };
    row = found[0];
  }
  var why = blocked_(ctx, row, 'admin') || (ctx.col.notes ? blocked_(ctx, row, 'notes') : '');
  if (why) {
    console.warn('[ReplySync] Row %s not cleared: %s', row, why);
    return { ok: false, error: why };
  }
  ctx.sheet.getRange(row, ctx.col.admin).clearContent();
  if (!ctx.col.notes) return { ok: true, row: row, notes: 'no column' };

  var notes = ctx.sheet.getRange(row, ctx.col.notes);
  var now = lines_(notes.getDisplayValue());
  var was = lines_(data.notesText);
  var result = 'cleared';
  if (!now) result = 'empty';
  else if (now === was) notes.clearContent();
  else if (was && now.indexOf(was) === 0) {
    // New replies arrived after the extension read the cell: those stay.
    var rest = now.slice(was.length).replace(/^\s+/, '');
    if (rest) setText_(notes, rest);
    else notes.clearContent();
    result = 'kept newer replies';
  } else {
    result = 'not cleared — it changed since';
    console.warn('[ReplySync] Row %s: Response / Notes changed since it was read — left as it is.', row);
  }
  return { ok: true, row: row, notes: result };
}

// ----------------------------------------------------------------------------
// The scraper's leads → the SCRAP tab
// ----------------------------------------------------------------------------
var SCRAPE_TAB = 'SCRAP';
var SCRAPE_KEY = 'key';            // first column: which person a row is (the scraper's own id)
var SCRAPE_MAX_ROWS = 500;         // per request
var SCRAPE_IN_MY_LEADS = 'inMyLeads';   // "yes" when this person is also in MY LEADS
var SCRAPE_URL_COLUMNS = ['linkedInProfileUrl', 'defaultProfileUrl', 'profileUrl'];  // their LinkedIn links

// The people in MY LEADS (the tab ReplyTrack works from), by profile key → true. {} if no such tab.
function myLeadKeys_(ss, tabName) {
  var out = {};
  var sheet = findTab_(ss, tabName);
  if (!sheet || sheet.getLastRow() < 2 || !sheet.getLastColumn()) return out;
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  var c = findColumn_(headers, COLUMNS.profile);
  if (c < 0) return out;
  var ctx = { sheet: sheet, col: { profile: c + 1 }, lastRow: sheet.getLastRow(), cache: {} };
  profiles_(ctx).forEach(function (u) {
    var k = profileKey_(u);
    if (k) out[k] = true;
  });
  return out;
}

// { columns: ["key", "fullName", …], rows: [["…", "…", …], …] } — the same order as columns.
// A person already in the tab (same key) gets their row updated; a new one is added at the end.
// Only non-empty values are written, and never over a formula.
function saveScraped_(ss, data) {
  var columns = Array.isArray(data.columns) ? data.columns.map(function (c) { return String(c || '').trim(); }) : [];
  var rows = Array.isArray(data.rows) ? data.rows : [];
  if (columns[0] !== SCRAPE_KEY || columns.some(function (c) { return !c; }) || rows.length > SCRAPE_MAX_ROWS) return { ok: false, error: 'bad request' };
  if (!rows.length) return { ok: true, added: 0, updated: 0 };

  var sheet = findTab_(ss, SCRAPE_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(SCRAPE_TAB);
    sheet.getRange(1, 1, 1, columns.length).setValues([columns]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  // Header: the existing columns, plus any new scraper column at the end.
  var lastCol = sheet.getLastColumn();
  var header = lastCol ? sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0] : [];
  var colOf = {};
  header.forEach(function (h, i) { if (String(h).trim() && !colOf[headerKey_(h)]) colOf[headerKey_(h)] = i + 1; });
  var added = [];
  columns.forEach(function (c) {
    if (colOf[headerKey_(c)]) return;
    var at = header.length + added.length + 1;
    colOf[headerKey_(c)] = at;
    added.push(c);
    sheet.getRange(1, at).setValue(c).setFontWeight('bold');
  });
  var width = header.length + added.length;
  var keyCol = colOf[headerKey_(SCRAPE_KEY)];

  // Read the tab once; work in memory; write back in a few blocks (not one call per row).
  var lastRow = sheet.getLastRow();
  var n = Math.max(0, lastRow - 1);
  var values2 = n ? sheet.getRange(2, 1, n, width).getValues() : [];
  var formulas2 = n ? sheet.getRange(2, 1, n, width).getFormulas() : [];
  var rowOf = {};
  values2.forEach(function (r, i) {
    var k = String(r[keyCol - 1] == null ? '' : r[keyCol - 1]).trim().toLowerCase();
    if (k && !rowOf[k]) rowOf[k] = i + 2;
  });

  // Already in MY LEADS? (the "inMyLeads" column, when the extension sends it)
  var mineCol = columns.indexOf(SCRAPE_IN_MY_LEADS);
  var mine = mineCol >= 0 ? myLeadKeys_(ss, data.tab) : null;
  var urlCols = SCRAPE_URL_COLUMNS.map(function (c) { return columns.indexOf(c); }).filter(function (i) { return i >= 0; });

  var count = { added: 0, updated: 0 };
  var changedRows = {};   // row number → true
  var added2 = [];        // new rows, in order
  rows.forEach(function (incoming) {
    if (!Array.isArray(incoming)) return;
    var key = String(incoming[0] == null ? '' : incoming[0]).trim().toLowerCase();
    if (!key) return;
    if (mine) {
      var hit = urlCols.some(function (i) { var k = profileKey_(incoming[i]); return k && mine[k]; });
      incoming = incoming.slice();
      incoming[mineCol] = hit ? 'yes' : '';
    }
    var row = rowOf[key];
    var isNew = !row;
    var out, formulas;
    if (isNew) {
      out = new Array(width).fill('');
      formulas = [];
      added2.push(out);
      row = rowOf[key] = lastRow + added2.length;
    } else {
      out = values2[row - 2];
      formulas = formulas2[row - 2];
    }
    var changed = isNew;
    columns.forEach(function (c, i) {
      var v = incoming[i];
      if (i === 0 && !isNew) return;                          // an existing row keeps its key as it is
      if (v == null || String(v).trim() === '') return;      // nothing new: keep what's there
      var j = colOf[headerKey_(c)] - 1;
      if (formulas[j]) return;                                // never over a formula
      var text = String(v).slice(0, CELL_LIMIT);
      if (String(out[j]) === text) return;
      out[j] = text;
      changed = true;
    });
    if (!changed) return;
    if (isNew) count.added++;
    else {
      count.updated++;
      changedRows[row] = true;
    }
  });

  // Changed rows: written in runs of neighbouring rows. A row with a formula is written cell by
  // cell around it (writing the whole row would turn the formula into its value).
  var changedList = Object.keys(changedRows).map(Number).sort(function (a, b) { return a - b; });
  var hasFormula = function (r) { return formulas2[r - 2].some(function (f) { return f; }); };
  for (var i = 0; i < changedList.length; ) {
    var first = changedList[i];
    if (hasFormula(first)) {
      formulas2[first - 2].forEach(function (f, j) {
        if (!f) sheet.getRange(first, j + 1).setNumberFormat('@').setValue(values2[first - 2][j]);
      });
      i++;
      continue;
    }
    var last = first;
    while (i + 1 < changedList.length && changedList[i + 1] === last + 1 && !hasFormula(changedList[i + 1])) last = changedList[++i];
    i++;
    sheet.getRange(first, 1, last - first + 1, width).setNumberFormat('@').setValues(values2.slice(first - 2, last - 1));
  }
  // New rows: one block at the end.
  if (added2.length) sheet.getRange(lastRow + 1, 1, added2.length, width).setNumberFormat('@').setValues(added2);
  return { ok: true, tab: sheet.getName(), added: count.added, updated: count.updated, newColumns: added };
}

// ----------------------------------------------------------------------------
// Write guards
// ----------------------------------------------------------------------------

// '' when this cell may be written, else the reason it may not.
function blocked_(ctx, row, key) {
  if (WRITABLE.indexOf(key) < 0) return '"' + COLUMNS[key] + '" is read-only';
  if (!ctx.col[key]) return 'no "' + COLUMNS[key] + '" column';
  if (spillColumn_(ctx, key)) return '"' + COLUMNS[key] + '" is filled by a formula';
  if (ctx.sheet.getRange(row, ctx.col[key]).getFormula()) return '"' + COLUMNS[key] + '" has a formula in row ' + row;
  return '';
}

function skip_(list, row, why, prefix) {
  console.warn('%s Skipped row %s: %s', prefix, row, why);
  list.push({ row: row, why: why });
}

// Is a column filled from one formula (header row included)?
function spillColumn_(ctx, key) {
  var k = 'spill_' + key;
  if (!(k in ctx.cache)) {
    var f = ctx.sheet.getRange(1, ctx.col[key], Math.max(1, ctx.lastRow), 1).getFormulas();
    ctx.cache[k] = f.some(function (r) { return SPILL_RE.test(r[0]); });
  }
  return ctx.cache[k];
}

// The Outreach Status dropdown for one row (its own rule, else the column's first rule).
// Row 2 is always looked at, so a new, empty copy of the template still shows its dropdown.
function statusList_(ctx, row) {
  if (row) {
    var own = listOf_(ctx.sheet.getRange(row, ctx.col.status).getDataValidation());
    if (own) return own;
  }
  if (!('statusList' in ctx.cache)) {
    var found = null;
    var rules = ctx.sheet.getRange(2, ctx.col.status, Math.max(1, ctx.lastRow - 1), 1).getDataValidations();
    for (var i = 0; i < rules.length && !found; i++) found = listOf_(rules[i][0]);
    ctx.cache.statusList = found;
  }
  return ctx.cache.statusList;
}

function listOf_(rule) {
  if (!rule) return null;
  var type = rule.getCriteriaType();
  var values = rule.getCriteriaValues();
  if (type === SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST) return (values[0] || []).map(String);
  if (type === SpreadsheetApp.DataValidationCriteria.VALUE_IN_RANGE && values[0]) {
    return [].concat.apply([], values[0].getDisplayValues()).filter(String);
  }
  return null;
}

// The dropdown's own spelling of `wanted`, or null when it isn't in the dropdown.
function allowed_(ctx, row, wanted) {
  var list = statusList_(ctx, row);
  if (!list) return null;
  for (var i = 0; i < list.length; i++) if (norm_(list[i]) === norm_(wanted)) return list[i];
  return null;
}

// Protected tab or cells this account can't edit (a warning-only protection doesn't count).
function editProblem_(ctx) {
  try {
    var mine = ctx.sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET);
    for (var i = 0; i < mine.length; i++) {
      if (!mine[i].isWarningOnly() && !mine[i].canEdit()) return 'the tab is protected and this account may not be able to write to it';
    }
    var ranges = ctx.sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);
    for (var j = 0; j < ranges.length; j++) {
      var p = ranges[j];
      if (p.isWarningOnly() || p.canEdit()) continue;
      var rg = p.getRange();
      for (var w = 0; w < WRITABLE.length; w++) {
        var c = ctx.col[WRITABLE[w]];
        if (c && rg.getColumn() <= c && c <= rg.getLastColumn()) return 'cells in "' + COLUMNS[WRITABLE[w]] + '" are protected and this account can\'t edit them';
      }
    }
  } catch (err) {
    console.warn('[ReplySync] Could not read the protections: %s', err);
  }
  return '';
}

// ----------------------------------------------------------------------------
// Cells
// ----------------------------------------------------------------------------

// Text is stored exactly as given: never turned into a formula, number or date.
function setText_(cell, text) {
  cell.setRichTextValue(SpreadsheetApp.newRichTextValue().setText(text).build());
}

// Adds text below what's in the cell, keeping the existing text and its formatting exactly.
function appendText_(cell, rich, shown, addition) {
  var base = rich ? rich.getText() : String(shown || '');
  var sep = /\n\n$/.test(base) ? '' : /\n$/.test(base) ? '\n' : ENTRY_SEPARATOR;
  var builder = SpreadsheetApp.newRichTextValue().setText(base + sep + addition);
  if (rich) {
    rich.getRuns().forEach(function (run) {
      var s = run.getStartIndex();
      var e = run.getEndIndex();
      if (e <= s) return;
      builder.setTextStyle(s, e, run.getTextStyle());
      if (run.getLinkUrl()) builder.setLinkUrl(s, e, run.getLinkUrl());
    });
  }
  cell.setRichTextValue(builder.build());
}

// A real date (midnight in the sheet's time zone), shown like the other Sent Dates.
function writeDate_(cell, ms, tz) {
  var day = Utilities.formatDate(new Date(ms), tz, 'yyyy-MM-dd');
  var format = String(cell.getNumberFormat() || '').replace(/"[^"]*"/g, '');
  if (!/[dy]/i.test(format)) cell.setNumberFormat(DATE_FORMAT);
  cell.setValue(Utilities.parseDate(day, tz, 'yyyy-MM-dd'));
}

// Messages not in the cell yet (by text), oldest first.
function newReplies_(cellText, replies) {
  var seen = {};
  String(cellText || '').replace(/\r\n?/g, '\n').split(ENTRY_START_RE).forEach(function (chunk) {
    var m = chunk.trim().match(ENTRY_RE);
    if (m) seen[norm_(m[7])] = true;
  });
  var fresh = [];
  replies.forEach(function (r) {
    var k = norm_(r.text);
    if (!k || seen[k]) return;
    seen[k] = true;
    fresh.push(r);
  });
  return fresh.sort(function (a, b) { return (a.sentAt || Infinity) - (b.sentAt || Infinity); });
}

// ----------------------------------------------------------------------------
// Rows and profile links
// ----------------------------------------------------------------------------

// The link in each row's LinkedIn Profile cell (row 2 first).
function profiles_(ctx) {
  if (ctx.cache.profiles) return ctx.cache.profiles;
  var n = Math.max(0, ctx.lastRow - 1);
  var out = [];
  if (n) {
    var range = ctx.sheet.getRange(2, ctx.col.profile, n, 1);
    var shown = range.getDisplayValues();
    var rich = range.getRichTextValues();
    var formulas = range.getFormulas();
    for (var i = 0; i < n; i++) out.push(profileUrl_(shown[i][0], rich[i][0], formulas[i][0]));
  }
  return (ctx.cache.profiles = out);
}

// The text itself, a link behind other text, or the URL inside =HYPERLINK().
function profileUrl_(shown, rich, formula) {
  if (profileKey_(shown)) return String(shown).trim();
  if (rich) {
    if (profileKey_(rich.getLinkUrl())) return rich.getLinkUrl();
    var runs = rich.getRuns();
    for (var r = 0; r < runs.length; r++) if (profileKey_(runs[r].getLinkUrl())) return runs[r].getLinkUrl();
  }
  var m = String(formula || '').match(/https?:\/\/[^"\s)]+/i);
  if (m && profileKey_(m[0])) return m[0];
  return String(shown || '').trim();
}

// Row numbers whose LinkedIn Profile is this person.
function rowsFor_(ctx, profileUrl) {
  var target = profileKey_(profileUrl);
  if (!target) return [];
  var urls = profiles_(ctx);
  var rows = [];
  for (var i = 0; i < urls.length; i++) if (profileKey_(urls[i]) === target) rows.push(i + 2);
  return rows;
}

// "https://www.linkedin.com/in/Jane-Doe-123/?trk=x" -> "jane-doe-123"
// Ignores http/https, www (or country subdomains), trailing slashes, query strings,
// #fragments and URL encoding (%C3%A9 -> é). Case-insensitive.
function profileKey_(value) {
  var s = String(value || '').trim();
  if (!s) return '';
  for (var i = 0; i < 3 && /%[0-9a-f]{2}/i.test(s); i++) {
    try {
      s = decodeURIComponent(s);
    } catch (err) {
      break;
    }
  }
  var m = s.match(/linkedin\.com\/(?:mwlite\/)?in\/([^\/?#\s"']+)/i) || s.match(/linkedin\.com\/sales\/(?:lead|people)\/(AC[wo]AA[\w-]+)/i);
  return m ? m[1].trim().toLowerCase() : '';
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function findTab_(ss, name) {
  var wanted = String(name || '').trim();
  if (!wanted) return null;
  var exact = ss.getSheetByName(wanted);
  if (exact) return exact;
  var lower = wanted.toLowerCase();
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getName().trim().toLowerCase() === lower) return sheets[i];
  }
  return null;
}

function findColumn_(headers, name) {
  var wanted = headerKey_(name);
  for (var i = 0; i < headers.length; i++) {
    if (headerKey_(headers[i]) === wanted) return i;
  }
  return -1;
}

function headerKey_(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// replies: ["text", …], times: [ms, …] (same order) -> [{ text, sentAt }] ; sentAt is null
// when missing or not a sensible time.
function cleanReplies_(list, times) {
  if (!Array.isArray(list)) return [];
  var out = [];
  list.forEach(function (r, i) {
    var t = String(r == null ? '' : r).replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (t) out.push({ text: t, sentAt: validTime_(Array.isArray(times) ? times[i] : NaN) });
  });
  return out;
}

// Milliseconds between 2003 (LinkedIn's launch) and one day ahead (clock differences), else null.
function validTime_(v) {
  var ms = Number(v);
  return isFinite(ms) && ms > 1041379200000 && ms < Date.now() + 86400000 ? ms : null;
}

// For duplicate checks: whitespace and case don't matter; a leading ' is ignored.
function norm_(s) {
  return String(s || '').replace(/^'/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function lines_(s) {
  return String(s || '').replace(/\r\n?/g, '\n').trim();
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function escapeHtml_(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// ----------------------------------------------------------------------------
// The page a team member sees when they open the team web app (after Google's permission
// screen, the first time). Shows the Google account ReplyTrack will use.
// ----------------------------------------------------------------------------
function connectedPage_(email, missing) {
  var body;
  var copy = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/[\w-]+\/copy$/.test(TEMPLATE_COPY_URL) ? TEMPLATE_COPY_URL : '';
  if (email && missing) {
    // Approved, but without "Google Sheets" ticked.
    body =
      '<div class="mark warn">!</div>' +
      '<h1>One more step</h1>' +
      '<p>ReplyTrack is approved for</p>' +
      '<p class="who">' + escapeHtml_(email) + '</p>' +
      '<p>…but not for your Google Sheets: on Google’s screen, the box next to ' +
      '<b>“See, edit, create, and delete all your Google Sheets spreadsheets”</b> wasn’t ticked.</p>' +
      (/^https:\/\//.test(missing)
        ? '<a class="btn" href="' + escapeHtml_(missing) + '" target="_blank" rel="noopener">Give permission</a>' +
          '<p>Tick that box, click <b>Continue</b>, then open this page again.</p>'
        : '') +
      '<div class="note"><b>Google doesn’t ask again?</b> Open myaccount.google.com/connections, remove this app, ' +
      'then open this page again and tick every box.</div>';
  } else if (email) {
    body =
      '<div class="mark ok">✓</div>' +
      '<h1>You’re connected</h1>' +
      '<p>ReplyTrack is approved for</p>' +
      '<p class="who">' + escapeHtml_(email) + '</p>' +
      (copy
        ? '<p>No sheet yet? Make your own copy, then paste its link in ReplyTrack → Settings → <b>Your sheet link</b>.</p>' +
          '<a class="btn" href="' + escapeHtml_(copy) + '" target="_blank" rel="noopener">Make a copy of the sheet</a>'
        : '') +
      '<p>In ReplyTrack’s Settings, click <b>Save</b> (or <b>Test connection</b>) — ' +
      'it shows which Google account ReplyTrack uses. Then you can close this tab.</p>' +
      '<div class="note"><b>Is Chrome signed in to more than one Google account?</b> Google uses the first one you signed in with. ' +
      'If Test connection names the wrong account: sign out of all Google accounts and sign in first with the one that has your ' +
      'sheet, or use a Chrome profile with only that account. Then open this page again.</div>';
  } else {
    body =
      '<div class="mark bad">!</div>' +
      '<h1>This web app isn’t set up right</h1>' +
      '<p>It must be deployed with <b>Execute as: User accessing the web app</b>. Please tell your team lead.</p>';
  }
  var html =
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700&display=swap" rel="stylesheet">' +
    '<style>' +
    'html,body{margin:0;background:#050505;color:#fff;font:15px/1.55 Montserrat,system-ui,-apple-system,"Segoe UI",sans-serif}' +
    '.card{max-width:460px;margin:12vh auto 24px;padding:32px 28px;background:#111113;border:1px solid #222;border-radius:16px;text-align:center}' +
    '.mark{width:52px;height:52px;margin:0 auto 18px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:700}' +
    '.ok{background:rgba(52,200,138,.14);color:#34c88a}.bad{background:rgba(239,68,68,.14);color:#ef4444}.warn{background:rgba(245,166,35,.14);color:#f5a623}' +
    'h1{margin:0 0 12px;font-size:24px;letter-spacing:-.01em}p{margin:6px 0;color:#c8c8c8}' +
    '.who{color:#fff;font-weight:600;font-size:17px;margin:4px 0 16px;word-break:break-all}' +
    '.btn{display:inline-block;margin:12px 0 18px;padding:11px 22px;border-radius:999px;background:#fff;color:#000;font-weight:700;text-decoration:none}' +
    '.btn:hover{background:#e6e6e6}' +
    '.note{margin-top:22px;padding:14px 16px;border:1px solid #2e2e33;border-radius:10px;background:#18181b;color:#8a8a8a;font-size:13px;text-align:left}' +
    '.note b{color:#fff}' +
    '</style></head><body><div class="card">' + body + '</div></body></html>';
  return HtmlService.createHtmlOutput(html)
    .setTitle(!email ? 'ReplyTrack — not set up' : missing ? 'ReplyTrack — one more step' : 'ReplyTrack — connected')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
