# BGSD Release & Deploy

## Branch Flow

During development, push each verified, testable checkpoint to:

```bash
git push origin HEAD:windows-test
```

The maintainer pulls `windows-test` on Windows and reports any issues from that branch. Keep fixes on `windows-test` until the maintainer confirms the Windows test pass is clean.

Do not push iterative work directly to `master`. Move to `master` only when the maintainer asks to release/ship after all Windows issues are resolved. Release artifacts and GitHub Releases should be created from the accepted `master` state.

Recommended final promotion:

```bash
git checkout master
git pull origin master
git merge --ff-only windows-test
git push origin master
```

If fast-forward is not possible, stop and inspect the branch history before merging.

## Release Build

```bash
./build-release.sh [win|linux|mac|all] [patch|minor|major]
```

This bumps the version, builds the frontend, and produces platform binaries in `release/`. Windows releases include both the existing portable executable (`BGSD <VERSION>.exe`) and an assisted installer (`BGSD-Setup-<VERSION>.exe`) that offers an install-location choice and Start Menu/Desktop shortcuts.
The script auto-wraps with `xvfb-run` when `$DISPLAY` is unset (needed for wine/rcedit during Windows cross-compile).
File-size progress is shown during compression.

## Build Notes

- Windows cross-compile needs wine + a virtual display (`xvfb-run` handles this automatically)
- `build-release.sh` prefers Debian Wine at `/usr/lib/wine/wine` for Windows packaging by prepending a temporary PATH shim and using a temporary Wine prefix. This avoids WineHQ devel builds that can hang during electron-builder's `rcedit` resource step. If `/usr/lib/wine/wine` is missing, install the Debian `wine64` package or expect the script to fall back to `wine` from PATH.
- The assisted installer also requires Debian's `wine32:i386` package. electron-builder runs a temporary 32-bit NSIS installer under Wine to produce the bundled uninstaller; the release preflight reports this before changing the version.
- The bundled makensis requires a valid locale — if the configured locale isn't installed, the script falls back to `C.utf8`
- If a build fails mid-way, clean stale artifacts before retrying: `rm -rf release/win-unpacked release/linux-unpacked`
- The portable and installer targets use NSIS + 7z max compression; building both takes several minutes
- If Node runs out of memory during packaging: `NODE_OPTIONS="--max-old-space-size=2048" ./build-release.sh win`
- Never replace the bundled makensis (`~/.cache/electron-builder/nsis/`) with a system-installed one — version mismatch causes EPIPE errors
- Clean old release artifacts periodically — they accumulate and eat disk

## Push Code + Binaries

```bash
git push origin master
gh release create v<VERSION> \
  "release/BGSD-<VERSION>.AppImage" \
  "release/BGSD <VERSION>.exe" \
  "release/BGSD-Setup-<VERSION>.exe" \
  "release/BGSD-<VERSION>-mac.zip" \
  --title "v<VERSION>" --notes "<changelog>"
```

Binaries are distributed via GitHub Releases using the `gh` CLI.
