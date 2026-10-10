/**
 * ============================================================
 * AppApi.gs  -  backend for the DUAAPS Scanner Android app v1.1 (offline-first)
 * Add as a NEW file in the same Apps Script project as EntryScan.gs / EventScanner.gs.
 * ============================================================
 * What it adds (all actions start with "app_", the old "login"/"scan" actions are untouched):
 *
 *   app_login     PIN check. Accepts the GATE PIN (ENTRY.GATE_PIN, e.g. 2026) AND every event PIN.
 *   app_snapshot  Everything the phone needs to work offline: all registrations + who already
 *                 entered + who already got breakfast / lunch / snacks / gift / lottery (with times).
 *   app_sync      Uploads scans made on the phone (batched). The server stays the single source of
 *                 truth: first scan wins, later scans are reported back as DUPLICATE.
 *   app_delta     "What changed since #N?" - polled every few seconds so every phone learns about
 *                 scans made on the other phones almost in real time.
 *   app_photos    Photos on demand (small thumbnails, cached on the phone).
 *
 * Uses (already in your project): CONFIG, ENTRY (EntryScan.gs), SCN_CONFIG, SCN_FIRST_EVENT_COL,
 * scnAuth_, scnProcess (EventScanner.gs), getSheet_, findRowByRegId_ (Code.gs), entryEnsureColumns_,
 * entryLog_, entryText_, entryPhoto_, sheet_ss_.
 *
 * SETUP: see apps-script/SETUP.md  (one line in doPost + "New version" deployment).
 * Run appApiSelfTest() once from the editor to check everything is wired correctly.
 */
const APPAPI = {
  CHANGE_SHEET: 'App Sync Log',
  ID_COL: null,         // null = CONFIG.COL_REG_ID (column A in your sheet)
  MAX_BATCH: 12,
  SNAP_PAGE: 2500
};

/* ============ routing: call this first thing in doPost(e) ============ */
function appApiRoute_(e) {
  let req = null;
  try { if (e && e.postData && e.postData.contents) req = JSON.parse(e.postData.contents); } catch (x) { req = null; }
  if (!req && e && e.parameter && e.parameter.action) req = e.parameter;
  if (!req || String(req.action || '').indexOf('app_') !== 0) return null;   // not ours: let your old code run
  let out;
  try { out = appApiHandle_(req); }
  catch (err) { out = { ok: false, message: 'Server error: ' + (err && err.message) }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function appApiHandle_(req) {
  const auth = appAuth_(req.pin);
  if (!auth.ok) return { ok: false, bad_pin: true, message: auth.message || 'Wrong PIN' };
  switch (String(req.action)) {
    case 'app_login':
      return {
        ok: true, role: auth.role, label: auth.label, key: auth.key,
        tz: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'Z'),          // gate times
        tzEv: Utilities.formatDate(new Date(), SCN_CONFIG.TIMEZONE, 'Z'),                  // event times
        serverTime: Date.now(), seq: appSeq_()
      };
    case 'app_snapshot': return appSnapshot_(req);
    case 'app_delta':    return appDelta_(req);
    case 'app_sync':     return appSync_(req, auth);
    case 'app_photos':   return appPhotos_(req);
  }
  return { ok: false, message: 'Unknown action' };
}

/* ============ PIN: gate PIN OR any event PIN ============ */
function appHash_(s) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'duaaps|' + s));
}
function appAuth_(pin) {
  pin = String(pin == null ? '' : pin);
  if (!pin) return { ok: false, message: 'Enter the PIN' };
  if (pin === ENTRY.GATE_PIN) return { ok: true, role: 'gate', label: 'ENTRY GATE', key: 'ENTRY' };

  const cache = CacheService.getScriptCache();
  const ck = 'app_auth_' + appHash_(pin);
  try { const hit = cache.get(ck); if (hit) return JSON.parse(hit); } catch (e) { /* ignore */ }

  const a = scnAuth_(pin);                     // your existing event-PIN check (also counts wrong tries)
  if (!a || !a.ok) return { ok: false, message: (a && a.message) || 'Wrong PIN' };
  const info = appEventFromAuth_(a);
  const res = { ok: true, role: 'event', label: info.label, key: info.key };
  try { cache.put(ck, JSON.stringify(res), 300); } catch (e) { /* ignore */ }
  return res;
}
/** Reads the event name out of whatever scnAuth_ returns (it is OK if this finds nothing: the app learns it from the first scan). */
function appEventFromAuth_(a) {
  const ev = a.event || a.ev || a.evt || a.scanner || a;
  let label = '', key = '';
  if (typeof ev === 'string') label = ev;
  else if (ev && typeof ev === 'object') { label = ev.label || ev.name || ev.title || ''; key = ev.key || ev.id || ev.code || ''; }
  label = String(label || a.label || a.eventLabel || a.name || '');
  key = String(key || a.key || a.eventKey || '');
  if (!label && key) label = key;
  return { label: label, key: key };
}

