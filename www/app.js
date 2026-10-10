/**
 * DUAAPS Scanner Native App Logic
 * Ultra-fast verification (<50ms local check), instant startup camera permission,
 * and seamless fallback between Capacitor ML Kit and browser engines.
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

// In-Memory Fast Cache for 0ms Duplicate Check
const localScanCache = new Map();

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

// ULTRA-FAST VERIFICATION ENGINE
async function submitScan(rawText) {
  if (isBusy || !PIN) return;
  isBusy = true;

  const id = extractId(rawText);

  // 1. INSTANT LOCAL CACHE CHECK (<1ms): Did this ticket already enter today?
  if (localScanCache.has(id.toLowerCase())) {
    const cachedTime = localScanCache.get(id.toLowerCase());
    renderResult({
      status: 'DUPLICATE',
      headline: 'ALREADY SCANNED',
      event: 'ENTRY GATE',
      time: cachedTime,
      message: 'Already admitted today at ' + cachedTime + ' (Instant local detection)'
    });
    isBusy = false;
    return;
  }

  // 2. Snappy Optimistic UI
  const sheet = $('result');
  const content = $('resultContent');
  content.innerHTML = '<div style="text-align:center;padding:22px;color:#64748b;font-weight:700">⚡ Verifying ID: ' + esc(id) + '…</div>';
  sheet.classList.add('show');

  // 3. High-Speed API Call with Fast Timeout & Keepalive
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 6000); // 6s network timeout

  try {
    const res = await fetch(WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'scan', pin: PIN, id: id }),
      signal: controller.signal,
      keepalive: true
    });
    clearTimeout(timeoutId);

    const data = await res.json();

    // Cache successful scans locally to make subsequent duplicate lookups 0ms instant!
    if (data.status === 'OK') {
      const nowStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      localScanCache.set(id.toLowerCase(), nowStr);
    }

    renderResult(data);
  } catch (err) {
    clearTimeout(timeoutId);
    renderResult({
      status: 'ERROR',
      message: err.name === 'AbortError' ? 'Network timeout. Check Wi-Fi/4G connection.' : err.message || String(err)
    });
  }

  isBusy = false;
}

function renderResult(r) {
  const sheet = $('result');
  const content = $('resultContent');

  if (r.error) {
    content.innerHTML = '<div class="banner warn">' + esc(r.error) + '</div>';
    beep(false);
    autoHide(3500);
    return;
  }

  let bannerClass = 'bad';
  let heading = '';
  let sub = '';

  if (r.status === 'OK') {
    bannerClass = 'ok';
    heading = '✔ ' + esc(r.headline || (r.event + ' GRANTED'));
    sub = 'Recorded at ' + esc(r.time || 'now');
    beep(true);
    // Snappy auto-hide in turbo mode
    autoHide(turboMode ? 1200 : 2500);
  } else if (r.status === 'DUPLICATE') {
    heading = '✖ ' + esc(r.headline || 'ALREADY SCANNED');
    sub = esc(r.event || 'Entry') + ' first at <b>' + esc(r.time) + '</b>';
    beep(false);
    autoHide(turboMode ? 1800 : 3800);
  } else if (r.status === 'NOT_VERIFIED') {
    bannerClass = 'warn';
    heading = '⚠ PAYMENT UNCONFIRMED';
    sub = esc(r.message || 'Fee verification pending');
    beep(false);
    autoHide(4000);
  } else if (r.status === 'NOT_FOUND') {
    heading = '✖ ID NOT FOUND';
    sub = esc(r.message || 'Record not in registered database');
    beep(false);
    autoHide(3500);
  } else if (r.status === 'BAD_PIN') {
    heading = '✖ INVALID PIN';
    sub = esc(r.message);
    beep(false);
    setTimeout(() => {
      stopCamera();
      PIN = '';
      sheet.classList.remove('show');
      $('login').style.display = 'flex';
      $('loginMsg').textContent = r.message;
    }, 600);
    return;
  } else {
    heading = '✖ SCAN ERROR';
    sub = esc(r.message || '');
    beep(false);
    autoHide(3000);
  }

  let html = '<div class="banner ' + bannerClass + '">' + heading + '<small>' + sub + '</small></div>';

  if (r.guestType !== undefined) {
    html += '<div class="badge-info-box">' +
      'Guest: <b>' + esc(r.guestType || '-') + '</b><br>' +
      'Fee: <b>' + esc(r.totalFee || '0') + ' BDT</b><br>' +
      'Attendees: <b>' + esc(r.attendees || '1') + ' person(s)</b>' +
      '</div>';
  }

  if (r.photo) {
    html += '<div class="attendee-card"><img src="' + esc(r.photo) + '" alt="Attendee Photo"></div>';
  }

  if (r.person) {
    html += '<div class="attendee-card">' +
      '<div class="name">' + esc(r.person.name) + '</div>' +
      '<div class="meta">' + esc(r.person.id) +
      (r.person.degree ? ' · ' + esc(r.person.degree) : '') +
      (r.person.membership ? ' · ' + esc(r.person.membership) : '') +
      '</div></div>';
  } else if (r.name) {
    html += '<div class="attendee-card">' +
      '<div class="name">' + esc(r.name) + '</div>' +
      '<div class="meta">' + esc(r.id) +
      (r.degree ? ' · ' + esc(r.degree) : '') +
      (r.session ? ' (' + esc(r.session) + ')' : '') +
      (r.bloodGroup ? ' · Blood ' + esc(r.bloodGroup) : '') +
      '</div></div>';
  }

  if (r.record && r.record.length) {
    html += '<div class="record-list">';
    r.record.forEach(item => {
      html += '<div class="record-row' + (item.key === r.current ? ' active-row' : '') + '">' +
        '<span>' + esc(item.label) + '</span>' +
        (item.time ? '<span class="status-yes">✔ ' + esc(item.time) + '</span>' : '<span class="status-no">— Not yet</span>') +
        '</div>';
    });
    html += '</div>';
  }

  content.innerHTML = html;
  sheet.classList.add('show');
}

let hideTimer = null;
function autoHide(ms) {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    $('result').classList.remove('show');
  }, ms);
}

// Manual Input Dialog
$('manualBtn').onclick = () => {
  const entered = prompt('Enter Registration ID manually:');
  if (entered && entered.trim()) {
    submitScan(entered.trim());
  }
};

// Grant Permission Actions
$('grantPermBtn').onclick = async () => {
  $('permModal').style.display = 'none';
  await startCamera();
};

$('openSettingsBtn').onclick = async () => {
  if (isNative && BarcodeScanner) {
    try {
      await BarcodeScanner.openSettings();
      return;
    } catch (e) {
      console.warn('BarcodeScanner.openSettings failed:', e);
    }
  }
  alert('On your Android device:\n1. Open Settings -> Apps -> DUAAPS Scanner\n2. Tap "Permissions"\n3. Tap "Camera"\n4. Select "Allow only while using the app"');
};

const closeBtn = $('closePermBtn');
if (closeBtn) {
  closeBtn.onclick = () => {
    $('permModal').style.display = 'none';
  };
}

// PIN Unlock Flow
$('loginBtn').onclick = doLogin;
$('pin').onkeydown = e => { if (e.key === 'Enter') doLogin(); };

async function doLogin() {
  const p = $('pin').value.trim();
  if (!p) return;
  $('loginBtn').disabled = true;
  $('loginMsg').textContent = 'Authenticating PIN…';

  try {
    const res = await fetch(WEBAPP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'login', pin: p })
    });
    const raw = await res.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      $('loginMsg').textContent = 'Server returned an unexpected response. Check the Apps Script deployment (Execute as: Me, Access: Anyone).';
      $('loginBtn').disabled = false;
      return;
    }

    if (!data.ok) {
      $('loginMsg').textContent = data.message || 'Incorrect Event PIN';
      $('loginBtn').disabled = false;
      return;
    }
    PIN = p;
    EVT = data.label || 'ANNUAL REUNION';
    $('pin').value = '';
    $('loginMsg').textContent = '';
    $('evName').textContent = EVT.toUpperCase();
    $('login').style.display = 'none';
    try { localStorage.setItem('duaaps_scan_pin', PIN); } catch (e) {}
    wantScanning = true;
    setTimeout(startCamera, 100);
  } catch (err) {
    $('loginMsg').textContent = 'Network error: ' + (err.message || err) + '. Check your internet connection.';
  }
  $('loginBtn').disabled = false;
}

$('changeBtn').onclick = () => {
  stopCamera();
  PIN = '';
  try { localStorage.removeItem('duaaps_scan_pin'); } catch (e) {}
  $('result').classList.remove('show');
  $('login').style.display = 'flex';
  $('pin').focus();
};

// App launch: ask for camera permission right away (independent of login, so a slow or failing
// server can never hide the permission prompt), then auto-login with the saved PIN.
window.addEventListener('DOMContentLoaded', () => {
  ensureCameraPermission();
  try {
    const saved = localStorage.getItem('duaaps_scan_pin');
    if (saved) {
      $('pin').value = saved;
      doLogin();
    }
  } catch (e) {}
});

// Coming back from Android Settings / another app: retry the camera automatically
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !PIN || !wantScanning) return;
  const modal = $('permModal');
  const modalOpen = modal && modal.style.display === 'flex';
  if (modalOpen || !nativeScanning) startCamera();
});
