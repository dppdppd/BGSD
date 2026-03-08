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
  echo "Building ${label}..."
  $EB $flag &
  local pid=$!

  # Poll output file size every 2s until builder finishes
  while kill -0 "$pid" 2>/dev/null; do
    local f
    f=$(ls -1 $pattern 2>/dev/null | tail -1)
    if [ -n "$f" ]; then
      local sz
      sz=$(du -h "$f" 2>/dev/null | cut -f1)
      printf "\r  %s: %s ..." "$label" "$sz"
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
  build_with_progress "--win" "Windows" "release/BGSD ${VER}.exe"
fi

if [ "$TARGET" = "mac" ] || [ "$TARGET" = "all" ]; then
  build_with_progress "--mac" "macOS" "release/BGSD-${VER}-mac.zip"
fi

echo ""
echo "=== Release artifacts ($NEW_VERSION) ==="
ls -lh release/*"${VER}"* 2>/dev/null || echo "(none found)"
