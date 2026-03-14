# BGSD Improvement Proposals — 2026-03-14

## High Impact, Low Effort

1. **Replace silent error suppression with logging** — `main.js` has multiple `catch (_) {}` blocks that silently swallow errors. Add `console.error(...)` at minimum.

2. **Use `structuredClone` instead of `JSON.parse(JSON.stringify(...))`** — `src/lib/stores/history.ts` uses the slow JSON round-trip for cloning. `structuredClone()` is native and faster.

3. **Centralize magic constants** — `MAX_RECENT`, `DEBOUNCE_MS`, `MAX_HISTORY`, indent size are scattered. A single `src/lib/config.ts` would make them discoverable.

4. **Memoize schema context lookups** — `schema.ts` recomputes context keys on every call. The schema is static at runtime; cache the results.

## High Impact, Medium Effort

5. **Split `App.svelte` (2,811 lines)** — Extract `WelcomeScreen`, `PreferencesModal`, `LibraryBrowser`, `ScadPreview`, `EditorToolbar`.

6. **Add unit tests for critical paths** — Zero unit tests exist. Add Vitest for `importer.js`, `project.ts`, `scad.ts`.

7. **Add ESLint + Prettier** — No linting or formatting configured.

## Medium Impact, Low Effort

8. **Add missing accessibility attributes** — Expand/collapse toggles lack `aria-expanded`, `aria-label`.

9. **Validate file paths against traversal** — `isInsideWorkingDir()` exists for saves but not all reads.

10. **Standardize IPC error handling** — Mix of `{ ok, error }` returns and throws. Pick one pattern.

## From Existing Backlog

- Reorder list items (drag-and-drop)
- Duplicate element/component
- Keyboard shortcuts (Ctrl+O, Ctrl+S, Ctrl+Shift+S)
- Dark/light theme
- Recent files list UI
