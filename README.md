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

## Changes in 1.0.2
- Camera permission is requested at launch, no longer hidden behind a successful PIN login.
- Login shows a clear message when Apps Script returns a non-JSON page (deployment not set to "Anyone").
- Removed the WebView camera fallback inside the app (Android WebView has no BarcodeDetector, so it showed a
  live preview that never scanned). Scanner errors now show a tap-to-retry message.
- Same QR held in view no longer flips from GRANTED to ALREADY SCANNED (presence-based debounce).
- Uses the current `barcodesScanned` event and listens for `scanError`.
- Torch button only changes state if the flashlight call succeeds.
- Removed `server.cleartext` (endpoint is https). versionCode 3 / versionName 1.0.2.

## Recommended on the Apps Script side (not part of this zip)
- Add a failed-PIN lockout (e.g. 5 wrong tries -> block for a few minutes) and use a 6-digit PIN or longer;
  the script URL can be extracted from the APK and the PIN is short.
- Deploy as: Execute as **Me**, Who has access **Anyone**.
