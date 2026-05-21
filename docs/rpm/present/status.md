# BGSD — Present State

## Project Status
- **Current phase**: 0.5.x — feature polish (version history, schema coverage, defaults UX, self-update)
- **Latest release**: v0.5.35 (2026-05-21) — https://github.com/dppdppd/BGSD/releases/tag/v0.5.35
- **Last updated**: 2026-05-21

## Completed Work
- Cross-platform release builds via electron-builder
- Welcome screen with library tree + per-file context menu (Edit / Rename / Delete / Export STL)
- Inline rename UI (Electron suppresses `window.prompt()`)
- Favorites + per-block Show-Defaults (All/Favorites/None) radios
- Undo/redo, recent files, keyboard shortcuts
- Persistent Version History via `.undo` sidecars, manual pinned checkpoints, labels, restore, and OpenSCAD launch for saved versions
- File/View toolbar menus with Save Version, Save As, Version History, Recent Files flyout, Copy Path, and Show SCAD
- BGSD application icon included for packaged builds
- Duplicate button on scenes (clones data block + matching `Make(...)`, renames `<orig>_copy`)
- Status bar always shows BGSD + BIT + CTD versions with explicit minor.patch parsed from lib frontmatter; tooltip surfaces live update-check state
- BGSD self-updater (Linux AppImage in-place with ELF check + `.bak` backup; macOS / Windows stage to `~/Downloads`)
- Lib update probe on launch + inline lib refresh from the status-bar chip
- Lib update toast lists only files actually refreshed, with their parsed version
- Lib update compares on-disk hash to upstream (not the manifest record) — manifest drift can't mask staleness
- `my_designs/` excluded from lib updates (user's design space)
- CHAMFER_N schema entry + tooltip ("interior + exterior edges"); LBL_FONT default fix
- Lid defaults visibility fix (non-merged BOX_LID close resolves to lid context)
- Virtual BOX_LID params sort alphabetically — no resort when first param is edited
- Library update always overwrites base libs; publisher/game examples respect the writable-skip
- BIT 4.12.0 schema/import/UI support for nested SVG feature shape blocks
- Dynamic print/reference selectors for print groups, print boxes, and feature references
- Per-block Show-Defaults mode radios; file-wide default-key view removed
- Parameter search with Ctrl+F, key/tooltip matching, and highlighted results
- Parameter category dividers and grouped default rows for denser editing
- STL export creates one combined STL and one STL per print group
- OpenSCAD diagnostics surfaced asynchronously with toolbar status and issue details
- Windows release builds use Debian Wine via a temporary shim to avoid WineHQ devel `rcedit` hangs

## Active Specs
(none — operating ad-hoc; specs will live in `docs/spec/`)

## Known Issues
- Dark/light theme not implemented (backlog)
- Pre-existing CSS warning: unused `.toggle-btn.disabled` selector in App.svelte
- Windows + macOS release artifacts ship unsigned
- Self-update on macOS / Windows is staged-only (downloads to `~/Downloads` and pops the file manager — no in-place install yet)
