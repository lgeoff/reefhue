#!/bin/bash
# First look at the emulator: Android version, browsers, picker apps.
set -x
mkdir -p out
adb shell getprop ro.build.version.release
adb shell pm list packages | grep -iE "chrome|webview|photos|gallery|documentsui|files|media" | sort
adb shell dumpsys package com.android.chrome | grep -E "versionName|versionCode" | head -4
adb shell dumpsys package com.google.android.webview | grep versionName | head -2
adb shell cmd package resolve-activity --brief -a android.intent.action.GET_CONTENT -t 'image/*' | tail -3
adb shell cmd package query-activities --brief -a android.intent.action.GET_CONTENT -t 'image/*' | head -20
adb shell cmd package query-activities --brief -a android.intent.action.PICK -t 'image/*' | head -20
adb exec-out screencap -p > out/home.png
