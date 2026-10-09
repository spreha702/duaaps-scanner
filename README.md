# DUAAPS Scanner - Native Android APK Project

High-performance native Android QR Scanner powered by **Capacitor** and **Google ML Kit Barcode Scanning**.

---

## ⚡ Why This Beats Any Web PWA
- **ML Kit Hardware NPU Acceleration:** Decodes QR codes at sensor speed without JavaScript lag.
- **Dynamic Auto-Zoom:** Hardware automatically zooms in on distant or small QR codes.
- **Continuous Focus:** Camera decodes halfway through focusing without waiting for full lock.
- **Zero-lag Background:** The native CameraX feed renders directly underneath the transparent WebView.

---

## 🚀 How to Build the APK (2 Easy Ways)

### Option 1: Automatic Cloud Build (No Android Studio Needed!)
1. Push this folder to a GitHub repository (Public or Private).
2. Go to **Actions** tab in GitHub.
3. The workflow `.github/workflows/build-apk.yml` will run automatically.
4. Click the finished run and download `duaaps-scanner-debug-apk.zip`.
5. Extract and install `app-debug.apk` directly on your phone!

---

### Option 2: Build Locally with Android Studio
1. Open terminal in this folder:
   ```bash
   npm install
   npx cap add android
   npx cap sync android
   ```
2. Open in Android Studio:
   ```bash
   npx cap open android
   ```
3. In Android Studio, click **Build > Build Bundle(s) / APK(s) > Build APK(s)**.
4. The file will be generated at:
   `android/app/build/outputs/apk/debug/app-debug.apk`
5. Transfer to phone via WhatsApp, Google Drive, or USB to install.

---

## ⚙️ Configuration
- **Backend URL:** Configured in `www/app.js` (`WEBAPP_URL`).
- **Package Name:** `com.duaaps.scanner`
- **Permissions:** Already pre-configured in `AndroidManifest.xml` with Camera and Network.
