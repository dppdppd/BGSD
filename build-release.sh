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
  # Windows portable packaging runs through NSIS under Wine. The default
  # 7zip max-compression path can take longer than the command runner timeout
  # on this build host, so default to store compression for the Windows payload.
  # Override by exporting ELECTRON_BUILDER_COMPRESSION_LEVEL before running.
  _had_win_compression_level=0
  if [ "${ELECTRON_BUILDER_COMPRESSION_LEVEL+x}" = "x" ]; then
    _had_win_compression_level=1
    _old_win_compression_level="$ELECTRON_BUILDER_COMPRESSION_LEVEL"
  else
    export ELECTRON_BUILDER_COMPRESSION_LEVEL=0
  fi
  build_with_progress "--win" "Windows" "release/BGSD ${VER}.exe"
  if [ "$_had_win_compression_level" = "1" ]; then
    export ELECTRON_BUILDER_COMPRESSION_LEVEL="$_old_win_compression_level"
  else
    unset ELECTRON_BUILDER_COMPRESSION_LEVEL
  fi
fi

if [ "$TARGET" = "mac" ] || [ "$TARGET" = "all" ]; then
  build_with_progress "--mac" "macOS" "release/BGSD-${VER}-mac.zip"
fi

echo ""
echo "=== Release artifacts ($NEW_VERSION) ==="
ls -lh release/*"${VER}"* 2>/dev/null || echo "(none found)"
