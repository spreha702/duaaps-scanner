@echo off
echo === Building DUAAPS Native Android Scanner APK ===
call npm install
call npx cap add android || rem
call npx cap sync android
cd android
call gradlew assembleDebug
echo.
echo SUCCESS! APK built at:
echo android\app\build\outputs\apk\debug\app-debug.apk
pause
