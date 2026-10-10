@echo off
echo === Building DUAAPS Scanner debug APK ===
call npm install
call npx cap sync android
cd android
call gradlew.bat assembleDebug
echo.
echo APK: android\app\build\outputs\apk\debug\app-debug.apk
pause
