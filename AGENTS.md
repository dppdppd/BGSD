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
    scripts/              # Reusable test scripts (one command per line)
    out/                  # Screenshot output (accumulates, never cleared)
  lib/                    # Library profiles + manager (fetches from GitHub, caches in userData)
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

**Launch** (scripted, non-interactive — use a script file for complex commands):
```bash
cat <<'CMDS' > /tmp/bgsd-cmds.txt
wait app-root
shot welcome
js document.querySelector('[data-testid="content-area"]').scrollTop = 3000
shot scrolled
CMDS
BGSD_OPEN="/path/to/file.scad" \
  BGSD_WINDOW_WIDTH=1920 BGSD_WINDOW_HEIGHT=1080 \
  BGSD_HARNESS_SCRIPT=/tmp/bgsd-cmds.txt \
  xvfb-run -a node harness/run.js
```

Screenshots go to `harness/out/` with format `NNN_<prefix>_<label>.png`. The counter is monotonic and resumes from existing files, so screenshots never overwrite. When running a script, the prefix defaults to the script filename (e.g., `test-new-bit`).

### REPL Commands

- `shot <label>` — take screenshot (no auto-screenshot)
- `click <testid>` — click element by `data-testid` attribute + screenshot
- `type <testid> "text"` — fill element with text + screenshot
- `wait <testid>` — wait up to 15s for element to appear
- `intent "text"` — set the intent pane text + screenshot
- `act "intent" cmd args` — set intent + execute command + screenshot
- `js <expression>` — evaluate JavaScript in the renderer page context
- `ipc <channel> [json]` — send IPC message to renderer (args must be valid JSON)
- `new <bit|ctd>` — create a new project (writes to temp file, no dialog)
- `scad` — print the current SCAD output to stdout
- `render [label]` — render current SCAD with OpenSCAD to PNG in `harness/out/`
- `quit` / `exit` / `q` — close app and exit

### Scrolling for Screenshots

The app content is inside a scrollable `<section class="content">` container (NOT the window).
Use `js` to scroll the content area:

```
js document.querySelector('[data-testid="content-area"]').scrollTop = 0      // top
js document.querySelector('[data-testid="content-area"]').scrollTop = 3000   // middle
js document.querySelector('[data-testid="content-area"]').scrollTop = 99999  // bottom
```

`window.scrollTo()` does NOT work — always scroll the content-area element.

### App Env Vars (for headless/harness use)

| Var | Purpose |
|-----|---------|
| `BGSD_OPEN=<path>` | Auto-open a .scad file on startup |
| `BGSD_WINDOW_WIDTH=1200` | Window width (default: 800) |
| `BGSD_WINDOW_HEIGHT=900` | Window height (default: 1600) |
| `BGSD_HARNESS_SCRIPT=<path>` | Path to file with newline-separated commands |
| `BGSD_HARNESS_COMMANDS=<cmds>` | Inline newline-separated commands (prefer BGSD_HARNESS_SCRIPT for complex scripts) |
| `BGSD_HARNESS=1` | Auto-set by harness; enables intent pane in app |
| `BGSD_SHOT_PREFIX=<name>` | Prefix for screenshot filenames (defaults to script filename) |

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

### Test Scripts (`harness/scripts/`)

Reusable command files that serve as a regression test suite. Run any script with:

```bash
BGSD_HARNESS_SCRIPT=harness/scripts/<script>.txt xvfb-run -a node harness/run.js
```

For scripts that need a specific file loaded on startup, add `BGSD_OPEN`:

```bash
BGSD_OPEN=/path/to/file.scad \
  BGSD_HARNESS_SCRIPT=harness/scripts/<script>.txt \
  xvfb-run -a node harness/run.js
```

| Script | What it tests |
|--------|--------------|
| `test-new-bit.txt` | Create new BIT project, screenshot top/bottom, print SCAD |
| `test-new-ctd.txt` | Create new CTD project, screenshot top/bottom, print SCAD |
| `test-open-bit.txt` | Create BIT project, screenshot at scroll positions, print SCAD |
| `test-open-ctd.txt` | Create CTD project, screenshot at scroll positions, print SCAD |
| `test-scad-toggle.txt` | Toggle Show SCAD view on/off, screenshot both states |
| `test-hide-defaults.txt` | Toggle Hide Defaults on/off, screenshot both states |

**Run the full suite** (all scripts sequentially):

```bash
npm run build && \
for f in harness/scripts/test-*.txt; do
  BGSD_HARNESS_SCRIPT="$f" xvfb-run -a node harness/run.js
done
```

### After Each Change (developer protocol)

**CRITICAL: Every code change MUST be validated with screenshots before reporting completion.**

For every code change:

1. **Build**: `npm run build` — must succeed with no errors.
2. **Create a test script** for your change in `harness/scripts/`. Name it descriptively
   (e.g., `test-bracket-colors.txt`, `test-variable-rendering.txt`). The script should:
   - Load a relevant fixture or create a new project (`new bit` / `new ctd`)
   - Navigate to the areas affected by your change (scroll, toggle views, etc.)
   - Take `shot` screenshots at key states
   - Use `scad` to print SCAD output if the change affects output generation
   - Use `render` to produce an OpenSCAD PNG if the change affects SCAD structure
3. **Run the script**:
   ```bash
   BGSD_HARNESS_SCRIPT=harness/scripts/test-your-change.txt \
     xvfb-run -a node harness/run.js
   ```
   Or with a specific SCAD file:
   ```bash
   BGSD_OPEN=/path/to/file.scad \
     BGSD_HARNESS_SCRIPT=harness/scripts/test-your-change.txt \
     xvfb-run -a node harness/run.js
   ```
   Screenshots are automatically prefixed with the script name
   (e.g., `009_test-your-change_welcome.png`) so they never collide.
4. **Inspect screenshots**: Read the images in `harness/out/` to visually verify.
5. **Report**: State what you expected (1-3 bullets) + which screenshot files confirm it.
6. **Fix before moving on**: If screenshots reveal issues, fix and re-run before reporting completion.

Never skip the screenshot step. Never report a change as complete without visual verification.

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

## Backlog

- [ ] Reorder list items (components)
- [ ] Duplicate element/component
- [ ] Cross-platform release builds (electron-builder)
- [ ] Keyboard shortcuts (Ctrl+O, Ctrl+S, Ctrl+Shift+S)
- [ ] Undo/redo
- [ ] Dark/light theme
- [ ] Recent files list
