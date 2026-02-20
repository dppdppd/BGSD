# BGSD (Boardgame SCAD Designer) — Agent Instructions

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
      components/         # Tree, inline editors, key picker, options menu
      schema/             # Schema loader + helpers
      stores/             # Svelte stores (project state, autosave, settings)
    App.svelte
    main.ts
  main.js                 # Electron main process
  preload.js              # Electron preload (contextBridge)
  schema/
    bit.schema.json       # Authoritative GUI schema
    generate_schema.py    # Script: parse v4 .scad -> regenerate schema
  harness/
    run.js                # Playwright-driven REPL (launch + screenshot + interact)
    out/                  # Screenshot output (accumulates, never cleared)
  lib/                    # Bundled BIT library files (shipped with app)
  test-fixtures/          # Sample .scad files for testing
  dist/                   # Vite build output (loaded by Electron)
  package.json
  vite.config.mjs
```

## Commands

```bash
npm install
npm run build          # Vite builds frontend to dist/
npm start              # Launch Electron app
npm run dev            # Watch + launch (concurrent)
```

## Dev Loop

```
1. Edit Svelte components in src/
2. Build: npm run build
3. Launch: xvfb-run -a node harness/run.js
4. Drive via REPL: intent + interact (click, type, toggle, wait, shot)
5. Inspect screenshots in harness/out/
```

Elements use `data-testid` attributes for harness targeting (e.g., `element-N-name`, `kv-KEY-editor`, `add-element`).

## Harness

The Playwright harness (`harness/run.js`) drives the Electron app headless for screenshots.

**Prerequisite**: `xvfb` is NOT in the Docker image; install before first use:
```bash
sudo apt-get update && sudo apt-get install -y xvfb
```

**Launch** (interactive REPL):
```bash
xvfb-run -a node harness/run.js
```

**Launch** (scripted, non-interactive):
```bash
BITGUI_OPEN="../path/to.scad" \
  BITGUI_WINDOW_WIDTH=1920 BITGUI_WINDOW_HEIGHT=1080 \
  BITGUI_HARNESS_COMMANDS=$'wait app-root\nshot label' \
  xvfb-run -a node harness/run.js
