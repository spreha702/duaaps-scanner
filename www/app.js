/**
 * DUAAPS Scanner Native App Logic (v1.1)
 * Offline-first: local copy of the registration list, instant decisions, background sync.
 */

const WEBAPP_URL = 'https://script.google.com/macros/s/AKfycbzc_G9p-gwpPuC08389OjgPq3HkL3rKOJQ7LDc3rUPQZUsrWZhm_14VYVUdHJYCBeqJ/exec';

let PIN = '';
let EVT = 'ANNUAL REUNION';
let isBusy = false;
let lastScannedText = '';
let lastScanTime = 0;
let torchEnabled = false;
let isNative = false;
let turboMode = true; // High-speed gate mode: 0.8s auto-reset

const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Immediate Audio & Haptic Feedback (single reused AudioContext)
let audioCtx = null;
function beep(success) {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      if (!audioCtx) audioCtx = new AudioCtx();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.frequency.value = success ? 950 : 220;
      gain.gain.value = 0.18;
      osc.start();
      osc.stop(audioCtx.currentTime + (success ? 0.12 : 0.35));
    }
  } catch (e) {}

  if (navigator.vibrate) {
    try { navigator.vibrate(success ? 60 : [120, 60, 120]); } catch (e) {}
  }
}

// Native ML Kit plugin proxy. Must be registered explicitly because this app has no bundler.
let BarcodeScanner = null;
try {
  if (window.Capacitor && typeof window.Capacitor.registerPlugin === 'function') {
    BarcodeScanner = window.Capacitor.registerPlugin('BarcodeScanner');
  }
} catch (e) {
  console.warn('Could not register BarcodeScanner plugin:', e);
}

function checkCapacitor() {
  return typeof window.Capacitor !== 'undefined' &&
    typeof window.Capacitor.isNativePlatform === 'function' &&
    window.Capacitor.isNativePlatform();
}

function showPermissionDeniedModal(msg) {
  $('camMsg').textContent = '⚠️ Camera permission is required';
  const modal = $('permModal');
  if (modal) {
    if (msg) $('permSubtitle').textContent = msg;
    modal.style.display = 'flex';
  }
}

function setScannerTransparent(on) {
  document.body.classList.toggle('barcode-scanner-active', on);
  document.documentElement.classList.toggle('barcode-scanner-active', on);
}

let cameraStarting = false;   // guards against overlapping start requests
let nativeScanning = false;
let wantScanning = false;    // true once the user is logged in and should be scanning
let permInFlight = null;     // single shared permission request (never two at once)

// Camera permission: ONE shared in-flight request. Called at app launch AND by startCamera;
// both await the same promise, so Android never sees two overlapping permission dialogs.
function ensureCameraPermission() {
  if (!(checkCapacitor() && BarcodeScanner)) return Promise.resolve('granted');
  if (permInFlight) return permInFlight;
  permInFlight = (async () => {
    try {
      let status = await BarcodeScanner.checkPermissions();
      console.log('Camera permission status:', status);
      if (status.camera !== 'granted') {
        // 'prompt' / 'prompt-with-rationale' -> system dialog. 'denied' -> Android may not show it again.
        status = await BarcodeScanner.requestPermissions();
        console.log('Camera permission after request:', status);
      }
      return status.camera;
    } catch (e) {
      console.warn('Permission check failed:', e);
      return 'error';
    } finally {
      permInFlight = null;
    }
  })();
  return permInFlight;
}

// Start Scanner: native ML Kit. The WebView camera is only used outside the app (browser testing)
// and only when the browser can actually decode QR codes (BarcodeDetector).
async function startCamera() {
  if (cameraStarting || nativeScanning) return;
  cameraStarting = true;
  try {
    await startCameraInner();
  } finally {
    cameraStarting = false;
  }
}

function showScannerError(msg) {
  const el = $('camMsg');
  el.textContent = msg + '  (tap to retry)';
  el.style.pointerEvents = 'auto';
  el.onclick = () => { el.onclick = null; el.style.pointerEvents = 'none'; startCamera(); };
}

async function startCameraInner() {
  $('camMsg').textContent = 'Starting scanner…';
  const modal = $('permModal');
  if (modal) modal.style.display = 'none';

  isNative = checkCapacitor() && !!BarcodeScanner;

  if (isNative) {
    try {
      const perm = await ensureCameraPermission();
      if (perm !== 'granted') {
        showPermissionDeniedModal('Camera access is turned off. Tap "Open App Settings", then Permissions > Camera > Allow only while using the app.');
        return;
      }

      await BarcodeScanner.removeAllListeners();
      await BarcodeScanner.addListener('barcodesScanned', (result) => {
        const list = result && result.barcodes;
        if (list && list.length && list[0].rawValue) {
          handleScanned(list[0].rawValue);
        }
      });
      await BarcodeScanner.addListener('scanError', (err) => {
        console.warn('Scan error:', err);
        nativeScanning = false;
        setScannerTransparent(false);
        showScannerError('Scanner error: ' + (err && err.message ? err.message : 'unknown'));
      });

      setScannerTransparent(true);
      await BarcodeScanner.startScan({ formats: ['QR_CODE'], lensFacing: 'BACK' });
      nativeScanning = true;
      initZoom();
      $('camMsg').textContent = 'Point at a QR code';
      return;
    } catch (nativeErr) {
      console.warn('Native ML Kit error:', nativeErr);
      setScannerTransparent(false);
      nativeScanning = false;
      const errStr = String(nativeErr && (nativeErr.message || nativeErr)).toLowerCase();
      if (errStr.includes('denied') || errStr.includes('permission')) {
        showPermissionDeniedModal('Camera permission denied. Tap "Open App Settings" to enable it.');
        return;
      }
      // No silent WebView fallback inside the app: Android WebView cannot decode QR codes,
      // so a "working" preview that never scans is worse than a clear error.
      showScannerError('Scanner error: ' + (nativeErr.message || nativeErr));
      return;
    }
  }

  // Browser testing only
  if ('BarcodeDetector' in window) {
    await startWebCamera();
  } else {
    $('camMsg').textContent = 'This browser cannot scan QR codes. Use the Android app.';
  }
}

