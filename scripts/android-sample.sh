#!/bin/bash
# Samples `dumpsys meminfo` for the repro app: GL mtrack, Graphics and TOTAL PSS (MB).
# usage: android-sample.sh <serial> <samples> <interval_s> [out.csv]
ADB="${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}"
SERIAL=$1; SAMPLES=$2; INTERVAL=$3; OUT=${4:-/dev/stdout}
PKG=${PKG:-com.pranav.skiarepro}
echo "elapsed_s,gl_mtrack_mb,graphics_mb,total_pss_mb,focused" > "$OUT"
start=$(date +%s)
for ((i = 0; i < SAMPLES; i++)); do
  mem=$("$ADB" -s "$SERIAL" shell dumpsys meminfo $PKG)
  gl=$(echo "$mem" | awk '$1=="GL" && $2=="mtrack" {print $3; exit}')
  gfx=$(echo "$mem" | awk '/Graphics:/ {print $2; exit}')
  pss=$(echo "$mem" | awk '/TOTAL PSS:/ {print $3; exit}')
  focus=$("$ADB" -s "$SERIAL" shell dumpsys window | grep -c "mCurrentFocus=.*$PKG")
  now=$(( $(date +%s) - start ))
  printf "%s,%.1f,%.1f,%.1f,%s\n" "$now" "$(echo "${gl:-0}/1024" | bc -l)" "$(echo "${gfx:-0}/1024" | bc -l)" "$(echo "${pss:-0}/1024" | bc -l)" "$focus" >> "$OUT"
  [[ $i -lt $((SAMPLES - 1)) ]] && sleep "$INTERVAL"
done
