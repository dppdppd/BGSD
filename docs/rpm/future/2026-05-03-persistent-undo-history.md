# Persistent undo history sidecar files

## Description

Add durable file history for edited `.scad` files by writing a sidecar
`<file>.undo` next to the design file. The sidecar should store a compact
text-diff based history of saved file revisions, so BGSD can reload prior
states after app restart and let the user walk backward/forward through file
history. The history browser should list saved versions, let users label
important versions, and pin versions so retention cleanup never removes them.
The same history model should also be able to seed or mirror the current
in-memory undo/redo stack.

## Current state

- Renderer undo/redo is memory-only in `src/lib/stores/history.ts`.
- History snapshots are full `Line[]` clones capped by `MAX_HISTORY`.
- Autosave regenerates SCAD text in `src/lib/autosave.ts` and writes through
  `window.bgsd.saveFile(...)`.
- The main process owns file writes in `main.js` via the `save-file` IPC
  handler and already performs first-save `.bak` backup creation.
- Import and reload already rebuild the line model from text through
  `importer.js`, which is the right recovery path for persisted text history.

## Plan

### Proposed behavior

- For every editable saved SCAD file, maintain a sidecar at `<file>.undo`.
- Store a sequence of text patches between saved SCAD revisions, plus enough
  metadata to reconstruct checkpoints safely:
  - sidecar format version
  - source file path or basename
  - base revision hash
  - entries with timestamp, previous hash, next hash, unified diff text,
    optional label, and pinned flag
- Load the sidecar when opening a file and expose a history browser that can
  move to earlier/later revisions.
- Provide a history lister that shows versions newest-first with timestamp,
  revision id, hash prefix, label, pinned state, and a short change summary
  such as changed line count.
- Let users label versions with short free text such as `before tray split`,
  `printed v1`, or `stable fit`.
- Let users pin/unpin versions; pinned versions are protected from automatic
  pruning and are visually distinct in the lister.
- Applying a historical revision should parse the reconstructed SCAD text with
  `importScad(...)` and replace `project.lines`, rather than trying to mutate
  individual `Line` objects from a patch.
- Keep normal Ctrl+Z/Ctrl+Y fast and memory-local during editing, but seed the
  memory stack from persisted revisions where practical after load.

### Implementation steps

1. Add a small history sidecar module in the main process, likely
   `lib/undo-sidecar.js` or `src/lib/undo-sidecar.ts` if bundled for renderer
   use is needed.
   - Define the `.undo` JSON shape.
   - Generate and apply unified text diffs.
   - Validate hashes before appending or replaying.
2. Update `main.js` `save-file` flow:
   - read the previous on-disk SCAD before `atomicWrite`
   - after a successful write, append a diff entry to `<file>.undo`
   - skip appending when old and new content hashes match
   - handle corrupt or mismatched sidecars by preserving them as
     `<file>.undo.bad-<timestamp>` and starting fresh
3. Add IPC in `main.js` / `preload.js` for history access:
   - `getUndoHistory(filePath)`
   - `listUndoHistory(filePath)` if listing needs a separate lightweight
     endpoint from full reconstruction
   - `loadUndoRevision(filePath, revisionId)`
   - `labelUndoRevision(filePath, revisionId, label)`
   - `pinUndoRevision(filePath, revisionId, pinned)`
   - optionally `pruneUndoHistory(filePath, keepCount)`
4. Extend `src/lib/stores/history.ts` without replacing its current stack:
   - keep in-memory `Line[]` snapshots for immediate undo/redo
   - add an explicit `restoreLinesFromHistory(lines)` helper that suppresses
     accidental extra history entries while replacing project state
   - expose metadata for whether persisted history is available
5. Add renderer UI:
   - a File or Edit menu item such as `File History...`
   - a compact modal listing timestamped revisions newest-first
   - row controls for Preview, Restore, Pin/Unpin, and Label/Rename
   - a filter or toggle for pinned versions if the list gets long
   - clear display of revision id/hash prefix so screenshots and bug reports
     can refer to a specific version
   - clear messaging when no sidecar exists
6. Decide retention:
   - cap by entry count, total sidecar bytes, or both
   - default to a conservative value matching the spirit of `MAX_HISTORY`
   - never prune pinned versions or the only recoverable base revision
   - if pinned revisions make the sidecar exceed the size cap, warn rather than
     silently dropping user-marked history

### Format notes

- Prefer unified text diffs over serialized `Line[]` snapshots because the
  SCAD text is the source of truth and is more durable across importer changes.
- Include hashes for both sides of every patch so sidecar replay can fail
  closed instead of reconstructing silently wrong text.
- Store labels and pinned flags as metadata on revisions, not inside the diff
  body, so metadata edits do not create synthetic file-content revisions.
- Prefer stable generated revision ids over list indices; list positions change
  when versions are pruned or sorted.
- Avoid using `.undo` as an autosave conflict recovery file; it is revision
  history, while `.bak` remains the first-save backup.

### Verification

- Unit tests:
  - diff append and replay reconstruct exact SCAD text
  - no-op saves do not append entries
  - labels and pinned flags persist without changing reconstructed SCAD text
  - retention prunes unpinned versions but keeps pinned versions
  - corrupt sidecar is quarantined without blocking save
  - restored text imports into the expected `Line[]`
- Build gate:
  - `npm run build`
- Harness:
  - create/open a BIT file, make two edits, force saves, open file history,
    restore the first revision, and verify editor plus SCAD pane update
  - label and pin a revision, close/reopen the file, and verify the lister
    still shows the label and pinned state
  - repeat with CTD if the UI path is shared with profile-specific files

### Risks

- A bad patch chain could make history unusable, so hash checks and periodic
  full checkpoints may be worth adding before the feature ships.
- Autosave can produce many small entries; debounce behavior and retention
  need to keep `.undo` files from growing without bound.
- Restoring old text should mark the project dirty and autosave normally, but
  must not create duplicate in-memory undo entries during the restore itself.