/* ============ small helpers ============ */
function appNorm_(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, ''); }

function appStamp_(ms) {
  ms = Number(ms);
  const now = Date.now();
  if (!ms || ms > now + 300000 || ms < now - 172800000) ms = now;     // bad / far-off phone clock -> use server time
  return Utilities.formatDate(new Date(ms), Session.getScriptTimeZone(), 'dd-MMM-yyyy hh:mm:ss a');
}

function appIdCol_() {
  if (APPAPI.ID_COL !== null && APPAPI.ID_COL !== undefined) return APPAPI.ID_COL;
  return CONFIG.COL_REG_ID;
}
/** Column of "Payment Verification" (same lookup EventScanner.gs uses). -1 = no such column = everyone counts as verified. */
function appPayCol_(sheet) {
  const cache = CacheService.getScriptCache();
  try { const hit = cache.get('app_paycol'); if (hit !== null && hit !== undefined) return Number(hit); } catch (e) { /* ignore */ }
  const head = sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0];
  let col = -1;
  for (let c = 0; c < head.length; c++) { if (appNorm_(head[c]) === 'paymentverification') { col = c; break; } }
  try { cache.put('app_paycol', String(col), 600); } catch (e) { /* ignore */ }
  return col;
}
/** Exactly the rule scnFindPerson_ uses: verified only when the cell says "Verified". */
function appVerified_(v, col) {
  if (col < 0) return 1;
  return String(v[col] == null ? '' : v[col]).trim().toLowerCase() === 'verified' ? 1 : 0;
}
function appPhotoId_(url) {
  const m = String(url || '').match(/[-\w]{25,}/);
  return m ? m[0] : '';
}
function appRowWidth_(sheet, extra) {
  const need = Math.max(CONFIG.COL_BLOOD_GROUP, ENTRY.COL_ENTRY_ATTEMPTS, CONFIG.COL_PHOTO_URL, extra || 0) + 1;
  return Math.min(need, sheet.getMaxColumns());
}
function appPerson_(v, id, vcol) {
  const entered = String(v[ENTRY.COL_ENTRY_STATUS] || '').trim().toUpperCase() === 'ENTERED';
  return [
    String(id),
    String(v[CONFIG.COL_NAME] || ''),
    String(v[CONFIG.COL_DEGREE] || ''),
    String(v[CONFIG.COL_SESSION] || ''),
    String(v[CONFIG.COL_TOTAL_ATTENDEES] || ''),
    String(v[CONFIG.COL_GUEST_TYPE] || ''),
    String(v[CONFIG.COL_TOTAL_FEE] || ''),
    String(v[CONFIG.COL_BLOOD_GROUP] || ''),
    appPhotoId_(v[CONFIG.COL_PHOTO_URL]),
    appVerified_(v, vcol),
    entered ? (entryText_(v[ENTRY.COL_ENTRY_TIME]) || 'ENTERED') : ''
  ];
}

/* ============ change log (what makes phones update each other) ============ */
function appChangeSheet_() {
  const ss = sheet_ss_();
  let sh = ss.getSheetByName(APPAPI.CHANGE_SHEET);
  if (!sh) {
    sh = ss.insertSheet(APPAPI.CHANGE_SHEET);
    sh.getRange('A:E').setNumberFormat('@');
    sh.appendRow(['ID', 'Kind', 'Time', 'Source', 'Logged At']);
    sh.getRange('A1:E1').setFontWeight('bold').setBackground('#fce4d6');
  }
  return sh;
}
/** The row number minus 1 is the change number, so nothing else has to be stored. */
function appSeq_() { return Math.max(0, appChangeSheet_().getLastRow() - 1); }

function appLogChange_(regId, kind, timeText, source) {
  const sh = appChangeSheet_();
  sh.appendRow([String(regId), String(kind), String(timeText), String(source || ''), entryNow_()]);
}