let webStream = null;
let webVideo = null;
let webDetector = null;
let webRaf = null;

async function startWebCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: false
    });

    webStream = stream;
    const stage = $('stage');
    stage.innerHTML = '';
    webVideo = document.createElement('video');
    webVideo.setAttribute('playsinline', '');
    webVideo.setAttribute('autoplay', '');
    webVideo.muted = true;
    webVideo.srcObject = stream;
    stage.appendChild(webVideo);
    await webVideo.play();

    $('camMsg').textContent = 'Point at a QR code';

    webDetector = new BarcodeDetector({ formats: ['qr_code'] });
    const loop = async () => {
      if (!webVideo) return;
      try {
        const codes = await webDetector.detect(webVideo);
        if (codes && codes.length && codes[0].rawValue) {
          handleScanned(codes[0].rawValue);
        }
      } catch (e) {}
      webRaf = requestAnimationFrame(loop);
    };
    webRaf = requestAnimationFrame(loop);
  } catch (err) {
    console.warn('Web camera stream failed:', err);
    const str = String(err.name || err.message || err).toLowerCase();
    if (str.includes('notallowed') || str.includes('denied') || str.includes('permission')) {
      showPermissionDeniedModal('Camera access blocked. Please enable Camera permissions.');
    } else {
      showScannerError('Camera error: ' + (err.message || err));
    }
  }
}

async function stopCamera() {
  wantScanning = false;
  if (isNative && BarcodeScanner) {
    try {
      await BarcodeScanner.stopScan();
      await BarcodeScanner.removeAllListeners();
    } catch (e) {}
  }
  nativeScanning = false;
  setScannerTransparent(false);

  if (torchEnabled) {
    torchEnabled = false;
    $('torchBtn').classList.remove('active');
  }

  if (webRaf) cancelAnimationFrame(webRaf);
  webRaf = null;
  if (webStream) {
    webStream.getTracks().forEach(t => t.stop());
    webStream = null;
  }
  if (webVideo) {
    webVideo.srcObject = null;
    webVideo = null;
  }
}

// Fast Torch Toggle (state only flips if the torch call really succeeds)
$('torchBtn').onclick = async () => {
  const want = !torchEnabled;
  try {
    if (isNative && BarcodeScanner && nativeScanning) {
      if (want) await BarcodeScanner.enableTorch();
      else await BarcodeScanner.disableTorch();
    } else if (webStream) {
      const track = webStream.getVideoTracks()[0];
      await track.applyConstraints({ advanced: [{ torch: want }] });
    } else {
      return; // scanner not running
    }
    torchEnabled = want;
    $('torchBtn').classList.toggle('active', torchEnabled);
  } catch (e) {
    console.warn('Torch unavailable:', e);
    $('camMsg').textContent = 'Flashlight not available on this device';
  }
};

// Turbo Mode Toggle
$('turboBtn').onclick = () => {
  turboMode = !turboMode;
  $('turboBtn').classList.toggle('off', !turboMode);
  $('turboStatus').textContent = turboMode ? 'ON' : 'OFF';
};

