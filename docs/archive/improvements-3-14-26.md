# BGSD Improvement Proposals — 2026-03-14

## High Impact, Low Effort

1. [x] **Replace silent error suppression with logging** — `main.js` has multiple `catch (_) {}` blocks that silently swallow errors. Add `console.error(...)` at minimum.

2. [x] **Use `structuredClone` instead of `JSON.parse(JSON.stringify(...))`** — `src/lib/stores/history.ts` uses the slow JSON round-trip for cloning. `structuredClone()` is native and faster.

3. [x] **Centralize magic constants** — `MAX_RECENT`, `DEBOUNCE_MS`, `MAX_HISTORY`, indent size are scattered. A single `src/lib/config.ts` would make them discoverable.

4. [x] **Memoize schema context lookups** — `schema.ts` recomputes context keys on every call. The schema is static at runtime; cache the results.

## High Impact, Medium Effort

5. [x] **Split `App.svelte` (2,811 → 2,529 lines)** — Extracted `WelcomeScreen`, `PreferencesModal`, `ScadPreview`.

6. [x] **Add unit tests for critical paths** — 38 tests via Vitest covering `importer.js`, `scad.ts`, `formatKvValue`.

7. [x] **Add ESLint + Prettier** — ESLint 9 + eslint-config-prettier + Prettier configured.

## Medium Impact, Low Effort

8. [x] **Add missing accessibility attributes** — `aria-expanded`, `aria-label`, `aria-pressed` on toggle buttons.

9. [x] **Validate file paths against traversal** — `validateFilePath()` added and applied to all read/exec handlers.

10. [x] **Standardize IPC error handling** — Documented three-pattern convention (ok/error, raw data, void).

## From Existing Backlog

- Reorder list items (drag-and-drop)
- Duplicate element/component
- Keyboard shortcuts (Ctrl+O, Ctrl+S, Ctrl+Shift+S)
- Dark/light theme
- Recent files list UI
