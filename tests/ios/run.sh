#!/bin/bash
# iOS Simulator + Mobile Safari: pick videos from the Photos library the way a
# person does, and record what the app shows. Run on a macOS GitHub runner.
#   bash tests/ios/run.sh
set -x
OUT=$PWD/out; mkdir -p "$OUT"
HERE=$(cd "$(dirname "$0")" && pwd)

# newest iOS runtime, an iPhone on it
read -r UDID VER NAME < <(xcrun simctl list devices available -j | python3 -c '
import json, sys, re
d = json.load(sys.stdin)["devices"]
c = []
for k, v in d.items():
    m = re.search(r"iOS-(\d+)-(\d+)", k)
    if not m: continue
    for x in v:
        if re.match(r"iPhone \d+( Pro)?$", x["name"]): c.append(((int(m[1]), int(m[2])), x))
c.sort(key=lambda t: (t[0], t[1]["name"]))
(ver, x) = c[-1]
print(x["udid"], f"{ver[0]}.{ver[1]}", x["name"])')
echo "device $NAME iOS $VER $UDID" | tee "$OUT/device.txt"
xcrun simctl boot "$UDID"
xcrun simctl bootstatus "$UDID" -b
xcrun simctl addmedia "$UDID" "$HERE/IMG_0001.MOV" "$HERE/dive_h264.mp4"

# the built site on a plain local server (no special headers)
(cd _site && python3 -m http.server 8765 >/dev/null 2>&1 &)

npm i -g appium@latest >/dev/null 2>&1
appium driver install xcuitest 2>&1 | tail -3
(appium --log-level warn --log "$OUT/appium.log" >/dev/null 2>&1 &)
for i in $(seq 1 60); do curl -s localhost:4723/status >/dev/null && break; sleep 2; done

cd "$HERE" && npm i --no-save webdriverio@9 >/dev/null 2>&1
UDID=$UDID VER=$VER NAME="$NAME" OUT=$OUT node "$HERE/run.mjs" 2>&1 | tee "$OUT/run.txt"
xcrun simctl spawn "$UDID" log show --last 15m --style compact --predicate 'process == "MobileSafari" OR process CONTAINS "WebContent" OR process CONTAINS "PhotosPicker" OR process CONTAINS "PhotoPicker"' 2>/dev/null | grep -iE "error|fail|denied|sandbox|blob|media|video|file" | tail -400 > "$OUT/syslog.txt"
true
