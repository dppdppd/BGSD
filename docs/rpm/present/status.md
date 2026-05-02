# BGSD — Present State

## Project Status
- **Current phase**: 0.5.x — feature polish (welcome screen, schema coverage, defaults UX)
- **Latest release**: v0.5.12 (2026-05-01) — https://github.com/dppdppd/BGSD/releases/tag/v0.5.12
- **Last updated**: 2026-05-01

## Completed Work
- Cross-platform release builds via electron-builder
- Welcome screen with library tree + per-file context menu (Edit / **Rename** / Delete / Export STL)
- Inline rename UI for user files (Electron suppresses `window.prompt()`, so the menu uses an inline edit pattern)
- Favorites + Show-Defaults (All/Favorites/None) radio
- Undo/redo, recent files, keyboard shortcuts
- CHAMFER_N schema entry; LBL_FONT default fix
- Lid defaults visibility fix (non-merged BOX_LID close resolves to lid context)
- Virtual BOX_LID params sort alphabetically — no resort when first param is edited
- Library update always overwrites base libs (`boardgame_insert_toolkit_lib.4.scad`, `counter_tray_designer_lib.1.scad`, `global_constants.scad`); publisher/game examples still respect the writable-skip

## Active Specs
(none — operating ad-hoc; specs will live in `docs/spec/`)

## Known Issues
- Dark/light theme not implemented (backlog)
- Pre-existing CSS warning: unused `.toggle-btn.disabled` selector in App.svelte
- Windows + macOS release artifacts ship unsigned (no codesign cert; macOS codesign requires macOS host)