// Extract clean ID
function extractId(text) {
  let s = String(text || '').trim();
  const m = s.match(/[?&](?:verify|id)=([^&#\s]+)/i);
  if (m) {
    try { s = decodeURIComponent(m[1]); } catch (e) { s = m[1]; }
  }
  return s.trim();
}

// Rapid Scan Handler.
// The scanner reports the same code on every frame while it is in view. A code stays "locked" as long as
// it keeps being seen; it is only processed again after it has been out of view for SAME_CODE_GAP ms.
// (Prevents the green GRANTED flash from turning into a red ALREADY SCANNED while the QR is still held up.)
const SAME_CODE_GAP = 2500;
function handleScanned(rawText) {
  const now = Date.now();
  const val = String(rawText || '').trim();
  if (!val) return;

  if (val === lastScannedText && now - lastScanTime < SAME_CODE_GAP) {
    lastScanTime = now;   // still in view: extend the lock
    return;
  }
  lastScannedText = val;
  lastScanTime = now;

  // Instant optical reticle pulse
  const frame = $('frame');
  frame.classList.add('scanned');
  setTimeout(() => frame.classList.remove('scanned'), 180);

  submitScan(val);
}


/* =====================================================================================
 * OFFLINE-FIRST ENGINE (v1.1)
 *  - On login the phone downloads every registration + who already entered / got food.
 *  - Every scan is decided from that local copy (instant), saved locally, queued, and sent to the
 *    server in the background. The server stays the single source of truth.
 *  - Every few seconds the phone asks the server "what changed?" so scans made on other phones
 *    appear here almost in real time.
 * ===================================================================================== */
const POLL_ACTIVE = 4000;               // while scanning
const POLL_IDLE = 12000;
const SNAPSHOT_REFRESH = 10 * 60 * 1000; // silent full refresh (safety net)

let ROLE = '';      // 'gate' | 'event'
let LABEL = '';     // e.g. "Breakfast"
let evNorm = '';    // normalised event name used as the key in the local records

const people = new Map();   // k (lower-case id) -> person
const marks = new Map();    // k -> { k, entry: 'time' | '', ev: { eventNorm: 'time' } }
let outbox = [];            // scans waiting for the server
let meta = { seq: 0, events: [], snapshotAt: 0, tzMin: null, tzEvMin: null, deviceId: '', okHeadline: {}, conflicts: [], lastContact: 0 };

const norm = s => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const newCid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/* ---------- tiny IndexedDB wrapper (all calls resolve, never throw) ---------- */
const Store = {
  db: null,
  open() {
    return new Promise(resolve => {
      try {
        if (!window.indexedDB) return resolve(false);
        const rq = indexedDB.open('duaaps-scanner', 1);
        rq.onupgradeneeded = () => {
          const d = rq.result;
          d.createObjectStore('people', { keyPath: 'k' });
          d.createObjectStore('marks', { keyPath: 'k' });
          d.createObjectStore('photos', { keyPath: 'fid' });
          d.createObjectStore('outbox', { keyPath: 'cid' });
          d.createObjectStore('kv', { keyPath: 'key' });
        };
        rq.onsuccess = () => { Store.db = rq.result; resolve(true); };
        rq.onerror = () => resolve(false);
      } catch (e) { resolve(false); }
    });
  },
  _run(store, mode, fn) {
    return new Promise(resolve => {
      if (!Store.db) return resolve(undefined);
      try {
        const tx = Store.db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        tx.oncomplete = () => resolve(req ? req.result : undefined);
        tx.onerror = tx.onabort = () => resolve(undefined);
      } catch (e) { resolve(undefined); }
    });
  },
  get(store, key) { return Store._run(store, 'readonly', os => os.get(key)); },
  all(store) { return Store._run(store, 'readonly', os => os.getAll()); },
  keys(store) { return Store._run(store, 'readonly', os => os.getAllKeys()); },
  put(store, val) { return Store._run(store, 'readwrite', os => { os.put(val); return null; }); },
  putMany(store, arr) { return Store._run(store, 'readwrite', os => { arr.forEach(v => os.put(v)); return null; }); },
  del(store, key) { return Store._run(store, 'readwrite', os => { os.delete(key); return null; }); },
  clear(store) { return Store._run(store, 'readwrite', os => { os.clear(); return null; }); }
};

function saveMeta() { Store.put('kv', { key: 'meta', value: meta }); }

async function loadLocal() {
  await Store.open();
  const m = await Store.get('kv', 'meta');
  if (m && m.value) meta = Object.assign(meta, m.value);
  if (!meta.deviceId) { meta.deviceId = Math.random().toString(36).slice(2, 8); saveMeta(); }
  (await Store.all('people') || []).forEach(p => people.set(p.k, p));
  (await Store.all('marks') || []).forEach(m2 => marks.set(m2.k, m2));
  outbox = ((await Store.all('outbox')) || []).sort((a, b) => a.ts - b.ts);
}

/* ---------- time (formatted like the sheet: 10-Oct-2026 02:15:30 PM, in the server's time zone) ---------- */
function tzMin() { return meta.tzMin != null ? meta.tzMin : -new Date().getTimezoneOffset(); }
function fmtTime(ts) {
  const d = new Date((ts || Date.now()) + tzMin() * 60000);
  const p = n => String(n).padStart(2, '0');
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let h = d.getUTCHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return p(d.getUTCDate()) + '-' + M[d.getUTCMonth()] + '-' + d.getUTCFullYear() + ' ' + p(h) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) + ' ' + ap;
}
/** Event times are written by EventScanner.gs as "10 Oct 2026, 02:15:30 PM" (Asia/Dhaka). */
function fmtEvTime(ts) {
  const off = meta.tzEvMin != null ? meta.tzEvMin : tzMin();
  const d = new Date((ts || Date.now()) + off * 60000);
  const p = n => String(n).padStart(2, '0');
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let h = d.getUTCHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return p(d.getUTCDate()) + ' ' + M[d.getUTCMonth()] + ' ' + d.getUTCFullYear() + ', ' + p(h) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) + ' ' + ap;
}
function applyTz(d) {
  const a = parseTz(d && d.tz), b = parseTz(d && d.tzEv);
  if (a !== null) meta.tzMin = a;
  if (b !== null) meta.tzEvMin = b;
  saveMeta();
}
function parseTz(z) {
  const m = /^([+-])(\d{2})(\d{2})$/.exec(String(z || ''));
  return m ? (m[1] === '-' ? -1 : 1) * (parseInt(m[2], 10) * 60 + parseInt(m[3], 10)) : null;
}

/* ---------- local records ---------- */
const peekMark = k => marks.get(k);
function getMark(k) { let m = marks.get(k); if (!m) { m = { k, entry: '', ev: {} }; marks.set(k, m); } return m; }
function setEntry(k, t) { const m = getMark(k); m.entry = t || ''; Store.put('marks', m); }
function setEvent(k, en, t) { if (!en) return; const m = getMark(k); if (t) m.ev[en] = t; else delete m.ev[en]; Store.put('marks', m); }
function savePerson(p) { Store.put('people', p); }
function rowToPerson(r) {
  return { k: String(r[0]).toLowerCase(), id: String(r[0]), name: r[1] || '', degree: r[2] || '', session: r[3] || '',
    attendees: r[4] || '', guestType: r[5] || '', totalFee: r[6] || '', bloodGroup: r[7] || '', fid: r[8] || '', pv: r[9] ? 1 : 0 };
}
function resolveEv(n) {
  if (!n) return '';
  const hit = meta.events.find(e => e.norm === n) || meta.events.find(e => e.norm.indexOf(n) >= 0 || n.indexOf(e.norm) >= 0);
  return hit ? hit.norm : n;
}
function applyRecord(k, record) {
  (record || []).forEach(x => { if (x && x.time) setEvent(k, resolveEv(norm(x.label)), String(x.time)); });
}
function hasPending(k, kind, en) {
  return outbox.some(x => x.k === k && x.kind === kind && (kind === 'ENTRY' || x.en === en));
}
function learnEvent(label) {
  if (ROLE !== 'event' || !label) return;
  const n = resolveEv(norm(label));
  if (n && n !== evNorm) { evNorm = n; try { localStorage.setItem('duaaps_evnorm', evNorm); } catch (e) {} }
  if (!LABEL) { LABEL = String(label); }
}

/* ---------- network ---------- */
let netOk = true;
function setNet(ok) { netOk = ok; if (ok) { meta.lastContact = Date.now(); } updateChip(); }

async function api(action, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 15000);
  try {
    const res = await fetch(WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ action }, body)),
      signal: ctrl.signal
    });
    const raw = await res.text();
    try { return JSON.parse(raw); }
    catch (e) { const er = new Error('Server returned an unexpected page. Check the Apps Script deployment (Execute as: Me, Access: Anyone).'); er.name = 'BadResponse'; throw er; }
  } finally { clearTimeout(timer); }
}

