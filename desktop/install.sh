#!/usr/bin/env bash
# Install Cairn.app into /Applications and keep it in the Dock, so you can start it from the Dock, Spotlight,
# Launchpad or Finder whenever you need it.
#
#   bash desktop/install.sh               # build if missing/outdated, quit a running Cairn, install, add it to the Dock, launch it
#   bash desktop/install.sh --rebuild     # force a rebuild first
#   bash desktop/install.sh --no-launch   # install (or update) without starting it
#   bash desktop/install.sh --no-dock     # do not add Cairn to the Dock (also: CAIRN_NO_DOCK=1)
#   CAIRN_INSTALL_DIR=~/Applications bash desktop/install.sh   # install somewhere else
#
# Same as: node bin/cairn.js desktop --install [--no-dock]. Re-run it after code changes to update the installed copy.
# The copy keeps working outside the project: build.sh bakes absolute paths (project root, node, PATH, port)
# into its Info.plist. Falls back to ~/Applications when /Applications is not writable.
# The Dock tile is added only if the Dock has none for this path yet; the Dock restarts only when one was added.
# Unpin: right-click the Dock icon › Options › uncheck Keep in Dock (then use --no-dock on later installs).
# Uninstall: quit Cairn (Dock icon or bubble › Quit Cairn), remove it from the Dock, move /Applications/Cairn.app to the Trash.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
BUILD_APP="$HERE/build/Cairn.app"
BUILD_BIN="$BUILD_APP/Contents/MacOS/Cairn"
BUNDLE_ID="com.cairn.bubble"
PROC_PATTERN="Cairn\.app/Contents/MacOS/Cairn"   # any copy: the build or an installed one
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

log() { printf '[cairn-install] %s\n' "$*"; }
die() { printf '[cairn-install] error: %s\n' "$*" >&2; exit 1; }
# with_timeout <seconds> <cmd…>: macOS has no coreutils `timeout`; perl's alarm survives the exec.
with_timeout() { local s="$1"; shift; perl -e 'alarm shift; exec @ARGV or die "exec: $!\n"' "$s" "$@"; }
usage() { sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; }

REBUILD=0
LAUNCH=1
DOCK=1
[[ "${CAIRN_NO_DOCK:-0}" == "1" ]] && DOCK=0
for arg in "$@"; do
  case "$arg" in
    --rebuild) REBUILD=1 ;;
    --no-launch) LAUNCH=0 ;;
    --no-dock) DOCK=0 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'unknown option: %s\n' "$arg" >&2; usage >&2; exit 2 ;;
  esac
done

[[ "$(uname -s)" == "Darwin" ]] || die "the desktop bubble is macOS-only"

