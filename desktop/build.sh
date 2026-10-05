#!/usr/bin/env bash
# Build desktop/build/Cairn.app — the native floating bubble for the Cairn assistant.
#
#   bash desktop/build.sh            # build + ad-hoc sign
#   CAIRN_NODE=/path/to/node bash desktop/build.sh   # pin a specific node
#   CAIRN_PORT=8787 bash desktop/build.sh            # bake a different server port
#   bash desktop/install.sh                          # build if needed, install into /Applications, keep it in the Dock
#
# GUI apps launched from Finder/`open`/login items do NOT inherit your shell PATH (node usually
# lives under ~/.nvm), so this script bakes absolute paths into Contents/Info.plist:
#   CairnProjectRoot, CairnNodePath, CairnPath (node's dir, ~/.local/bin, Homebrew, system dirs), CairnPort.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
BUILD="$HERE/build"
APP="$BUILD/Cairn.app"
STAGE="$BUILD/.Cairn.app.staging"
SRC="$HERE/CairnBubble.swift"
PLIST_SRC="$HERE/Info.plist"
PORT="${CAIRN_PORT:-8787}"
MIN_MACOS="${CAIRN_MIN_MACOS:-12.0}"

log() { printf '[cairn-build] %s\n' "$*"; }
die() { printf '[cairn-build] error: %s\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || die "the desktop bubble is macOS-only"
[[ -f "$SRC" ]] || die "missing $SRC"
[[ -f "$PLIST_SRC" ]] || die "missing $PLIST_SRC"
[[ -f "$ROOT/bin/cairn.js" ]] || log "warning: $ROOT/bin/cairn.js not found (the app will not be able to start the server)"
[[ "$PORT" =~ ^[0-9]+$ ]] || die "CAIRN_PORT must be a number"

# --- locate node (nvm is usually not loaded in non-interactive shells) ------------------------------
NODE_BIN="${CAIRN_NODE:-}"
if [[ -z "$NODE_BIN" ]]; then NODE_BIN="$(command -v node 2>/dev/null || true)"; fi
if [[ -z "$NODE_BIN" && -d "$HOME/.nvm/versions/node" ]]; then
  newest="$(ls -1 "$HOME/.nvm/versions/node" | sort -t. -k1.2,1n -k2,2n -k3,3n | tail -n 1 || true)"
  [[ -n "$newest" && -x "$HOME/.nvm/versions/node/$newest/bin/node" ]] && NODE_BIN="$HOME/.nvm/versions/node/$newest/bin/node"
fi
for c in /opt/homebrew/bin/node /usr/local/bin/node; do
  [[ -z "$NODE_BIN" && -x "$c" ]] && NODE_BIN="$c"
done
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || die "node not found — install Node.js >= 20 or set CAIRN_NODE=/path/to/node"
case "$NODE_BIN" in /*) ;; *) NODE_BIN="$(cd "$(dirname "$NODE_BIN")" && pwd)/$(basename "$NODE_BIN")";; esac
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if [[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] && (( NODE_MAJOR < 20 )); then
  log "warning: $NODE_BIN is Node $NODE_MAJOR; Cairn needs Node >= 20"
fi

# --- PATH for the server child (claude CLI, npx for the Playwright MCP, osascript, …) ----------------
BAKED_PATH=""
add_path() {
  local d="$1"
  [[ -n "$d" && -d "$d" ]] || return 0
  case ":$BAKED_PATH:" in
    *":$d:"*) ;;
    *) BAKED_PATH="${BAKED_PATH:+$BAKED_PATH:}$d" ;;
  esac
}
add_path "$(dirname "$NODE_BIN")"
CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
[[ -n "$CLAUDE_BIN" ]] && add_path "$(dirname "$CLAUDE_BIN")"
for d in "$HOME/.local/bin" /opt/homebrew/bin /opt/homebrew/sbin /usr/local/bin /usr/bin /bin /usr/sbin /sbin; do
  add_path "$d"
done

# --- toolchain ---------------------------------------------------------------------------------------
SWIFTC="$(xcrun --find swiftc 2>/dev/null || command -v swiftc || true)"
[[ -n "$SWIFTC" ]] || die "swiftc not found — install the Command Line Tools: xcode-select --install"
SDK="$(xcrun --sdk macosx --show-sdk-path 2>/dev/null || true)"
ARCH="$(uname -m)"

log "root:  $ROOT"
log "node:  $NODE_BIN"
log "claude: ${CLAUDE_BIN:-(not on PATH — the assistant will report it unavailable)}"
log "PATH:  $BAKED_PATH"
log "swift: $("$SWIFTC" --version 2>&1 | head -n 1)"

rm -rf "$STAGE"
mkdir -p "$STAGE/Contents/MacOS" "$STAGE/Contents/Resources"

SWIFT_FLAGS=(-O -swift-version 5 -parse-as-library -target "$ARCH-apple-macos$MIN_MACOS"
  -framework Cocoa -framework WebKit -framework Carbon)
[[ -n "$SDK" ]] && SWIFT_FLAGS+=(-sdk "$SDK")

log "compiling CairnBubble.swift ($ARCH, macOS >= $MIN_MACOS)…"
"$SWIFTC" "${SWIFT_FLAGS[@]}" -o "$STAGE/Contents/MacOS/Cairn" "$SRC"

# --- Info.plist with baked paths -------------------------------------------------------------------------
PLIST="$STAGE/Contents/Info.plist"
cp "$PLIST_SRC" "$PLIST"
plutil -replace CairnProjectRoot -string "$ROOT" "$PLIST"
plutil -replace CairnNodePath -string "$NODE_BIN" "$PLIST"
plutil -replace CairnPath -string "$BAKED_PATH" "$PLIST"
plutil -replace CairnPort -integer "$PORT" "$PLIST"
plutil -replace CairnBuiltAt -string "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$PLIST"
# A regular Dock app (Dock icon, Dock menu, menu bar). The app itself switches to a bubble-only accessory app at
# launch when the user turned "Show in Dock" off (UserDefaults CairnShowInDock = NO).
plutil -replace LSUIElement -bool NO "$PLIST"
plutil -lint "$PLIST" >/dev/null || die "generated Info.plist is invalid"
printf 'APPL????' > "$STAGE/Contents/PkgInfo"

# --- animated avatars (web/avatars) bundled so the bubble renders even while the server is down ---------------
AVATAR_SRC="$ROOT/web/avatars"
AVATAR_DST="$STAGE/Contents/Resources/avatars"
if [[ -d "$AVATAR_SRC" ]]; then
  mkdir -p "$AVATAR_DST"
  n=0
  shopt -s nullglob
  for f in "$AVATAR_SRC"/*.html "$AVATAR_SRC"/index.json "$AVATAR_SRC"/*.js "$AVATAR_SRC"/*.css "$AVATAR_SRC"/*.svg "$AVATAR_SRC"/*.png; do
    [[ -f "$f" ]] || continue
    cp "$f" "$AVATAR_DST/" && n=$((n + 1))
  done
  shopt -u nullglob
  if [[ -f "$AVATAR_DST/index.json" ]]; then
    "$NODE_BIN" -e '
      const fs = require("fs"), path = require("path");
      const dir = process.argv[1];
      const j = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
      const styles = (j.styles || []).filter(s => s && s.file && fs.existsSync(path.join(dir, s.file)));
      if (!styles.length) throw new Error("index.json lists no existing avatar files");
      console.log(styles.map(s => s.key + (s.key === j.default ? "*" : "")).join(", "));
    ' "$AVATAR_DST" 2>&1 | sed 's/^/[cairn-build] avatars: /' || log "warning: avatars/index.json is invalid (the app falls back to avatar-*.html or the native bubble)"
  else
    log "warning: web/avatars/index.json missing — the app will use any avatar-*.html (or the native bubble)"
  fi
  log "avatars: copied $n file(s) into Contents/Resources/avatars"
else
  log "warning: $AVATAR_SRC not found — the bubble uses the native drawing"
fi

# --- app icon ------------------------------------------------------------------------------------------------
# Preferred: the designed icon desktop/icon/Cairn.icns (regenerate it from desktop/icon/icon.html with
# bash desktop/icon/render.sh). Fallback: an icon rendered by the app's own bubble drawing code.
ICNS_SRC="$HERE/icon/Cairn.icns"
use_designed_icon() {
  [[ -s "$ICNS_SRC" ]] || return 1
  cp "$ICNS_SRC" "$STAGE/Contents/Resources/Cairn.icns" || return 1
  plutil -replace CFBundleIconFile -string Cairn "$PLIST" || return 1
}
make_icon() {
  local png="$BUILD/.icon-1024.png" set="$BUILD/.Cairn.iconset" s d
  rm -rf "$set" "$png"
  "$STAGE/Contents/MacOS/Cairn" --render-icon "$png" >/dev/null 2>&1 || return 1
  [[ -s "$png" ]] || return 1
  mkdir -p "$set" || return 1
  for s in 16 32 128 256 512; do
    d=$((s * 2))
    sips -z "$s" "$s" "$png" --out "$set/icon_${s}x${s}.png" >/dev/null 2>&1 || return 1
    sips -z "$d" "$d" "$png" --out "$set/icon_${s}x${s}@2x.png" >/dev/null 2>&1 || return 1
  done
  iconutil -c icns "$set" -o "$STAGE/Contents/Resources/Cairn.icns" >/dev/null 2>&1 || return 1
  plutil -replace CFBundleIconFile -string Cairn "$PLIST" || return 1
  rm -rf "$set" "$png"
}
if use_designed_icon; then
  log "icon: Contents/Resources/Cairn.icns (from desktop/icon/Cairn.icns)"
elif make_icon; then
  log "icon: Contents/Resources/Cairn.icns (generated bubble icon — desktop/icon/Cairn.icns not found)"
else
  log "icon: skipped (non-fatal)"
fi

# --- ad-hoc signature (local build; see docs/desktop.html for Gatekeeper/EDR notes) ---------------------
codesign --force --deep -s - "$STAGE" >/dev/null 2>&1 || die "codesign failed"
codesign --verify --deep --strict "$STAGE" || die "codesign verification failed"

rm -rf "$APP"
mv "$STAGE" "$APP"

"$APP/Contents/MacOS/Cairn" --print-config | sed 's/^/[cairn-build]   /' || log "warning: --print-config reported a problem (node or bin/cairn.js missing)"
if [[ "${CAIRN_SKIP_SELFTEST:-0}" != "1" ]]; then
  # Headless: builds the bubble, Dock and menu-bar menus, checks the activation policy and the Dock reopen
  # handler, drives the bubble layers, checks panel geometry and loads every bundled avatar
  # page offscreen (window.cairnAvatar.setState); shows nothing.
  rc=0
  out="$("$APP/Contents/MacOS/Cairn" --self-test 2>/dev/null)" || rc=$?
  [[ -n "$out" ]] && printf '%s\n' "$out" | sed 's/^/[cairn-build]   /'
  (( rc == 0 )) || log "warning: self-test reported failures (exit $rc, see above)"
fi
log "built $APP"
if [[ "${CAIRN_FROM_INSTALL:-0}" == "1" ]]; then
  :   # install.sh continues with quit → copy → launch; the hints below would only confuse
elif pgrep -f "$APP/Contents/MacOS/Cairn" >/dev/null 2>&1; then
  log "note: Cairn is already running — restart it to use the new build: bash desktop/run.sh --restart"
elif pgrep -f "Applications/Cairn.app/Contents/MacOS/Cairn" >/dev/null 2>&1; then
  log "note: the installed Cairn is running — update it to this build with: bash desktop/install.sh"
fi
if [[ "${CAIRN_FROM_INSTALL:-0}" != "1" ]]; then
  log "run it with: bash desktop/run.sh   (or: open \"$APP\")"
  log "install it in Applications (Spotlight, Apps / Launchpad): bash desktop/install.sh   (or: node bin/cairn.js desktop --install)"
fi