/* ---------- snapshot (download everything) ---------- */
let snapBusy = false;
async function downloadSnapshot(showProgress, pinArg) {
  if (snapBusy) return;
  snapBusy = true;
  const pin = pinArg || PIN;
  try {
    let from = 2, first = null; const rows = [];
    while (from) {
      const d = await api('app_snapshot', { pin, from, dev: meta.deviceId }, 60000);
      if (d.bad_pin) throw new Error(d.message || 'Wrong PIN');
      if (!d.ok) throw new Error(d.message || 'Download failed');
      if (!first) first = d;
      d.rows.forEach(r => rows.push(r));
      if (showProgress) $('loginMsg').textContent = 'Downloading registrations… ' + rows.length + (d.total ? ' / ' + d.total : '');
      from = d.next || 0;
    }
    setNet(true);
    const newPeople = new Map(), newMarks = new Map();
    rows.forEach(r => {
      const p = rowToPerson(r); newPeople.set(p.k, p);
      if (r[10]) newMarks.set(p.k, { k: p.k, entry: String(r[10]), ev: {} });
    });
    const sm = first.marks || {};
    Object.keys(sm).forEach(id => {
      const k = id.toLowerCase();
      const m = newMarks.get(k) || { k, entry: '', ev: {} };
      Object.keys(sm[id]).forEach(lbl => { m.ev[norm(lbl)] = sm[id][lbl]; });
      newMarks.set(k, m);
    });
    // scans still waiting to be sent must survive the refresh
    outbox.forEach(x => {
      if (x.local !== 'OK') return;
      const m = newMarks.get(x.k) || { k: x.k, entry: '', ev: {} };
      if (x.kind === 'ENTRY') m.entry = m.entry || x.localTime; else if (x.en) m.ev[x.en] = m.ev[x.en] || x.localTime;
      newMarks.set(x.k, m);
    });
    people.clear(); newPeople.forEach((v, k) => people.set(k, v));
    marks.clear(); newMarks.forEach((v, k) => marks.set(k, v));
    meta.events = (first.events || []).map(l => ({ label: String(l), norm: norm(l) }));
    meta.seq = first.seq || 0;
    meta.snapshotAt = Date.now();
    if (ROLE === 'event') evNorm = resolveEv(norm(LABEL) || evNorm);
    saveMeta();
    await Store.clear('people'); await Store.putMany('people', [...people.values()]);
    await Store.clear('marks'); await Store.putMany('marks', [...marks.values()]);
    prefetchPhotos();
  } finally { snapBusy = false; updateChip(); }
}

/* ---------- photos (downloaded in the background, cached on the phone) ---------- */
const photoMem = new Map();
let photoKeys = new Set(), photoBusy = false, photoTotal = 0;
const photosWanted = () => { try { return localStorage.getItem('duaaps_photos') !== 'off'; } catch (e) { return true; } };
async function getPhoto(fid) {
  if (!fid) return null;
  if (photoMem.has(fid)) return photoMem.get(fid);
  const r = await Store.get('photos', fid);
  if (r && r.data) { rememberPhoto(fid, r.data); return r.data; }
  return null;
}
function rememberPhoto(fid, data) {
  photoMem.set(fid, data);
  if (photoMem.size > 40) photoMem.delete(photoMem.keys().next().value);
}
async function fetchPhotos(fids) {
  try {
    const d = await api('app_photos', { pin: PIN, ids: fids }, 25000);
    if (d && d.ok && d.photos) {
      for (const fid of Object.keys(d.photos)) {
        rememberPhoto(fid, d.photos[fid]); photoKeys.add(fid);
        Store.put('photos', { fid, data: d.photos[fid] });
      }
    }
  } catch (e) { /* offline: try again later */ }
}
async function prefetchPhotos() {
  if (photoBusy || !PIN || !photosWanted()) return;
  photoBusy = true;
  try {
    photoKeys = new Set((await Store.keys('photos')) || []);
    const need = [...new Set([...people.values()].map(p => p.fid).filter(f => f && !photoKeys.has(f)))];
    photoTotal = photoKeys.size + need.length;
    for (let i = 0; i < need.length && PIN && photosWanted();) {
      if (!netOk || isBusy) { await sleep(3000); continue; }
      await fetchPhotos(need.slice(i, i + 3));
      i += 3;
      await sleep(500);
    }
  } finally { photoBusy = false; }
}
async function showPhotoInto(imgId, fid) {
  const el = () => $(imgId);
  const put = d => { const e = el(); if (e && d) { e.src = d; e.style.display = 'block'; } };
  let d = await getPhoto(fid);
  if (d) return put(d);
  if (!netOk) return;
  await fetchPhotos([fid]);
  put(await getPhoto(fid));
}

