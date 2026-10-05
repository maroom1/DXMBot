#!/bin/sh
# Render icon.html -> icon-1024.png (+ simplified small-size master icon-small-1024.png),
# make downscaled previews and the preview sheet.
set -e
D="$(cd "$(dirname "$0")" && pwd)"
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
shot() { "$CH" --headless=new --hide-scrollbars --default-background-color=00000000 --window-size=1024,1024 \
  --virtual-time-budget=4000 --screenshot="$1" "$2" >/dev/null 2>&1; }
shot "$D/icon-1024.png" "file://$D/icon.html"
shot "$D/icon-small-1024.png" "file://$D/icon.html#small=1"
for s in 512 256 128 64 32 16; do sips -Z $s "$D/icon-1024.png" --out "$D/previews/icon-$s.png" >/dev/null; done
for s in 64 32 16; do sips -Z $s "$D/icon-small-1024.png" --out "$D/previews/icon-small-$s.png" >/dev/null; done
"$CH" --headless=new --hide-scrollbars --window-size=1400,1000 --virtual-time-budget=2000 \
  --screenshot="$D/previews/preview-sheet.png" "file://$D/previews/sheet.html" >/dev/null 2>&1
sips -g pixelWidth -g pixelHeight "$D/icon-1024.png" | tail -2