/* ============ app_snapshot ============ */
function appSnapshot_(req) {
  const sheet = getSheet_();
  entryEnsureColumns_(sheet);
  const seq0 = appSeq_();                       // read BEFORE the data: a change made while downloading is simply re-applied
  const idCol = appIdCol_();
  const vcol = appPayCol_(sheet);

  const last = sheet.getLastRow();
  const from = Math.max(2, Number(req.from) || 2);
  const out = { ok: true, seq: seq0, from: from, next: 0, total: Math.max(0, last - 1), rows: [], serverTime: Date.now() };
  if (last >= from) {
    const n = Math.min(APPAPI.SNAP_PAGE, last - from + 1);
    const vals = sheet.getRange(from, 1, n, appRowWidth_(sheet, Math.max(idCol, vcol))).getValues();
    for (let i = 0; i < vals.length; i++) {
      const id = String(vals[i][idCol] == null ? '' : vals[i][idCol]).trim();
      if (id) out.rows.push(appPerson_(vals[i], id, vcol));
    }
    if (from + n <= last) out.next = from + n;
  }
  if (from === 2) { const ev = appEventTracking_(); out.events = ev.events; out.marks = ev.marks; }
  return out;
}

/** Reads the "Event Tracking" sheet exactly as EventScanner.gs writes it: A=ID, B=Name, C=Degree, D=Membership, E.. = events. */
function appEventTracking_() {
  const evs = SCN_CONFIG.EVENTS;
  const res = { events: evs.map(function (e) { return e.label; }), marks: {} };
  const sh = sheet_ss_().getSheetByName(SCN_CONFIG.TRACK_SHEET);
  if (!sh || sh.getLastRow() < 2) return res;
  const first = SCN_FIRST_EVENT_COL - 1;                         // 0-based
  const width = Math.min(first + evs.length, sh.getMaxColumns());
  const vals = sh.getRange(2, 1, sh.getLastRow() - 1, width).getDisplayValues();
  for (let r = 0; r < vals.length; r++) {
    const id = String(vals[r][0] == null ? '' : vals[r][0]).trim();
    if (!id) continue;
    let m = null;
    for (let j = 0; j < evs.length; j++) {
      const t = String(vals[r][first + j] == null ? '' : vals[r][first + j]).trim();
      if (t) { if (!m) m = {}; m[evs[j].label] = t; }
    }
    if (m) res.marks[id] = m;
  }
  return res;
}

/* ============ app_delta ============ */
function appDelta_(req) {
  const sh = appChangeSheet_();
  const seq = Math.max(0, sh.getLastRow() - 1);
  const since = Math.max(0, Number(req.since) || 0);
  if (since > seq) return { ok: true, reset: true, seq: seq, changes: [] };      // log was cleared: phones re-download
  if (since === seq) return { ok: true, seq: seq, changes: [] };
  const n = Math.min(seq - since, 400);
  const rows = sh.getRange(since + 2, 1, n, 3).getValues();
  const changes = rows.map(function (r) { return [String(r[0]), String(r[1]), entryText_(r[2])]; });
  return { ok: true, seq: since + n, more: (since + n) < seq, changes: changes };
}

/* ============ app_sync: apply the scans made on the phone ============ */
function appSync_(req, auth) {
  const items = (req.scans || []).slice(0, APPAPI.MAX_BATCH);
  const src = 'app:' + String(req.dev || '').slice(0, 12);
  const cache = CacheService.getScriptCache();
  const results = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const cid = String(it.cid || '');
    const ck = cid ? 'app_cid_' + cid : '';
    let res = null;
    if (ck) { try { const hit = cache.get(ck); if (hit) res = JSON.parse(hit); } catch (e) { res = null; } }   // a retry of a scan we already applied
    if (!res) {
      try {
        if (it.kind === 'ENTRY') {
          res = auth.role === 'gate' ? appApplyEntry_(it.id, it.ts, src, req.wantPerson) : { status: 'ERROR', message: 'This PIN cannot do gate entry' };
        } else {
          res = auth.role === 'event' ? appApplyEvent_(req.pin, it.id, src, req.wantPerson) : { status: 'ERROR', message: 'This PIN cannot record events' };
        }
      } catch (err) { res = { status: 'ERROR', message: String(err && err.message) }; }
      if (ck && res.status !== 'ERROR') { try { cache.put(ck, JSON.stringify(res), 21600); } catch (e) { /* ignore */ } }
    }
    res.cid = cid;
    results.push(res);
  }
  return { ok: true, results: results, seq: appSeq_() };
}