/* ---------- outbox: scans waiting for the server ---------- */
let flushing = false, nextFlushAt = 0, flushFails = 0, lastScanAt = 0;
function enqueueScan(p, kind, local, localTime) {
  const item = { cid: newCid(), id: p.id, k: p.k, kind, ts: Date.now(), pin: PIN, en: kind === 'EVENT' ? evNorm : '', local, localTime };
  outbox.push(item);
  Store.put('outbox', item);
  lastScanAt = Date.now();
  updateChip();
  setTimeout(flushOutbox, 30);
}
function removeFromOutbox(cid) {
  outbox = outbox.filter(x => x.cid !== cid);
  Store.del('outbox', cid);
}
function addConflict(msg) {
  meta.conflicts.unshift({ t: fmtTime(), msg });
  if (meta.conflicts.length > 30) meta.conflicts.length = 30;
  saveMeta();
  toast(msg, 9000);
  beep(false);
}
/** Compare what the server decided with what this phone showed; the server always wins. */
function reconcile(item, r) {
  const p = people.get(item.k);
  const who = p ? p.name + ' (' + p.id + ')' : item.id;
  if (item.kind === 'ENTRY') {
    if (r.status === 'OK' || r.status === 'DUPLICATE') {
      const mine = peekMark(item.k);
      setEntry(item.k, r.time || (mine && mine.entry) || item.localTime);
      if (item.local === 'OK' && r.status === 'DUPLICATE') addConflict('⚠ ' + who + ' was already admitted at ' + r.time + ' on another device.');
    } else if (r.status === 'NOT_FOUND' && item.local === 'OK') {
      setEntry(item.k, '');
      addConflict('⚠ ' + who + ': ID not found on the server. Entry cancelled.');
    }
    return;
  }
  learnEvent(r.event);
  const en = item.en || evNorm;
  if (r.status === 'OK' || r.status === 'DUPLICATE') {
    applyRecord(item.k, r.record);
    setEvent(item.k, en, r.time || item.localTime);
    if (r.status === 'OK' && r.headline) { meta.okHeadline[en] = r.headline; saveMeta(); }
    if (item.local === 'OK' && r.status === 'DUPLICATE') addConflict('⚠ ' + who + ' already got ' + (r.event || LABEL) + ' at ' + r.time + ' on another device.');
  } else if (r.status === 'NOT_VERIFIED') {
    if (p) { p.pv = 0; savePerson(p); }
    if (item.local === 'OK') { setEvent(item.k, en, ''); addConflict('⚠ ' + who + ': PAYMENT NOT VERIFIED. Do not serve.'); }
  } else if (r.status === 'NOT_FOUND' && item.local === 'OK') {
    setEvent(item.k, en, '');
    addConflict('⚠ ' + who + ': ID not found on the server.');
  }
}
async function flushOutbox() {
  if (flushing || !PIN) return;
  if (!outbox.some(x => !x.dead)) return;
  flushing = true;
  try {
    while (outbox.some(x => !x.dead)) {
      const live = outbox.filter(x => !x.dead);
      const pin = live[0].pin;
      const batch = live.filter(x => x.pin === pin).slice(0, 10);
      let d;
      try {
        d = await api('app_sync', { pin, dev: meta.deviceId, scans: batch.map(x => ({ cid: x.cid, id: x.id, kind: x.kind, ts: x.ts })) }, 30000);
      } catch (e) { setNet(false); flushFails++; nextFlushAt = Date.now() + Math.min(30000, 2000 * Math.pow(2, flushFails - 1)); break; }
      setNet(true);
      if (d.bad_pin) {
        batch.forEach(x => { x.dead = true; Store.put('outbox', x); });
        if (pin === PIN) forceRelogin(d.message || 'PIN no longer valid');
        continue;
      }
      if (!d.ok || !d.results) { flushFails++; nextFlushAt = Date.now() + Math.min(30000, 2000 * Math.pow(2, flushFails - 1)); break; }
      let retry = false;
      d.results.forEach(r => {
        const item = batch.find(x => x.cid === r.cid);
        if (!item) return;
        if (r.status === 'ERROR' || r.status === 'BAD_PIN') { retry = true; return; }   // e.g. "System busy": keep and try again
        reconcile(item, r);
        removeFromOutbox(item.cid);
      });
      if (retry) { flushFails++; nextFlushAt = Date.now() + 3000; break; }
      flushFails = 0;
      if (typeof d.seq === 'number' && d.seq > meta.seq) { /* our own changes come back via delta: harmless */ }
    }
  } finally { flushing = false; updateChip(); }
}

/* ---------- live updates from the other phones ---------- */
let polling = false, lastPollAt = 0;
async function pollDelta() {
  if (polling || !PIN || snapBusy) return;
  polling = true; lastPollAt = Date.now();
  try {
    const d = await api('app_delta', { pin: PIN, since: meta.seq, dev: meta.deviceId }, 12000);
    setNet(true);
    if (d.bad_pin) { forceRelogin(d.message || 'PIN no longer valid'); return; }
    if (!d.ok) return;
    if (d.reset) { await downloadSnapshot(false); return; }
    (d.changes || []).forEach(c => {
      const k = String(c[0]).toLowerCase(), kind = c[1], t = c[2];
      if (kind === 'ENTRY') { if (!hasPending(k, 'ENTRY')) setEntry(k, t); }
      else { const en = resolveEv(norm(kind)); if (!hasPending(k, 'EVENT', en)) setEvent(k, en, t); }
    });
    meta.seq = d.seq; saveMeta();
    if (d.more) setTimeout(pollDelta, 50);
  } catch (e) { setNet(false); }
  finally { polling = false; }
}

function startTicker() {
  setInterval(() => {
    if (!PIN) return;
    const now = Date.now();
    if (outbox.some(x => !x.dead) && now >= nextFlushAt) flushOutbox();
    const iv = now - lastScanAt < 60000 ? POLL_ACTIVE : POLL_IDLE;
    if (now - lastPollAt >= iv && !flushing) pollDelta();
    if (now - meta.snapshotAt > SNAPSHOT_REFRESH && !snapBusy && netOk && !outbox.length) downloadSnapshot(false).catch(() => {});
    updateChip();
  }, 1000);
  window.addEventListener('online', () => { nextFlushAt = 0; flushFails = 0; flushOutbox(); pollDelta(); });
  window.addEventListener('offline', () => setNet(false));
}

/* ---------- scanning: decide instantly from the local copy ---------- */
function buildRecord(k) {
  const m = peekMark(k) || { entry: '', ev: {} };
  const rows = [{ label: 'Gate Entry', time: m.entry, cur: ROLE === 'gate' }];
  meta.events.forEach(e => rows.push({ label: e.label, time: m.ev[e.norm] || '', cur: ROLE === 'event' && e.norm === evNorm }));
  Object.keys(m.ev).forEach(n => { if (!meta.events.some(e => e.norm === n)) rows.push({ label: n, time: m.ev[n], cur: n === evNorm }); });
  return rows;
}
function vmGate(p, status, time) {
  return status === 'OK'
    ? { status: 'OK', headline: '✔ VALID - ENTRY ALLOWED', sub: 'Marked as entered at ' + esc(time), person: p, rec: false }
    : { status: 'DUPLICATE', headline: '✖ ALREADY SCANNED', sub: 'DO NOT ALLOW ENTRY · first scanned <b>' + esc(time) + '</b>', person: p, rec: false };
}
function vmEvent(p, status, time, headline) {
  const name = LABEL || 'Event';
  return status === 'OK'
    ? { status: 'OK', headline: '✔ ' + (headline || meta.okHeadline[evNorm] || (name.toUpperCase() + ' GIVEN')), sub: 'Recorded at ' + esc(time), person: p, rec: true }
    : { status: 'DUPLICATE', headline: '✖ ALREADY SCANNED', sub: esc(name) + ' was given at <b>' + esc(time) + '</b>', person: p, rec: true };
}

