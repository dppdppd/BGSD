#!/usr/bin/env bash
set -e

# Usage: ./build-release.sh [target] [bump]
#   target: win, linux, mac, all (default: all)
#   bump:   patch, minor, major (default: patch)

TARGET="${1:-all}"
LEVEL="${2:-patch}"

case "$TARGET" in
  win|linux|mac|all) ;;
  *)
    echo "Usage: $0 [win|linux|mac|all] [patch|minor|major]"
    echo "  target: win, linux, mac, all (default: all)"
    echo "  bump:   patch, minor, major (default: patch)"
    exit 1
    ;;
esac

case "$LEVEL" in
  patch|minor|major) ;;
  *)
    echo "Usage: $0 [win|linux|mac|all] [patch|minor|major]"
    exit 1
    ;;
esac

cd "$(dirname "$0")"

NEW_VERSION=$(npm version "$LEVEL" --no-git-tag-version)
VER="${NEW_VERSION#v}"
echo "Bumped to $NEW_VERSION"

echo "Building frontend..."
npm run build

# Ensure a valid locale exists — the bundled makensis (NSIS) fails with
# "FATAL: main argv conversion failed!" if the configured locale (e.g.
# en_US.UTF-8) is not actually installed.  C.utf8 is always available.
if ! locale -a 2>/dev/null | grep -qiF "$LANG"; then
  export LANG=C.utf8 LC_ALL=C.utf8
fi

# Windows cross-compile uses wine (via rcedit) which needs a display.
# Use xvfb-run to provide a virtual framebuffer when no display is available.
EB="npx electron-builder"
if [ -z "$DISPLAY" ] && command -v xvfb-run &>/dev/null; then
  EB="xvfb-run -a $EB"
fi

restore_env_var() {
  local name="$1" had="$2" old="$3"
  if [ "$had" = "1" ]; then
    export "$name=$old"
  else
    unset "$name"
  fi
}

restore_windows_build_env() {
  local shim="$1" prefix="$2" created_prefix="$3"
  local had_path="$4" old_path="$5"
  local had_wineprefix="$6" old_wineprefix="$7"
  local had_winearch="$8" old_winearch="$9"
  local had_winedlloverrides="${10}" old_winedlloverrides="${11}"
  local had_compression="${12}" old_compression="${13}"

  if [ -n "$prefix" ] && [ "$created_prefix" = "1" ] && [ -n "$shim" ] && [ -x "$shim/wineserver" ]; then
    WINEPREFIX="$prefix" "$shim/wineserver" -k >/dev/null 2>&1 || true
  fi

  restore_env_var PATH "$had_path" "$old_path"
  restore_env_var WINEPREFIX "$had_wineprefix" "$old_wineprefix"
  restore_env_var WINEARCH "$had_winearch" "$old_winearch"
  restore_env_var WINEDLLOVERRIDES "$had_winedlloverrides" "$old_winedlloverrides"
  restore_env_var ELECTRON_BUILDER_COMPRESSION_LEVEL "$had_compression" "$old_compression"

  if [ -n "$shim" ]; then
    rm -rf "$shim"
  fi
  if [ "$created_prefix" = "1" ] && [ -n "$prefix" ]; then
    rm -rf "$prefix"
  fi
}

configure_debian_wine_for_windows_build() {
  local debian_wine="/usr/lib/wine/wine"
  if [ ! -x "$debian_wine" ]; then
    echo "Warning: Debian Wine not found at $debian_wine; using wine from PATH"
    return 0
  fi

  local shim
  shim=$(mktemp -d -t bgsd-wine-shim.XXXXXX)
  ln -s "$debian_wine" "$shim/wine"
  ln -s "$debian_wine" "$shim/wineboot"
  if [ -x /usr/lib/wine/wine64 ]; then
    ln -s /usr/lib/wine/wine64 "$shim/wine64"
  fi
  if [ -x /usr/lib/wine/wineserver ]; then
    ln -s /usr/lib/wine/wineserver "$shim/wineserver"
  fi

  export PATH="$shim:$PATH"
  export BGSD_WINE_SHIM="$shim"

  if [ -z "${WINEPREFIX-}" ]; then
    export WINEPREFIX
    WINEPREFIX=$(mktemp -d -t bgsd-wine-prefix.XXXXXX)
    export BGSD_CREATED_WINEPREFIX=1
  else
    export BGSD_CREATED_WINEPREFIX=0
  fi
  export WINEARCH="${WINEARCH:-win64}"
  export WINEDLLOVERRIDES="${WINEDLLOVERRIDES:-mscoree,mshtml=}"

  echo "Using Debian Wine for Windows build: $debian_wine"
}

