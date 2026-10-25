#!/bin/bash
# Inside the emulator runner: install the latest Chromium, put test photos in
# the gallery, serve the repo to the device and drive the real file pickers.
API=$1
mkdir -p out
exec > >(tee out/run.txt) 2>&1
set -x
adb shell getprop ro.build.version.release
adb shell settings put global package_verifier_enable 0 || true
adb shell settings put global hide_error_dialogs 1 || true
adb shell settings put secure anr_show_background 0 || true
# let the freshly booted system settle, then clear any dialog
sleep 45
adb shell input keyevent KEYCODE_HOME

# latest Chromium x86_64 Android build
REV=$(curl -s https://commondatastorage.googleapis.com/chromium-browser-snapshots/AndroidDesktop_x64/LAST_CHANGE)
curl -s "https://storage.googleapis.com/storage/v1/b/chromium-browser-snapshots/o?prefix=AndroidDesktop_x64/$REV/&fields=items(name,size)" | tee out/chromium-files.json | head -c 3000; echo
ZIP=$(grep -o '"name": *"[^"]*\.zip"' out/chromium-files.json | sed 's/.*"\(AndroidDesktop[^"]*\)"/\1/' | grep -iE "chrome-android|apks|chrome" | head -1)
echo "zip: $ZIP"
if [ -n "$ZIP" ]; then
  curl -s -o /tmp/chromium.zip "https://storage.googleapis.com/chromium-browser-snapshots/$ZIP" && unzip -q -o /tmp/chromium.zip -d /tmp/chromium && find /tmp/chromium -name "*.apk" -o -name "*.apks" | head -20 | tee out/apks.txt
  APK=$(find /tmp/chromium -iname "ChromePublic.apk" | head -1)
  [ -z "$APK" ] && APK=$(find /tmp/chromium -iname "Chrom*.apk" | head -1)
  [ -n "$APK" ] && adb install -r -g "$APK" | tee out/install.txt
fi
adb shell pm list packages | grep -iE "chrom" | tee out/browsers.txt
adb shell dumpsys package org.chromium.chrome | grep -E "versionName" | head -1 | tee -a out/browsers.txt
adb shell dumpsys package com.android.chrome | grep -E "versionName" | head -1 | tee -a out/browsers.txt

# gallery photos, with and without GPS location in EXIF
python3 tests/android/make-photos.py tests/android/src.jpg /tmp/photos
adb shell mkdir -p /sdcard/DCIM/Camera
for f in DIVE_NOGPS_1 DIVE_GPS_1 DIVE_NOGPS_2 DIVE_GPS_2; do
  adb push /tmp/photos/$f.jpg /sdcard/DCIM/Camera/$f.jpg
  adb shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/DCIM/Camera/$f.jpg
  sleep 1
done
adb shell content query --uri content://media/external/images/media --projection _id:_display_name:date_modified | tee out/mediastore.txt

# serve the repo on the device's localhost
python3 -m http.server 8000 >/dev/null 2>&1 &
adb reverse tcp:8000 tcp:8000
npm i --no-save --silent playwright@1.48.2 >/dev/null 2>&1
for PKG in org.chromium.chrome com.android.chrome; do
  adb shell pm list packages | grep -q "$PKG" || continue
  PKG=$PKG node tests/android/drive.mjs out/$PKG tests/android/scenarios.json || true
done
adb logcat -d -t 3000 > out/logcat.txt
