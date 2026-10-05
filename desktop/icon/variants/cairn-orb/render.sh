#!/bin/zsh
# Render icon.html -> icon-1024.png, make downscaled previews and the preview sheet.
D=/Users/mgodu01/DxBot/desktop/icon/variants/cairn-orb
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CH" --headless=new --hide-scrollbars --default-background-color=00000000 --window-size=1024,1024 --virtual-time-budget=4000 --screenshot=$D/icon-1024.png "file://$D/icon.html" >/dev/null 2>&1
for s in 512 128 64 32 16; do sips -Z $s $D/icon-1024.png --out $D/previews/icon-$s.png >/dev/null; done
"$CH" --headless=new --hide-scrollbars --window-size=1400,1180 --virtual-time-budget=3000 --screenshot=$D/previews/preview-sheet.png "file://$D/previews/sheet.html" >/dev/null 2>&1
sips -g pixelWidth -g pixelHeight $D/icon-1024.png | tail -2