# build_with_progress <platform_flag> <label> <glob_pattern>
# Runs electron-builder in the background and prints file-size progress
# for the output artifact while it builds.
build_with_progress() {
  local flag="$1" label="$2" pattern="$3"
  local started
  started=$(date +%s)
  echo "Building ${label}..."
  $EB $flag &
  local pid=$!

  # Poll output file size every 2s until builder finishes
  while kill -0 "$pid" 2>/dev/null; do
    local f
    if [ -e "$pattern" ]; then
      f="$pattern"
    else
      f=$(compgen -G "$pattern" | tail -1 || true)
    fi
    if [ -n "$f" ]; then
      local sz
      sz=$(du -h "$f" 2>/dev/null | cut -f1)
      printf "\r  %s: %s ..." "$label" "$sz"
    else
      local elapsed
      elapsed=$(($(date +%s) - started))
      printf "\r  %s: building (%ss) ..." "$label" "$elapsed"
    fi
    sleep 2
  done
  wait "$pid"
  printf "\r  %s: done                    \n" "$label"
}

if [ "$TARGET" = "linux" ] || [ "$TARGET" = "all" ]; then
  build_with_progress "--linux" "Linux" "release/BGSD-${VER}.AppImage"
fi

if [ "$TARGET" = "win" ] || [ "$TARGET" = "all" ]; then
  # Windows portable packaging must use max compression; store-compressed
  # payloads produce oversized release assets.
  _old_path="${PATH-}"
  _had_path=0
  if [ "${PATH+x}" = "x" ]; then
    _had_path=1
  fi
  _old_wineprefix="${WINEPREFIX-}"
  _had_wineprefix=0
  if [ "${WINEPREFIX+x}" = "x" ]; then
    _had_wineprefix=1
  fi
  _old_winearch="${WINEARCH-}"
  _had_winearch=0
  if [ "${WINEARCH+x}" = "x" ]; then
    _had_winearch=1
  fi
  _old_winedlloverrides="${WINEDLLOVERRIDES-}"
  _had_winedlloverrides=0
  if [ "${WINEDLLOVERRIDES+x}" = "x" ]; then
    _had_winedlloverrides=1
  fi
  _old_win_compression_level="${ELECTRON_BUILDER_COMPRESSION_LEVEL-}"
  _had_win_compression_level=0
  if [ "${ELECTRON_BUILDER_COMPRESSION_LEVEL+x}" = "x" ]; then
    _had_win_compression_level=1
  fi
  BGSD_WINE_SHIM=""
  BGSD_CREATED_WINEPREFIX=0
  configure_debian_wine_for_windows_build
  export ELECTRON_BUILDER_COMPRESSION_LEVEL=9
  _win_build_status=0
  build_with_progress "--win" "Windows" "release/BGSD ${VER}.exe" || _win_build_status=$?
  restore_windows_build_env \
    "$BGSD_WINE_SHIM" "${WINEPREFIX-}" "$BGSD_CREATED_WINEPREFIX" \
    "$_had_path" "$_old_path" \
    "$_had_wineprefix" "$_old_wineprefix" \
    "$_had_winearch" "$_old_winearch" \
    "$_had_winedlloverrides" "$_old_winedlloverrides" \
    "$_had_win_compression_level" "$_old_win_compression_level"
  unset BGSD_WINE_SHIM BGSD_CREATED_WINEPREFIX
  if [ "$_win_build_status" -ne 0 ]; then
    exit "$_win_build_status"
  fi
fi

if [ "$TARGET" = "mac" ] || [ "$TARGET" = "all" ]; then
  build_with_progress "--mac" "macOS" "release/BGSD-${VER}-mac.zip"
fi

echo ""
echo "=== Release artifacts ($NEW_VERSION) ==="
ls -lh release/*"${VER}"* 2>/dev/null || echo "(none found)"