```

Screenshots go to `harness/out/` (monotonic counter, never cleared).

### REPL Commands

Every command auto-screenshots after execution:
- `shot <label>` — screenshot only
- `click <css>` — click an element
- `type <css> "<text>"` — clear + type into an element
- `toggle <css>` — click a checkbox/toggle
- `wait <css>` — wait until element is visible
- `intent "<text>"` — set the intent pane text (visible in next screenshot)
- `act "<intent text>" <command> <args>` — set intent + execute + screenshot (one-liner shorthand)

### App Env Vars (for headless/harness use)

| Var | Purpose |
|-----|---------|
| `BITGUI_TEST_PROJECT_DIR=/path` | Auto-open this project on startup |
| `BITGUI_AUTOSAVE_DEBOUNCE_MS=0` | Instant save (no debounce delay) |
| `BITGUI_DISABLE_PROMPTS=1` | Suppress modal dialogs |
| `BITGUI_WINDOW_WIDTH=1200` | Window width for screenshots |
| `BITGUI_WINDOW_HEIGHT=900` | Window height for screenshots |
| `BITGUI_OPEN=<path>` | Open a specific .scad file on startup |
| `BITGUI_HARNESS_COMMANDS=<cmds>` | Newline-separated commands for non-interactive mode |

### data-testid Convention

Every interactive element gets a `data-testid` attribute so the REPL
can target by intent, not by pixel coordinates:
- `add-element` — top-level "Add Element" button
- `element-N-name` — element name field (N = index)
- `element-N-expand` — expand/collapse toggle
- `element-N-delete` — delete element button
- `element-N-add-param` — "Add Parameter" button
- `kv-KEY-editor` — inline editor for a key (e.g. `kv-BOX_SIZE_XYZ-editor`)
- `kv-KEY-x`, `kv-KEY-y`, `kv-KEY-z` — individual fields for xyz types
- `kv-KEY-delete` — delete a key-value row
- `keypicker-search` — key picker search input
- `keypicker-item-KEY` — key picker result item
- `options-open` — options menu button
- `save-status` — save indicator in status bar
- `intent-text` — harness intent pane text area
- `intent-step` — harness step counter

### Intent Pane (in-app, always visible)

The app has a bottom strip that is always rendered and captured in every screenshot:
- **Intent**: large readable text showing what I expect to happen.
- **Step**: current step number.

This makes every screenshot self-describing: the intent text inside the image
says what should be true, and the rest of the image shows what actually happened.

### After Each Change (developer protocol)

For every code change:
1. State what I expect (1-3 bullets).
2. Launch harness, set intent text, interact with the GUI.
3. Inspect screenshots in `harness/out/`.
4. Report: expectation + screenshot filenames used to confirm.

No prescripted test scenarios. The developer articulates the expected behavior,
interacts to confirm it, and the screenshots are the evidence.

## Key Design Decisions

- **SCAD file = source of truth**: GUI preserves user code, comments, and preamble/postamble
- **Schema-driven UI**: All controls generated from `bit.schema.json` -- no hardcoded parameter UI
- **Line-based preservation**: Importer classifies lines by kind/role instead of building AST; saves produce minimal diffs
- **Harness-driven development**: Real app tested headlessly via Playwright; intent pane makes screenshots self-describing

## Code Style

- **Svelte**: Runes syntax (`$state`, `$derived`, `$effect`), kebab-case filenames
- **Git commits**: `type(scope): message` (e.g., `feat:`, `fix:`, `docs:`)

## Common BIT Parameters Quick Reference

### Element-level (inside OBJECT_BOX)
`NAME`, `BOX_SIZE_XYZ`, `BOX_FEATURE`, `BOX_LID`, `BOX_NO_LID_B`, `BOX_STACKABLE_B`, `ENABLED_B`

### Feature-level (inside BOX_FEATURE)
`FTR_COMPARTMENT_SIZE_XYZ`, `FTR_NUM_COMPARTMENTS_XY`, `FTR_SHAPE` (SQUARE/HEX/HEX2/OCT/OCT2/ROUND/FILLET), `FTR_SHAPE_ROTATED_B`, `FTR_SHAPE_VERTICAL_B`, `FTR_PADDING_XY`, `FTR_PADDING_HEIGHT_ADJUST_XY`, `FTR_MARGIN_FBLR`, `FTR_CUTOUT_SIDES_4B`, `FTR_CUTOUT_CORNERS_4B`, `FTR_CUTOUT_HEIGHT_PCT`, `FTR_CUTOUT_DEPTH_PCT`, `FTR_CUTOUT_WIDTH_PCT`, `FTR_CUTOUT_BOTTOM_B`, `FTR_CUTOUT_BOTTOM_PCT`, `FTR_CUTOUT_TYPE` (INTERIOR/EXTERIOR/BOTH), `FTR_SHEAR`, `FTR_FILLET_RADIUS`, `FTR_PEDESTAL_BASE_B`, `POSITION_XY`, `ROTATION`

### Lid-level (inside BOX_LID)
`LID_SOLID_B`, `LID_HEIGHT`, `LID_FIT_UNDER_B`, `LID_INSET_B`, `LID_PATTERN_RADIUS`, `LID_PATTERN_N1/N2`, `LID_PATTERN_ANGLE`, `LID_PATTERN_ROW_OFFSET/COL_OFFSET`, `LID_PATTERN_THICKNESS`, `LID_CUTOUT_SIDES_4B`, `LID_LABELS_INVERT_B`, `LID_SOLID_LABELS_DEPTH`, `LID_LABELS_BG_THICKNESS`, `LID_LABELS_BORDER_THICKNESS`, `LID_STRIPE_WIDTH/SPACE`, `LID_TABS_4B`

### Label-level (inside BOX_LID, BOX_FEATURE, or box-level)
`LBL_TEXT`, `LBL_SIZE` (number or AUTO), `LBL_PLACEMENT` (FRONT/BACK/LEFT/RIGHT/FRONT_WALL/BACK_WALL/LEFT_WALL/RIGHT_WALL/CENTER/BOTTOM), `LBL_FONT`, `LBL_DEPTH`, `LBL_SPACING`, `LBL_IMAGE`, `ROTATION`, `POSITION_XY`

### Divider-level
`DIV_TAB_TEXT`, `DIV_TAB_SIZE_XY`, `DIV_TAB_RADIUS`, `DIV_TAB_CYCLE`, `DIV_TAB_CYCLE_START`, `DIV_TAB_TEXT_SIZE/FONT/SPACING`, `DIV_TAB_TEXT_EMBOSSED_B`, `DIV_FRAME_SIZE_XY`, `DIV_FRAME_NUM_COLUMNS`, `DIV_FRAME_COLUMN`, `DIV_FRAME_TOP/BOTTOM/RADIUS`, `DIV_THICKNESS`

### Globals (as `[G_*, value]` pairs in data array)
`G_PRINT_LID_B`, `G_PRINT_BOX_B`, `G_ISOLATED_PRINT_BOX`, `G_VISUALIZATION_B`, `G_VALIDATE_KEYS_B`, `G_WALL_THICKNESS`, `G_TOLERANCE`, `G_TOLERANCE_DETENT_POS`, `G_DEFAULT_FONT`, `G_PRINT_MMU_LAYER`
