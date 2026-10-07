#!/bin/bash
# Launches a scenario deep link after checking the phone is awake and unlocked, then samples memory.
# usage: android-run.sh <serial> <query> <samples> <interval_s> <out.csv>
ADB="${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}"
SERIAL=$1; QUERY=$2; SAMPLES=$3; INTERVAL=$4; OUT=$5
if ! "$ADB" -s "$SERIAL" shell dumpsys power | grep -q "mWakefulness=Awake"; then echo "STOP: screen is not awake"; exit 2; fi
if "$ADB" -s "$SERIAL" shell dumpsys window | grep -q "isKeyguardShowing=true"; then echo "STOP: keyguard showing"; exit 2; fi
"$ADB" -s "$SERIAL" shell am start -W -S -a android.intent.action.VIEW -d "skiarepro://run?${QUERY//&/\\&}" com.pranav.skiarepro > /dev/null
sleep 1
if ! "$ADB" -s "$SERIAL" shell dumpsys window | grep -q "mCurrentFocus=.*com.pranav.skiarepro"; then echo "STOP: repro app not focused"; exit 2; fi
"$(dirname "$0")/android-sample.sh" "$SERIAL" "$SAMPLES" "$INTERVAL" "$OUT"
cat "$OUT"
