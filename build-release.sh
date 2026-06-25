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

# Fail fast with an actionable message if a required build tool is missing,
# *before* bumping the version. A missing dependency used to abort mid-build
# (or silently produce no artifact) only after package.json was already bumped.
preflight() {
  local missing=()
  # electron-builder is wrapped in `xvfb-run` below whenever there is no
  # display, so xvfb + xauth are required for EVERY target, not just Windows.
  # xvfb-run aborts with "xauth command not found" when xauth is absent, which
  # silently breaks even the Linux AppImage build.
  if [ -z "${DISPLAY:-}" ]; then
    command -v xvfb-run >/dev/null 2>&1 || missing+=("xvfb-run  (apt install xvfb)")
    command -v xauth    >/dev/null 2>&1 || missing+=("xauth     (apt install xauth)")
  fi
  if [ "$TARGET" = "win" ] || [ "$TARGET" = "all" ]; then
    command -v wine >/dev/null 2>&1 || missing+=("wine      (apt install wine wine32 wine64)")
    command -v 7z >/dev/null 2>&1 || command -v 7za >/dev/null 2>&1 \
      || missing+=("7z        (apt install p7zip-full)")
    if command -v dpkg >/dev/null 2>&1 \
       && ! dpkg --print-foreign-architectures 2>/dev/null | grep -qx i386; then
      missing+=("i386 arch (sudo dpkg --add-architecture i386)")
    fi
  fi
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "Missing build prerequisites for target '$TARGET':" >&2
    local m
    for m in "${missing[@]}"; do echo "  - $m" >&2; done
    echo "" >&2
    echo "On this Debian host, install them all in one go:" >&2
    echo "  sudo dpkg --add-architecture i386 && sudo apt-get update \\" >&2
    echo "    && sudo apt-get install -y --no-install-recommends \\" >&2
    echo "       wine wine32 wine64 p7zip-full xauth xvfb" >&2
    exit 1
  fi
}
preflight

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
  local status=0
  wait "$pid" || status=$?

  # Resolve the produced artifact the same way the polling loop does.
  local found=""
  if [ -e "$pattern" ]; then
    found="$pattern"
  else
    found=$(compgen -G "$pattern" 2>/dev/null | tail -1 || true)
  fi

  # This function used to end on `printf`, so it ALWAYS returned 0: a failed
  # electron-builder (and the bare Linux/mac calls under `set -e`) slipped
  # through and the script reported success with no artifact. Return wait's
  # real status, and treat a zero exit that produced no output file as a
  # failure too.
  if [ "$status" -ne 0 ]; then
    printf "\r  %s: FAILED (exit %s)            \n" "$label" "$status"
  elif [ -z "$found" ]; then
    status=1
    printf "\r  %s: FAILED — no artifact matching %s\n" "$label" "$pattern"
  else
    printf "\r  %s: done (%s)            \n" "$label" "$found"
  fi
  return "$status"
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
