#!/usr/bin/env bash
# Launch the Cairn desktop bubble: the installed /Applications/Cairn.app (or ~/Applications/Cairn.app) if there
# is one, otherwise the development build in desktop/build (built first if its sources changed).
#
#   bash desktop/run.sh             # launch (an installed copy is updated first if the sources/build are newer)
#   bash desktop/run.sh --rebuild   # force a rebuild first (and reinstall, if Cairn is installed)
#   bash desktop/run.sh --restart   # quit a running instance, rebuild/update if needed, relaunch
#   bash desktop/run.sh --quit      # quit Cairn (it stops the server only if it started it)
#   bash desktop/run.sh --install [--no-launch] [--no-dock]   # build if needed, install into /Applications and keep
#                                                            # it in the Dock (= desktop/install.sh)
# Updating an installed copy from here never touches the Dock (only an explicit install adds the Dock tile).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
BUILD_APP="$HERE/build/Cairn.app"
BUILD_BIN="$BUILD_APP/Contents/MacOS/Cairn"
PROC_PATTERN="Cairn\.app/Contents/MacOS/Cairn"   # any copy: the build or an installed one

usage() { sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; }

# The installed copy, if any (same lookup order as install.sh's destinations).
installed_app() {
  local d
  for d in /Applications/Cairn.app "$HOME/Applications/Cairn.app"; do
    [[ -x "$d/Contents/MacOS/Cairn" ]] && { printf '%s\n' "$d"; return 0; }
  done
  return 1
}

is_running() { pgrep -f "$PROC_PATTERN" >/dev/null 2>&1; }

# quit_app [pattern]: quit every running copy matching pattern (default: any copy).
quit_app() {
  local pat="${1:-$PROC_PATTERN}"
  if pgrep -f "$pat" >/dev/null 2>&1; then
    # SIGTERM is handled by the app: it stops the server child it started, then exits.
    pkill -TERM -f "$pat" || true
    for _ in $(seq 1 60); do pgrep -f "$pat" >/dev/null 2>&1 || break; sleep 0.1; done
    if pgrep -f "$pat" >/dev/null 2>&1; then
      echo "[cairn] Cairn did not quit in 6 s; forcing"
      pkill -KILL -f "$pat" || true
    fi
    echo "[cairn] Cairn quit"
  else
    echo "[cairn] Cairn is not running"
  fi
}

# Quit copies other than the one about to launch: the app exits at once if another copy with its bundle id runs.
quit_other_copies() {
  local target_bin="$1/Contents/MacOS/Cairn" line pid cmd
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    pid="${line%% *}"; cmd="${line#* }"
    [[ "$cmd" == "$target_bin"* ]] && continue
    echo "[cairn] quitting the other running copy (${cmd%% *})"
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
  done < <(pgrep -fl "$PROC_PATTERN" 2>/dev/null || true)
}

needs_build() {
  [[ ! -x "$BUILD_BIN" ]] && return 0
  for f in "$HERE/CairnBubble.swift" "$HERE/Info.plist" "$HERE/build.sh" "$HERE/icon/Cairn.icns" \
           "$ROOT"/web/avatars/*.html "$ROOT"/web/avatars/*.js "$ROOT"/web/avatars/*.css "$ROOT/web/avatars/index.json"; do
    [[ -e "$f" && "$f" -nt "$BUILD_BIN" ]] && return 0
  done
  return 1
}

REBUILD=0
RESTART=0
INSTALL=0
NO_LAUNCH=0
NO_DOCK=0
for arg in "$@"; do
  case "$arg" in
    --rebuild) REBUILD=1 ;;
    --restart) RESTART=1 ;;
    --quit|--stop) quit_app; exit 0 ;;
    --install) INSTALL=1 ;;
    --no-launch) NO_LAUNCH=1 ;;
    --no-dock) NO_DOCK=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

if (( INSTALL )); then
  args=()
  (( REBUILD )) && args+=(--rebuild)
  (( NO_LAUNCH )) && args+=(--no-launch)
  (( NO_DOCK )) && args+=(--no-dock)
  exec bash "$HERE/install.sh" ${args[@]+"${args[@]}"}
fi

if INSTALLED="$(installed_app)"; then
  # Installed: keep that copy current. install.sh rebuilds if needed, quits the running Cairn, copies, relaunches.
  if (( REBUILD )) || needs_build || [[ "$BUILD_BIN" -nt "$INSTALLED/Contents/MacOS/Cairn" ]]; then
    echo "[cairn] updating the installed copy at $INSTALLED"
    args=(--no-dock)   # an update keeps the Dock as you left it (you may have removed the tile on purpose)
    (( REBUILD )) && args+=(--rebuild)
    exec env CAIRN_INSTALL_DIR="$(dirname "$INSTALLED")" bash "$HERE/install.sh" ${args[@]+"${args[@]}"}
  fi
  (( RESTART )) && quit_app
  quit_other_copies "$INSTALLED"
  open "$INSTALLED"
  echo "[cairn] Cairn is running from $INSTALLED — look for the animated avatar at the top-right of your screen."
else
  if (( REBUILD )) || needs_build; then
    bash "$HERE/build.sh"
    is_running && RESTART=1
  fi
  (( RESTART )) && quit_app
  quit_other_copies "$BUILD_APP"
  open "$BUILD_APP"
  echo "[cairn] Cairn is running — look for the animated avatar at the top-right of your screen."
  echo "[cairn] Install it so you can start it from Launchpad/Spotlight: node bin/cairn.js desktop --install"
fi
echo "[cairn] Click it (or its Dock icon) to chat, drag it anywhere, right-click for options (Avatar › style), ⌥Space toggles the panel."
