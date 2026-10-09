#!/usr/bin/env bash
echo "=== Building DUAAPS Native Android Scanner APK ==="
set -e

npm install
npx cap add android || true
npx cap sync android

cd android
chmod +x gradlew
./gradlew assembleDebug

echo ""
echo "SUCCESS! APK built at:"
echo "android/app/build/outputs/apk/debug/app-debug.apk"
