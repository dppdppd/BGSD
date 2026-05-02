# BGSD — Present State

## Project Status
- **Current phase**: 0.5.x — feature polish (welcome screen, schema coverage, defaults UX, self-update)
- **Latest release**: v0.5.16 (2026-05-02) — https://github.com/dppdppd/BGSD/releases/tag/v0.5.16
- **Last updated**: 2026-05-02

## Completed Work
- Cross-platform release builds via electron-builder
- Welcome screen with library tree + per-file context menu (Edit / Rename / Delete / Export STL)
- Inline rename UI (Electron suppresses `window.prompt()`)
- Favorites + Show-Defaults (All/Favorites/None) radio
- Undo/redo, recent files, keyboard shortcuts
- Duplicate button on scenes (clones data block + matching `Make(...)`, renames `<orig>_copy`)
- "Copy path" button in editor toolbar
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

## Active Specs
(none — operating ad-hoc; specs will live in `docs/spec/`)

## Known Issues
- Dark/light theme not implemented (backlog)
- Pre-existing CSS warning: unused `.toggle-btn.disabled` selector in App.svelte
- Windows + macOS release artifacts ship unsigned
- Self-update on macOS / Windows is staged-only (downloads to `~/Downloads` and pops the file manager — no in-place install yet)
