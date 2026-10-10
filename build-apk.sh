#!/usr/bin/env bash
set -e
echo "=== Building DUAAPS Scanner debug APK ==="
npm install
npx cap sync android
cd android
chmod +x gradlew
./gradlew assembleDebug
echo ""
echo "SUCCESS! APK: android/app/build/outputs/apk/debug/app-debug.apk"
