# BGSD (Board Game Solutions Designer) — Agent Instructions

## Project Overview

Cross-platform desktop GUI for constructing Boardgame Insert Toolkit (BIT) design files.
Eliminates the need to memorize parameter keys/types/defaults by providing a visual editor
that generates `.scad` files for OpenSCAD rendering.

- **Tech stack**: Electron 33 + Svelte 5 (runes) + Vite 6 + Playwright (harness)
- **License**: CC BY-NC-SA 4.0
- **Repo**: https://github.com/dppdppd/BGSD

## Architecture

**Line-based model** — the importer (`importer.js`) parses `.scad` files into `Line` objects preserving every line as-is (kind, depth, role, kvKey/kvValue). This enables round-trip editing with minimal git diff noise.

### Key Modules

| Module | Purpose |
|--------|---------|
| `importer.js` | SCAD parser -> line-based model (bracket matching, v2/v3 conversion) |
| `src/lib/stores/project.ts` | Svelte store with line mutations (updateKv, deleteLine, insertLine, etc.) |
| `src/lib/schema.ts` | Loads `schema/bit.schema.json`; provides context-aware key lookups |
| `src/lib/scad.ts` | Reconstructs `.scad` from project state |
| `src/lib/autosave.ts` | Debounced file I/O |
| `main.js` | Electron main process (IPC: open/save/OpenSCAD launch) |
| `preload.js` | Context bridge (`window.bitgui` API) |
| `schema/bit.schema.json` | Single source of truth for all parameter types, defaults, enums |

**Schema contexts** (hierarchy): `element` -> `feature`, `lid`, `label`, `divider`

### Repo Layout

```
BGSD/
  src/                    # Svelte frontend
    lib/
      components/         # Tree, inline editors, element nodes, KV rows
      schema.ts           # Schema loader + helpers
      stores/             # Svelte stores (project state, autosave, settings)
    App.svelte
    main.ts
  main.js                 # Electron main process
  preload.js              # Electron preload (contextBridge)
  schema/
    bit.schema.json       # Authoritative BIT GUI schema
    ctd.schema.json       # Authoritative CTD GUI schema
  harness/
    run.js                # Playwright-driven REPL (launch + screenshot + interact)
    scripts/              # Reusable test scripts (one command per line)
    out/                  # Screenshot output (accumulates, never cleared)
  tests/                  # Unit tests (vitest) + SCAD fixture files
  lib/                    # Library profiles + manager (fetches from GitHub, caches in userData)
  dist/                   # Vite build output (loaded by Electron)
  package.json
  vite.config.mjs
```

## Commands

```bash
npm install
npm run build          # Run unit tests + Vite build to dist/
npm start              # Launch Electron app
npm run dev            # Watch + launch (concurrent)
npm test               # Run unit tests (vitest)
npm run test:watch     # Run tests in watch mode
npm run lint           # Run ESLint
npm run format         # Run Prettier on src/
```

## Dev Loop

1. Edit Svelte components in `src/`
2. `npm run build` (runs tests + builds)
3. `xvfb-run -a node harness/run.js` — drive via REPL, inspect screenshots in `harness/out/`

Elements use `data-testid` attributes for harness targeting. See [HARNESS.md](docs/guidance/HARNESS.md) for full REPL commands, env vars, testid conventions, and test scripts.

## Verification Gate

**CRITICAL: All gates must pass before committing any code change.**

```bash
# 1. Build (includes unit tests)
npm run build

# 2. Harness screenshots — must visually match expectations
BGSD_HARNESS_SCRIPT=harness/scripts/test-new-bit.txt xvfb-run -a node harness/run.js
BGSD_HARNESS_SCRIPT=harness/scripts/test-new-ctd.txt xvfb-run -a node harness/run.js
```

| Area affected | Also run |
|---|---|
| SCAD output / preview pane | `test-scad-toggle.txt` |
| Default value display | `test-hide-defaults.txt` |
| BIT file loading | `test-open-bit.txt` |
| CTD file loading | `test-open-ctd.txt` |

After running, **read the screenshots** in `harness/out/` to visually verify correctness.

If your change touches UI behavior, **create a test script** in `harness/scripts/` named descriptively (e.g., `test-bracket-colors.txt`). Run it, inspect output, and report which screenshots confirm correctness. Never skip visual verification.

## Key Design Decisions

- **SCAD file = source of truth**: GUI preserves user code, comments, and preamble/postamble
- **Schema-driven UI**: All controls generated from schema JSON — no hardcoded parameter UI
- **Line-based preservation**: Importer classifies lines by kind/role instead of building AST; saves produce minimal diffs
- **Harness-driven development**: Real app tested headlessly via Playwright; intent pane makes screenshots self-describing
- **Electron over Tauri**: Tauri was attempted first but WebKit2GTK had fundamental JS execution issues in containers (modules not loading, CSP blocking inline scripts). Electron works reliably headless with zero configuration.

## SCAD Output Formatting

The generator (`src/lib/scad.ts`) produces `.scad` text from project state:

- 4-space indentation
- Keys: unquoted OpenSCAD constants (e.g. `BOX_SIZE_XYZ`)
- Booleans: `true` / `false`
- Numbers: bare (integer or decimal)
- Strings: `"double-quoted"`
- Vectors: `[a, b, c]` (space after comma)
- Nested tables: each `[KEY, VALUE]` pair on its own line, indented
- Only emits keys that differ from their schema defaults (keeps output clean)

## Code Style

- **Svelte**: Runes syntax (`$state`, `$derived`, `$effect`), kebab-case filenames
- **Git commits**: `type(scope): message` (e.g., `feat:`, `fix:`, `docs:`)

## Reference Docs

| Doc | Content |
|-----|---------|
| [HARNESS.md](docs/guidance/HARNESS.md) | Harness REPL, env vars, testids, test scripts, prerequisites |
| [RELEASE.md](docs/guidance/RELEASE.md) | Build-release script, platform binaries, GitHub Releases |
| [BIT-PARAMETERS.md](docs/guidance/BIT-PARAMETERS.md) | BIT parameter frequency from real designs |
| [CTD-PARAMETERS.md](docs/guidance/CTD-PARAMETERS.md) | CTD parameter frequency from real designs |

## Backlog

- [ ] Reorder list items (components)
- [ ] Duplicate element/component
- [ ] Cross-platform release builds (electron-builder)
- [ ] Keyboard shortcuts (Ctrl+O, Ctrl+S, Ctrl+Shift+S)
- [x] Undo/redo
- [ ] Dark/light theme
- [ ] Recent files list
