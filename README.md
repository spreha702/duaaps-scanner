# DUAAPS Scanner – Android (Capacitor + ML Kit)

## Build the APK

Requirements: Node 18+/20, JDK 17, Android SDK (Android Studio installs it).

    npm install
    npx cap sync android
    cd android && ./gradlew assembleDebug        (Windows: gradlew.bat assembleDebug)

or just run `./build-apk.sh` (`build-apk.bat` on Windows).
APK: `android/app/build/outputs/apk/debug/app-debug.apk`

GitHub Actions: push to `main` and download the `duaaps-scanner-debug-apk` artifact.
Commit `package-lock.json` (included) – the workflow uses `npm ci`.

## Camera permission - how it works
- The camera permission is requested ONCE, at app launch (`ensureCameraPermission()` in `www/app.js`),
  independent of the PIN login. `startCamera()` awaits the same shared request, so Android never sees two
  overlapping permission dialogs (a second concurrent request is auto-denied).
- If it was denied before: uninstall the old app first (updating in place keeps the old "denied" state), or
  Settings > Apps > DUAAPS Scanner > Permissions > Camera > Allow. The in-app "Open App Settings" button does
  this, and the scanner restarts automatically when you return.
- To see what is happening on a phone: connect by USB, open `chrome://inspect` on a PC, and inspect the WebView.
  The app logs `Camera permission status:` there.

## Changes in 1.1.1
- Backend tightened to your real files (Code.gs / EntryScan.gs / EventScanner.gs): exact "Payment Verification" rule,
  exact "Event Tracking" columns, event times in the same format and time zone EventScanner.gs writes.
- Root cause of the "2026" problem: the old login accepted the gate PIN, but the first scan went to `scnProcess`, which
  only knows event PINs, so the app got "Wrong PIN" and returned to the login screen. Gate scans now use `app_sync`.

## Changes in 1.1.0 (offline-first)
- **Gate PIN now works** (the old login only knew the event PINs). One login screen, both kinds of PIN.
- **Local copy of the server data**: registrations + who has entered / got breakfast, lunch, snacks, gift, lottery,
  stored on the phone (IndexedDB). Scan results are instant and work with a weak or missing connection.
- **Background sync**: every scan is saved locally, queued, and uploaded automatically; the queue survives app restarts.
  A live indicator (Live / Syncing / Offline) shows the state; tap it for details.
- **Real-time updates between phones**: each phone polls the server every 4-12 s for changes. The first scan that
  reaches the server wins; a phone that lost the race shows a conflict warning.
- Repeat scan -> "ALREADY SCANNED" + the exact time it was first recorded (gate entry and every event).
- **Better QR reading**: camera analysis raised from the plugin's low default to 1080p (patch in `patches/`, applied
  automatically by `npm install` / `npm ci`), plus pinch-to-zoom and a 1x/2x/3x button.
- Photos are cached on the phone in the background.
- Backend: see `apps-script/SETUP.md` (new file `AppApi.gs`). **The app cannot log in until the backend is updated.**

## Changes in 1.0.2
- Camera permission is requested at launch, no longer hidden behind a successful PIN login.
- Removed the WebView camera fallback inside the app (Android WebView cannot decode QR codes).
- Same QR held in view no longer flips from GRANTED to ALREADY SCANNED.
- Removed `server.cleartext`.
