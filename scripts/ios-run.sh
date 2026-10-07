#!/bin/bash
# Launches a scenario on the iPhone (after checking it is unlocked), waits, then copies the app's memlog.csv.
# usage: ios-run.sh <device> <query> <seconds> <out.csv>
D=$1; QUERY=$2; SECS=$3; OUT=$4
if ! xcrun devicectl device info lockState --device "$D" 2>/dev/null | grep -q "passcodeRequired: false"; then echo "STOP: iPhone is locked"; exit 2; fi
xcrun devicectl device process launch --device "$D" --terminate-existing --payload-url "skiarepro://run?$QUERY" com.pranav.skiarepro > /dev/null || exit 2
sleep "$SECS"
rm -f "$OUT"
xcrun devicectl device copy from --device "$D" --domain-type appDataContainer --domain-identifier com.pranav.skiarepro --source Documents/memlog.csv --destination "$OUT" > /dev/null
cat "$OUT"