async function submitScan(rawText) {
  if (!PIN || isBusy) return;
  const id = extractId(rawText);
  if (!id) return;
  const k = id.toLowerCase();
  const p = people.get(k);
  // Not in the local list, or an event scan we cannot judge locally -> ask the server (authoritative)
  if (!p || (ROLE === 'event' && (p.pv === 0 || !evNorm))) return serverCheck(id, k, p);
  if (ROLE === 'gate') localGate(p); else localEvent(p);
}
function localGate(p) {
  const m = peekMark(p.k);
  if (m && m.entry) { enqueueScan(p, 'ENTRY', 'DUPLICATE', m.entry); showResult(vmGate(p, 'DUPLICATE', m.entry)); return; }
  const t = fmtTime();
  setEntry(p.k, t);
  enqueueScan(p, 'ENTRY', 'OK', t);
  showResult(vmGate(p, 'OK', t));
}
function localEvent(p) {
  const m = peekMark(p.k), prev = m && m.ev[evNorm];
  if (prev) { enqueueScan(p, 'EVENT', 'DUPLICATE', prev); showResult(vmEvent(p, 'DUPLICATE', prev)); return; }
  const t = fmtEvTime();
  setEvent(p.k, evNorm, t);
  enqueueScan(p, 'EVENT', 'OK', t);
  showResult(vmEvent(p, 'OK', t));
}

async function serverCheck(id, k, p) {
  isBusy = true;
  const kind = ROLE === 'gate' ? 'ENTRY' : 'EVENT';
  render({ status: 'PENDING', headline: 'Checking ' + id + '…', sub: p ? 'Verifying with the server' : 'Not in the local list yet' });
  try {
    const d = await api('app_sync', { pin: PIN, dev: meta.deviceId, wantPerson: true, scans: [{ cid: newCid(), id, kind, ts: Date.now() }] }, 9000);
    setNet(true);
    if (d.bad_pin) { forceRelogin(d.message || 'PIN no longer valid'); return; }
    if (!d.ok || !d.results || !d.results[0]) throw new Error(d.message || 'Server error');
    const r = d.results[0];
    if (r.person) { p = rowToPerson(r.person); people.set(p.k, p); savePerson(p); }
    if (kind === 'EVENT') learnEvent(r.event);
    let vm;
    if (r.status === 'OK' || r.status === 'DUPLICATE') {
      if (p) { p.pv = 1; savePerson(p); }
      if (kind === 'ENTRY') setEntry(p ? p.k : k, r.time);
      else { applyRecord(p ? p.k : k, r.record); setEvent(p ? p.k : k, evNorm, r.time); if (r.status === 'OK' && r.headline) { meta.okHeadline[evNorm] = r.headline; saveMeta(); } }
      vm = kind === 'ENTRY' ? vmGate(p, r.status, r.time) : vmEvent(p, r.status, r.time, r.headline);
    } else if (r.status === 'NOT_VERIFIED') {
      if (p) { p.pv = 0; savePerson(p); }
      vm = { status: 'NOT_VERIFIED', headline: '⚠ PAYMENT NOT VERIFIED', sub: 'Do not serve - send to the help desk', person: p, rec: kind === 'EVENT' };
    } else if (r.status === 'NOT_FOUND') {
      vm = { status: 'NOT_FOUND', headline: '✖ INVALID SLIP', sub: esc(r.message || ('ID ' + id + ' not found')) };
    } else {
      vm = { status: 'ERROR', headline: '✖ SCAN ERROR', sub: esc(r.message || '') };
    }
    showResult(vm);
  } catch (err) {
    setNet(false);
    showResult(p
      ? { status: 'WARN', headline: '⚠ CANNOT VERIFY (OFFLINE)', sub: 'Payment status unknown - send to the help desk', person: p, rec: false }
      : { status: 'WARN', headline: '⚠ ID NOT IN THIS PHONE\'S LIST', sub: 'Connect to the internet and scan again' });
  } finally { isBusy = false; }
}

/* ---------- result sheet ---------- */
let renderToken = 0;
function render(vm) {
  const token = ++renderToken;
  const cls = { OK: 'ok', DUPLICATE: 'bad', NOT_FOUND: 'bad' }[vm.status] || 'warn';
  let html = '<div class="banner ' + cls + '">' + esc(vm.headline) + (vm.sub ? '<small>' + vm.sub + '</small>' : '') + '</div>';
  const p = vm.person;
  if (p) {
    if (ROLE === 'gate') {
      html += '<div class="badge-info-box">Guest type: <b>' + esc(p.guestType || '-') + '</b><br>' +
        'Total paid: <b>' + esc(p.totalFee || '0') + ' BDT</b><br>Attendees: <b>' + esc(p.attendees || '-') + '</b></div>';
    }
    if (vm.rec) {
      html += '<div class="record-list">';
      buildRecord(p.k).forEach(it => {
        html += '<div class="record-row' + (it.cur ? ' active-row' : '') + '"><span>' + esc(it.label) + '</span>' +
          (it.time ? '<span class="status-yes">✔ ' + esc(it.time) + '</span>' : '<span class="status-no">— Not yet</span>') + '</div>';
      });
      html += '</div>';
    }
    html += '<div class="attendee-card">' + (p.fid ? '<img id="resPhoto" alt="" style="display:none">' : '') +
      '<div class="name">' + esc(p.name) + '</div><div class="meta">' + esc(p.id) +
      (ROLE === 'gate'
        ? (p.degree ? ' · ' + esc(p.degree) : '') + (p.session ? ' (' + esc(p.session) + ')' : '') + (p.bloodGroup ? ' · Blood ' + esc(p.bloodGroup) : '')
        : (p.attendees ? ' · ' + esc(p.attendees) + ' attendee(s)' : '')) +
      '</div></div>';
  }
  $('resultContent').innerHTML = html;
  $('result').classList.add('show');
  if (p && p.fid && token === renderToken) showPhotoInto('resPhoto', p.fid);
}
function showResult(vm) {
  render(vm);
  if (vm.status === 'OK') { beep(true); autoHide(turboMode ? 1400 : 2500); }
  else if (vm.status === 'DUPLICATE') { beep(false); autoHide(turboMode ? 2200 : 3800); }
  else { beep(false); autoHide(3800); }
}
let hideTimer = null;
function autoHide(ms) {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { $('result').classList.remove('show'); }, ms);
}
let toastTimer = null;
function toast(msg, ms) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms || 5000);
}