/** Gate entry: same rules and same sheet columns as scanEntry(), but takes the time the phone scanned. */
function appApplyEntry_(regId, tsMs, src, wantPerson) {
  regId = String(regId || '').trim();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { status: 'ERROR', message: 'System busy' };
  let res, stamp = '';
  try {
    const sheet = getSheet_();
    entryEnsureColumns_(sheet);
    const row = findRowByRegId_(sheet, regId);
    if (row < 1) { entryLog_(regId, '', 'NOT FOUND'); return { status: 'NOT_FOUND', id: regId }; }
    const pcol = appPayCol_(sheet);
    const v = sheet.getRange(row, 1, 1, appRowWidth_(sheet, pcol)).getValues()[0];
    const name = String(v[CONFIG.COL_NAME] || '');
    if (String(v[ENTRY.COL_ENTRY_STATUS] || '').trim().toUpperCase() === 'ENTERED') {
      const attempts = (Number(v[ENTRY.COL_ENTRY_ATTEMPTS]) || 0) + 1;
      sheet.getRange(row, ENTRY.COL_ENTRY_ATTEMPTS + 1).setValue(attempts);
      const first = entryText_(v[ENTRY.COL_ENTRY_TIME]);
      entryLog_(regId, name, 'DUPLICATE - first entered ' + first);
      res = { status: 'DUPLICATE', time: first, attempts: attempts };
    } else {
      stamp = appStamp_(tsMs);
      sheet.getRange(row, ENTRY.COL_ENTRY_STATUS + 1, 1, 2).setNumberFormat('@').setValues([['ENTERED', stamp]]);
      entryLog_(regId, name, 'ENTERED');
      res = { status: 'OK', time: stamp };
    }
    if (wantPerson) res.person = appPerson_(v, regId, pcol);
    SpreadsheetApp.flush();
  } finally {
    try { lock.releaseLock(); } catch (e) { /* already released */ }
  }
  if (res.status === 'OK') appLogChange_(regId, 'ENTRY', stamp, src);
  return res;
}

/** Event scan (breakfast, lunch, ...): your existing scnProcess() stays the authority. */
function appApplyEvent_(pin, regId, src, wantPerson) {
  regId = String(regId || '').trim();
  const r = scnProcess(pin, regId);
  if (!r) return { status: 'ERROR', message: 'No answer from the event scanner' };
  if (r.status === 'BAD_PIN') return { status: 'BAD_PIN', message: r.message || 'Wrong PIN' };
  const res = { status: r.status, event: r.event, headline: r.headline, time: r.time, message: r.message, record: r.record, current: r.current };
  if (r.status === 'OK') appLogChange_(r.person && r.person.id ? r.person.id : regId, r.event, r.time, src);
  if (wantPerson && r.status !== 'NOT_FOUND') {
    try {
      const sheet = getSheet_();
      const row = findRowByRegId_(sheet, regId);
      if (row > 0) { const pc = appPayCol_(sheet); res.person = appPerson_(sheet.getRange(row, 1, 1, appRowWidth_(sheet, pc)).getValues()[0], regId, pc); }
    } catch (e) { /* person card is optional */ }
  }
  return res;
}

/* ============ app_photos ============ */
function appPhotos_(req) {
  const ids = (req.ids || []).slice(0, 4);
  const photos = {};
  for (let i = 0; i < ids.length; i++) {
    const fid = String(ids[i] || '');
    if (!/^[-\w]{25,}$/.test(fid)) continue;
    const p = entryPhoto_(fid);
    if (p) photos[fid] = p;
  }
  return { ok: true, photos: photos };
}

/* ============ run this once from the Apps Script editor (then View > Logs / Execution log) ============ */
function appApiSelfTest(eventPin) {
  const sheet = getSheet_();
  const head = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const idCol = appIdCol_();
  Logger.log('1) Registration ID column: ' + idCol + ' (header "' + head[idCol] + '")  | registrations: ' + Math.max(0, sheet.getLastRow() - 1));
  const pc = appPayCol_(sheet);
  Logger.log('2) Payment Verification column: ' + (pc < 0 ? 'NOT FOUND -> everyone counts as verified (same as EventScanner.gs)' : (pc + ' (header "' + head[pc] + '")')));
  const ev = appEventTracking_();
  Logger.log('3) Events: ' + ev.events.join(' | ') + '   | people with at least one event time: ' + Object.keys(ev.marks).length);
  Logger.log('4) Gate PIN login: ' + JSON.stringify(appAuth_(ENTRY.GATE_PIN)));
  if (eventPin) Logger.log('5) Event PIN login: ' + JSON.stringify(appAuth_(String(eventPin))));
  else Logger.log('5) To also test an event PIN run: appApiSelfTest("0009")');
  Logger.log('6) Change log rows: ' + appSeq_());
  Logger.log('7) entryFindRow_ defined: ' + (typeof entryFindRow_ === 'function') + ' | entryPhotoFor defined: ' + (typeof entryPhotoFor === 'function') + '  (see SETUP.md step 3 if false)');
}
