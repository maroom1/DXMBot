#!/usr/bin/env bash
# Regenerate the Cairn app icon:
#   icon.html --(headless Chrome)--> icon-1024.png + icon-small-1024.png --(sips)--> Cairn.iconset --(iconutil)--> Cairn.icns
#
#   bash desktop/icon/render.sh               # render the masters from icon.html, then build the iconset + icns
#   bash desktop/icon/render.sh --no-render   # skip Chrome; rebuild the iconset + icns from the existing PNG masters
#   CHROME=/path/to/chrome bash desktop/icon/render.sh
#
# icon.html ("Aurora Night") is the source of truth: one WebGL shader on Apple's icon grid (824 px squircle body,
# 100 px margin, transparent corners, soft drop shadow). `#small=1` renders the simplified master (bigger orb,
# no ring/moon/stars, lighter field) that is used for the 16 and 32 px slots, where the full design gets mushy.
# Afterwards put it into the app with: bash desktop/build.sh   (or: node bin/cairn.js desktop --install)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SRC="$HERE/icon.html"
MASTER="$HERE/icon-1024.png"
SMALL="$HERE/icon-small-1024.png"
SET="$HERE/Cairn.iconset"
ICNS="$HERE/Cairn.icns"
DOCS_PNG="$ROOT/docs/assets/screenshots/app-icon.png"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

log() { printf '[cairn-icon] %s\n' "$*"; }
die() { printf '[cairn-icon] error: %s\n' "$*" >&2; exit 1; }

RENDER=1
for arg in "$@"; do
  case "$arg" in
    --no-render) RENDER=0 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $arg (try --help)" ;;
  esac
done

[[ "$(uname -s)" == "Darwin" ]] || die "sips/iconutil are macOS-only"
command -v sips >/dev/null || die "sips not found"
command -v iconutil >/dev/null || die "iconutil not found"

TMPD="$(mktemp -d "${TMPDIR:-/tmp}/cairn-icon.XXXXXX")"
trap 'rm -rf "$TMPD"' EXIT

# with_timeout <seconds> <cmd…>: macOS has no coreutils `timeout`; perl's alarm survives the exec.
with_timeout() { local s="$1"; shift; perl -e 'alarm shift; exec @ARGV or die "exec: $!\n"' "$s" "$@"; }

dims() { sips -g pixelWidth -g pixelHeight "$1" 2>/dev/null | awk '/pixel(Width|Height)/ {printf "%s ", $2}'; }

# render <url-hash> <out.png>: screenshot icon.html at 1024x1024 on a transparent background and check the shader ran.
render() {
  local hash="$1" out="$2" tmp="$TMPD/shot.png" url="file://$SRC$1"
  rm -f "$tmp"
  # (No --user-data-dir: with a custom profile, headless Chrome 15x keeps running after --dump-dom.)
  local chrome_flags=(--headless=new --hide-scrollbars --force-device-scale-factor=1
    --window-size=1024,1024 --virtual-time-budget=4000)
  # The page sets <title>OK</title> after drawing (or "SHADER ERR"); a blank WebGL context would still screenshot.
  local dom
  dom="$(with_timeout 90 "$CHROME" "${chrome_flags[@]}" --dump-dom "$url" 2>/dev/null || true)"
  [[ "$dom" == *'<title>OK</title>'* ]] \
    || die "icon.html$hash did not render (WebGL unavailable or shader error) — open it in Chrome to see why"
  with_timeout 90 "$CHROME" "${chrome_flags[@]}" --default-background-color=00000000 --screenshot="$tmp" "$url" >/dev/null 2>&1 || true
  [[ -s "$tmp" ]] || die "Chrome wrote no screenshot for icon.html$hash"
  [[ "$(dims "$tmp")" == "1024 1024 " ]] || die "icon.html$hash rendered at $(dims "$tmp")(expected 1024 1024)"
  # A real render is ~650 KB; a failed shader leaves only the flat shadow layer (a few KB).
  (( $(stat -f %z "$tmp") > 200000 )) || die "icon.html$hash looks blank ($(stat -f %z "$tmp") bytes)"
  mv "$tmp" "$out"
  log "rendered $(basename "$out")"
}

if (( RENDER )); then
  [[ -f "$SRC" ]] || die "missing $SRC"
  [[ -x "$CHROME" ]] || die "Google Chrome not found at $CHROME (set CHROME=… or use --no-render)"
  render "" "$MASTER"
  render "#small=1" "$SMALL"
fi
[[ -f "$MASTER" ]] || die "missing $MASTER (run without --no-render)"
[[ -f "$SMALL" ]] || { log "warning: $SMALL missing — using the full master for 16/32 px"; SMALL="$MASTER"; }

# iconset: simplified master for the 16 and 32 px bitmaps, full master from 64 px up.
rm -rf "$SET"
mkdir -p "$SET"
slot() { # <name> <px> <master>
  sips -s format png -z "$2" "$2" "$3" --out "$SET/$1.png" >/dev/null || die "sips failed for $1"
}
slot icon_16x16       16   "$SMALL"
slot icon_16x16@2x    32   "$SMALL"
slot icon_32x32       32   "$SMALL"
slot icon_32x32@2x    64   "$MASTER"
slot icon_128x128     128  "$MASTER"
slot icon_128x128@2x  256  "$MASTER"
slot icon_256x256     256  "$MASTER"
slot icon_256x256@2x  512  "$MASTER"
slot icon_512x512     512  "$MASTER"
cp "$MASTER" "$SET/icon_512x512@2x.png"
log "iconset: $(ls "$SET" | wc -l | tr -d ' ') images in $SET"

iconutil -c icns "$SET" -o "$TMPD/Cairn.icns" || die "iconutil failed"
mv "$TMPD/Cairn.icns" "$ICNS"
log "icns:    $ICNS ($(stat -f %z "$ICNS") bytes)"

# Docs copy of the icon (shown on docs/desktop.html › Install & launch).
if [[ -d "$(dirname "$DOCS_PNG")" ]]; then
  sips -s format png -z 256 256 "$MASTER" --out "$DOCS_PNG" >/dev/null && log "docs:    $DOCS_PNG"
fi
log "next: bash desktop/build.sh   (or: node bin/cairn.js desktop --install)"
