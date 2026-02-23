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
echo "Bumped to $NEW_VERSION"

echo "Building frontend..."
npm run build

if [ "$TARGET" = "linux" ] || [ "$TARGET" = "all" ]; then
  echo "Building Linux..."
  npx electron-builder --linux
fi

if [ "$TARGET" = "win" ] || [ "$TARGET" = "all" ]; then
  echo "Building Windows..."
  npx electron-builder --win
fi

if [ "$TARGET" = "mac" ] || [ "$TARGET" = "all" ]; then
  echo "Building macOS..."
  npx electron-builder --mac
fi

echo ""
echo "=== Release artifacts ($NEW_VERSION) ==="
ls -1 release/