/* ---------- sync indicator + panel ---------- */
function updateChip() {
  const el = $('syncChip'); if (!el) return;
  const pend = outbox.filter(x => !x.dead).length;
  const online = netOk && navigator.onLine !== false;
  let txt, cls;
  if (!online) { txt = '○ Offline' + (pend ? ' · ' + pend + ' saved' : ''); cls = 'off'; }
  else if (pend) { txt = '↑ Syncing ' + pend; cls = 'pend'; }
  else { txt = '● Live'; cls = 'live'; }
  el.textContent = txt; el.className = 'sync-chip ' + cls;
}
function openPanel() {
  const pend = outbox.filter(x => !x.dead).length, dead = outbox.filter(x => x.dead).length;
  const ago = meta.lastContact ? Math.max(0, Math.round((Date.now() - meta.lastContact) / 1000)) + ' s ago' : 'never';
  let h = '<h2>Sync status</h2><div class="panel-grid">' +
    '<div>Scanner</div><b>' + esc(ROLE === 'gate' ? 'ENTRY GATE' : (LABEL || 'Event')) + '</b>' +
    '<div>Registrations on this phone</div><b>' + people.size + '</b>' +
    '<div>Waiting to upload</div><b>' + pend + (dead ? ' (+' + dead + ' need re-login)' : '') + '</b>' +
    '<div>Last server contact</div><b>' + esc(ago) + '</b>' +
    '<div>Photos saved</div><b>' + photoKeys.size + ' / ' + photoTotal + (photosWanted() ? '' : ' (off)') + '</b></div>';
  if (meta.conflicts.length) {
    h += '<div class="panel-sub">Recent conflicts</div><div class="panel-list">' + meta.conflicts.slice(0, 8).map(c => '<div><small>' + esc(c.t) + '</small><br>' + esc(c.msg) + '</div>').join('') + '</div>';
  }
  $('panelBody').innerHTML = h;
  $('photoToggle').textContent = photosWanted() ? 'Photo download: ON' : 'Photo download: OFF';
  $('syncPanel').style.display = 'flex';
}

/* ---------- login / session ---------- */
function forceRelogin(msg) {
  stopCamera();
  PIN = ''; ROLE = '';
  try { localStorage.removeItem('duaaps_scan_pin'); } catch (e) {}
  $('result').classList.remove('show');
  $('login').style.display = 'flex';
  $('loginMsg').textContent = msg || '';
  updateChip();
}
function startSession(pin, role, label) {
  PIN = pin; ROLE = role; LABEL = label || '';
  if (role === 'event') {
    let saved = ''; try { saved = localStorage.getItem('duaaps_evnorm') || ''; } catch (e) {}
    evNorm = resolveEv(norm(LABEL)) || saved;
  } else evNorm = '';
  try {
    localStorage.setItem('duaaps_scan_pin', pin);
    localStorage.setItem('duaaps_role', role);
    localStorage.setItem('duaaps_label', LABEL);
    if (evNorm) localStorage.setItem('duaaps_evnorm', evNorm);
  } catch (e) {}
  EVT = role === 'gate' ? 'ENTRY GATE' : (LABEL || 'EVENT');
  $('evName').textContent = EVT.toUpperCase();
  $('login').style.display = 'none';
  wantScanning = true;
  lastPollAt = 0; nextFlushAt = 0;
  setTimeout(startCamera, 100);
  updateChip();
  flushOutbox();
  prefetchPhotos();
}

$('loginBtn').onclick = doLogin;
$('pin').onkeydown = e => { if (e.key === 'Enter') doLogin(); };

async function doLogin() {
  const p = $('pin').value.trim();
  if (!p) return;
  $('loginBtn').disabled = true;
  $('loginMsg').textContent = 'Authenticating PIN…';
  try {
    const d = await api('app_login', { pin: p, dev: meta.deviceId }, 20000);
    if (d.ok === undefined) { $('loginMsg').textContent = 'The server is not updated yet: add AppApi.gs and the one-line route in doPost (see apps-script/SETUP.md).'; return; }
    if (!d.ok) { $('loginMsg').textContent = d.message || 'Incorrect PIN'; return; }
    setNet(true);
    applyTz(d);
    if (people.size === 0 || Date.now() - meta.snapshotAt > 30 * 60 * 1000) {
      $('loginMsg').textContent = 'Downloading registrations…';
      try { await downloadSnapshot(true, p); }
      catch (e) {
        if (people.size === 0) { $('loginMsg').textContent = 'Could not download the list (' + e.message + '). Every scan will be checked on the server instead.'; await sleep(1800); }
      }
    }
    $('pin').value = ''; $('loginMsg').textContent = '';
    startSession(p, d.role, d.label);
  } catch (err) {
    // Offline unlock: same PIN as last time and the list is already on this phone
    let sp = '', sr = '', sl = '';
    try { sp = localStorage.getItem('duaaps_scan_pin') || ''; sr = localStorage.getItem('duaaps_role') || ''; sl = localStorage.getItem('duaaps_label') || ''; } catch (e) {}
    if (err.name !== 'BadResponse' && people.size > 0 && sp === p && sr) { $('pin').value = ''; $('loginMsg').textContent = ''; setNet(false); startSession(p, sr, sl); }
    else $('loginMsg').textContent = err.name === 'AbortError' ? 'Timed out. Check the internet connection.' : (err.name === 'BadResponse' ? err.message : 'Network error: ' + (err.message || err) + '. Check the internet connection.');
  } finally { $('loginBtn').disabled = false; }
}

