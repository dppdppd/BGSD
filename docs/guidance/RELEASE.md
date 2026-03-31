# BGSD Release & Deploy

```bash
./build-release.sh [win|linux|mac|all] [patch|minor|major]
```

This bumps the version, builds the frontend, and produces platform binaries in `release/`.
The script auto-wraps with `xvfb-run` when `$DISPLAY` is unset (needed for wine/rcedit during Windows cross-compile).
File-size progress is shown during compression.

## Build Notes

- Windows cross-compile needs wine + a virtual display (`xvfb-run` handles this automatically)
- The bundled makensis requires a valid locale — if the configured locale isn't installed, the script falls back to `C.utf8`
- If a build fails mid-way, clean stale artifacts before retrying: `rm -rf release/win-unpacked release/linux-unpacked`
- The portable exe target internally uses NSIS + 7z max compression (~3-5 min for 269MB)
- If Node runs out of memory during packaging: `NODE_OPTIONS="--max-old-space-size=2048" ./build-release.sh win`
- Never replace the bundled makensis (`~/.cache/electron-builder/nsis/`) with a system-installed one — version mismatch causes EPIPE errors
- Clean old release artifacts periodically — they accumulate and eat disk

## Push Code + Binaries

```bash
git push origin master
gh release create v<VERSION> \
  "release/BGSD-<VERSION>.AppImage" \
  "release/BGSD <VERSION>.exe" \
  "release/BGSD-<VERSION>-mac.zip" \
  --title "v<VERSION>" --notes "<changelog>"
```

Binaries are distributed via GitHub Releases using the `gh` CLI.