# --- 1. build if missing or older than its sources ----------------------------------------------------------
needs_build() {
  [[ -x "$BUILD_BIN" ]] || return 0
  local f
  for f in "$HERE/CairnBubble.swift" "$HERE/Info.plist" "$HERE/build.sh" "$HERE/icon/Cairn.icns" \
           "$ROOT"/web/avatars/*.html "$ROOT"/web/avatars/*.js "$ROOT"/web/avatars/*.css "$ROOT/web/avatars/index.json"; do
    [[ -e "$f" && "$f" -nt "$BUILD_BIN" ]] && return 0
  done
  return 1
}
if (( REBUILD )) || needs_build; then
  log "building ${BUILD_APP}…"
  CAIRN_FROM_INSTALL=1 bash "$HERE/build.sh"
fi
[[ -x "$BUILD_BIN" ]] || die "build failed: $BUILD_BIN is missing"

# --- 2. where to install ------------------------------------------------------------------------------------------
DEST_DIR="${CAIRN_INSTALL_DIR:-/Applications}"
if [[ ! -d "$DEST_DIR" || ! -w "$DEST_DIR" ]]; then
  if [[ -n "${CAIRN_INSTALL_DIR:-}" ]]; then
    mkdir -p "$DEST_DIR" 2>/dev/null && [[ -w "$DEST_DIR" ]] || die "$DEST_DIR is not writable"
  else
    log "/Applications is not writable — installing into ~/Applications instead"
    DEST_DIR="$HOME/Applications"
    mkdir -p "$DEST_DIR"
  fi
fi
DEST_DIR="$(cd "$DEST_DIR" && pwd)"
DEST="$DEST_DIR/Cairn.app"
STAGING="$DEST_DIR/.Cairn.app.installing"

# --- 3. quit any running Cairn (the build or an installed copy) -------------------------------------------------
is_running() { pgrep -f "$PROC_PATTERN" >/dev/null 2>&1; }
wait_gone() { local i; for ((i = 0; i < $1 * 10; i++)); do is_running || return 0; sleep 0.1; done; ! is_running; }
if is_running; then
  log "quitting the running Cairn…"
  # A normal Quit: the app stops the server child it started (a server you started yourself keeps running).
  with_timeout 15 osascript -e "if application id \"$BUNDLE_ID\" is running then
    with timeout of 10 seconds
      tell application id \"$BUNDLE_ID\" to quit
    end timeout
  end if" >/dev/null 2>&1 || true
  if ! wait_gone 8; then
    pkill -TERM -f "$PROC_PATTERN" 2>/dev/null || true      # SIGTERM is handled like Quit
    if ! wait_gone 6; then
      log "Cairn did not quit; forcing"
      pkill -KILL -f "$PROC_PATTERN" 2>/dev/null || true
      wait_gone 3 || die "could not stop the running Cairn (pids: $(pgrep -f "$PROC_PATTERN" | tr '\n' ' '))"
    fi
  fi
  log "Cairn quit"
fi

# --- 4. copy, then swap into place ----------------------------------------------------------------------------
log "installing $DEST"
rm -rf "$STAGING"
ditto "$BUILD_APP" "$STAGING"
xattr -dr com.apple.quarantine "$STAGING" 2>/dev/null || true
rm -rf "$DEST"
mv "$STAGING" "$DEST"

# --- 5. signature (ditto keeps the ad-hoc signature; re-sign only if it no longer verifies) ----------------------
if ! codesign --verify --deep --strict "$DEST" >/dev/null 2>&1; then
  log "signature did not verify after copying — re-signing ad-hoc"
  codesign --force --deep -s - "$DEST" >/dev/null 2>&1 || die "codesign failed for $DEST"
  codesign --verify --deep --strict "$DEST" || die "codesign verification failed for $DEST"
fi
log "signature ok ($(codesign -dv "$DEST" 2>&1 | awk -F= '/^Signature/ {print $2}'))"

# --- 6. LaunchServices / Finder / Dock: register the new copy and its icon --------------------------------------------
if [[ -x "$LSREGISTER" ]]; then
  "$LSREGISTER" -f "$DEST" >/dev/null 2>&1 || log "warning: lsregister failed (Launchpad/Spotlight may take a moment)"
  # Forget the build copy so "open -b com.cairn.bubble", Launchpad and URL lookups resolve to the installed one.
  [[ "$BUILD_APP" != "$DEST" ]] && "$LSREGISTER" -u "$BUILD_APP" >/dev/null 2>&1 || true
fi
touch "$DEST" "$DEST/Contents/Info.plist" "$DEST/Contents/Resources/Cairn.icns" 2>/dev/null || true
# Note: if Finder or the Dock still shows an old icon, it refreshes on its own; there is no need to restart them
# (the Dock is restarted only by step 7, and only when it adds the Cairn tile).

for other in /Applications/Cairn.app "$HOME/Applications/Cairn.app"; do
  if [[ "$other" != "$DEST" && -d "$other" ]]; then
    log "note: another copy exists at $other — move it to the Trash to avoid two Cairn entries in Launchpad/Spotlight"
  fi
done

# --- 7. Dock: keep Cairn in the Dock (idempotent) ----------------------------------------------------------------
# Adds a com.apple.dock persistent-apps tile for $DEST unless the Dock already has one for that path, then restarts
# the Dock — only when it actually added the tile. --no-dock / CAIRN_NO_DOCK=1 skips this step.
file_url() {   # file:///Applications/Cairn.app/ (percent-encoded the way the Dock stores it)
  printf 'file://%s/' "$(printf '%s' "$1" | perl -pe 's/([^A-Za-z0-9\/._~-])/sprintf("%%%02X", ord($1))/ge')"
}
dock_apps() { defaults read com.apple.dock persistent-apps 2>/dev/null || true; }
dock_has() {   # a tile for exactly this app path (URL form, or an old plain-path entry)
  local apps; apps="$(dock_apps)"
  grep -qiF "$(file_url "$1")" <<<"$apps" || grep -qiF "\"$1\"" <<<"$apps" || grep -qiF "\"$1/\"" <<<"$apps"
}
if (( ! DOCK )); then
  log "Dock: skipped (--no-dock)"
elif dock_has "$DEST"; then
  log "Dock: Cairn is already in the Dock"
else
  others="$(dock_apps | grep -ioE 'file://[^"]*/Cairn\.app/?' | sort -u | tr '\n' ' ' || true)"
  [[ -n "$others" ]] && log "note: the Dock also has another Cairn tile (${others% }) — right-click it › Options › Remove from Dock"
  tile="<dict><key>tile-data</key><dict><key>file-data</key><dict><key>_CFURLString</key><string>$(file_url "$DEST")</string><key>_CFURLStringType</key><integer>15</integer></dict></dict></dict>"
  if defaults write com.apple.dock persistent-apps -array-add "$tile" && dock_has "$DEST"; then
    killall Dock 2>/dev/null || true   # the Dock relaunches at once and shows the new tile
    log "Dock: added Cairn to the Dock (restarted the Dock once). To remove it: right-click the Dock icon › Options › uncheck Keep in Dock"
    sleep 1
  else
    log "warning: could not add Cairn to the Dock — drag $DEST to the Dock instead"
  fi
fi

# --- 8. launch ------------------------------------------------------------------------------------------------
if (( LAUNCH )); then
  open "$DEST" || die "could not launch $DEST"
  pid=""
  for _ in $(seq 1 50); do
    pid="$(pgrep -f "$DEST/Contents/MacOS/Cairn" | head -n 1 || true)"
    [[ -n "$pid" ]] && break
    sleep 0.2
  done
  if [[ -n "$pid" ]]; then
    log "Cairn is running (pid $pid) — look for the animated avatar at the top-right of your screen"
  else
    log "warning: Cairn did not appear to start — check ~/Library/Logs or run: open \"$DEST\""
  fi
  port="$(plutil -extract CairnPort raw "$DEST/Contents/Info.plist" 2>/dev/null || echo 8787)"
  code=""
  for _ in $(seq 1 40); do
    code="$(curl -s -o /dev/null -m 2 -w '%{http_code}' "http://127.0.0.1:$port/api/assistant/health" 2>/dev/null || true)"
    [[ "$code" == "200" ]] && break
    sleep 0.5
  done
  if [[ "$code" == "200" ]]; then
    log "server healthy at http://127.0.0.1:$port"
  else
    log "server not answering yet on port $port (the app keeps retrying; see $ROOT/data/server.log)"
  fi
else
  log "installed (not launched) — start it from the Dock, Spotlight (⌘Space › Cairn), Apps / Launchpad or: open \"$DEST\""
fi
log "done: $DEST — start it any time from the Dock, Spotlight (⌘Space › Cairn), Apps / Launchpad or the Applications folder"