$('changeBtn').onclick = () => {
  stopCamera();
  PIN = ''; ROLE = '';
  try { localStorage.removeItem('duaaps_scan_pin'); } catch (e) {}
  $('result').classList.remove('show');
  $('login').style.display = 'flex';
  $('pin').focus();
  updateChip();
};

/* ---------- misc buttons ---------- */
$('manualBtn').onclick = () => {
  const entered = prompt('Enter Registration ID manually:');
  if (entered && entered.trim()) submitScan(entered.trim());
};
$('grantPermBtn').onclick = async () => { $('permModal').style.display = 'none'; await startCamera(); };
$('openSettingsBtn').onclick = async () => {
  if (isNative && BarcodeScanner) {
    try { await BarcodeScanner.openSettings(); return; } catch (e) { console.warn('openSettings failed:', e); }
  }
  alert('On your Android device:\n1. Open Settings -> Apps -> DUAAPS Scanner\n2. Tap "Permissions"\n3. Tap "Camera"\n4. Select "Allow only while using the app"');
};
$('closePermBtn').onclick = () => { $('permModal').style.display = 'none'; };

$('syncChip').onclick = openPanel;
$('closePanelBtn').onclick = () => { $('syncPanel').style.display = 'none'; };
$('syncNowBtn').onclick = async () => { nextFlushAt = 0; flushFails = 0; await flushOutbox(); await pollDelta(); openPanel(); };
$('redownloadBtn').onclick = async () => {
  $('panelBody').innerHTML = '<h2>Downloading…</h2>';
  try { await downloadSnapshot(false); } catch (e) { toast('Download failed: ' + e.message, 5000); }
  openPanel();
};
$('photoToggle').onclick = () => {
  try { localStorage.setItem('duaaps_photos', photosWanted() ? 'off' : 'on'); } catch (e) {}
  if (photosWanted()) prefetchPhotos();
  openPanel();
};

/* ---------- zoom (like the built-in scanner: pinch, or tap the 1x button) ---------- */
let zoomMin = 1, zoomMax = 1, zoomNow = 1, zoomBusy = false;
async function initZoom() {
  try {
    zoomMin = (await BarcodeScanner.getMinZoomRatio()).zoomRatio || 1;
    zoomMax = (await BarcodeScanner.getMaxZoomRatio()).zoomRatio || 1;
  } catch (e) { zoomMin = zoomMax = 1; }
  zoomNow = zoomMin;
  $('zoomBtn').style.display = zoomMax > zoomMin + 0.05 ? 'block' : 'none';
  let saved = 0; try { saved = parseFloat(localStorage.getItem('duaaps_zoom')) || 0; } catch (e) {}
  if (saved > zoomMin + 0.05) await setZoom(saved); else updateZoomLabel();
}
function updateZoomLabel() { $('zoomBtn').textContent = (Math.round(zoomNow * 10) / 10) + '×'; }
async function setZoom(z) {
  z = Math.max(zoomMin, Math.min(zoomMax, z));
  if (zoomBusy || !nativeScanning) return;
  zoomBusy = true;
  try { await BarcodeScanner.setZoomRatio({ zoomRatio: z }); zoomNow = z; updateZoomLabel(); try { localStorage.setItem('duaaps_zoom', String(z)); } catch (e) {} }
  catch (e) { /* ignore */ }
  zoomBusy = false;
}
$('zoomBtn').onclick = () => {
  const steps = [zoomMin, 2, 3, 4].filter((s, i) => i === 0 || s <= zoomMax);
  const next = steps.find(s => s > zoomNow + 0.15);
  setZoom(next !== undefined ? next : steps[0]);
};
let pinchStart = 0, pinchZoom0 = 1;
const touchDist = e => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
document.addEventListener('touchstart', e => { if (e.touches.length === 2) { pinchStart = touchDist(e); pinchZoom0 = zoomNow; } }, { passive: true });
document.addEventListener('touchmove', e => { if (e.touches.length === 2 && pinchStart) setZoom(pinchZoom0 * touchDist(e) / pinchStart); }, { passive: true });
document.addEventListener('touchend', e => { if (e.touches.length < 2) pinchStart = 0; }, { passive: true });

/* ---------- start-up ---------- */
window.addEventListener('DOMContentLoaded', async () => {
  await loadLocal();
  ensureCameraPermission();      // asked once, at launch, independent of login
  startTicker();
  updateChip();
  let sp = '', sr = '', sl = '';
  try { sp = localStorage.getItem('duaaps_scan_pin') || ''; sr = localStorage.getItem('duaaps_role') || ''; sl = localStorage.getItem('duaaps_label') || ''; } catch (e) {}
  if (sp && sr && people.size > 0) {
    startSession(sp, sr, sl);    // works offline: the list is already on the phone
    api('app_login', { pin: sp, dev: meta.deviceId }, 15000).then(d => {
      setNet(true);
      if (d.bad_pin) forceRelogin(d.message || 'PIN no longer valid');
      else if (d.ok) { applyTz(d); if (d.label && !LABEL) { LABEL = d.label; } }
    }).catch(() => setNet(false));
  } else if (sp) { $('pin').value = sp; doLogin(); }
});

// Coming back from Android Settings / another app: retry the camera, sync straight away
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !PIN) return;
  nextFlushAt = 0; flushOutbox(); pollDelta();
  if (!wantScanning) return;
  const modal = $('permModal');
  const modalOpen = modal && modal.style.display === 'flex';
  if (modalOpen || !nativeScanning) startCamera();
});
