# BGSD Harness Reference

Playwright harness (`harness/run.js`) drives the Electron app headless for screenshots and testing.

## Prerequisites (Docker / Fresh Linux)

The project runs on Electron, which needs system libraries that aren't always present in
minimal Docker images or CI containers. Install them before running the app or harness:

```bash
sudo apt-get update && sudo apt-get install -y \
  xvfb \
  libglib2.0-0 libnss3 libnspr4 libdbus-1-3 \
  libatk1.0-0 libatk-bridge2.0-0 libatspi2.0-0 \
  libcups2 libgtk-3-0 \
  libpango-1.0-0 libcairo2 \
  libxcomposite1 libxdamage1 \
  libgbm1 libxkbcommon0 \
  libasound2
```

**Quick check** — after install, this should print no output:
```bash
ldd node_modules/electron/dist/electron 2>&1 | grep "not found"
```

## Launch

**Interactive REPL:**
```bash
xvfb-run -a node harness/run.js
```

**Scripted (non-interactive):**
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

## REPL Commands

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
- `open <filepath>` — open a .scad file
- `render [label]` — render current SCAD with OpenSCAD to PNG in `harness/out/`
- `help` — list available REPL commands
- `quit` / `exit` / `q` — close app and exit

## Scrolling for Screenshots

The app content is inside a scrollable `<section class="content">` container (NOT the window).
Use `js` to scroll the content area:

```
js document.querySelector('[data-testid="content-area"]').scrollTop = 0      // top
js document.querySelector('[data-testid="content-area"]').scrollTop = 3000   // middle
js document.querySelector('[data-testid="content-area"]').scrollTop = 99999  // bottom
```

`window.scrollTo()` does NOT work — always scroll the content-area element.

## Env Vars

| Var | Purpose |
|-----|---------|
| `BGSD_OPEN=<path>` | Auto-open a .scad file on startup |
| `BGSD_WINDOW_WIDTH=1200` | Window width (app default: 1000, harness default: 800) |
| `BGSD_WINDOW_HEIGHT=900` | Window height (app default: 1200, harness default: 1600) |
| `BGSD_HARNESS_SCRIPT=<path>` | Path to file with newline-separated commands |
| `BGSD_HARNESS_COMMANDS=<cmds>` | Inline newline-separated commands (prefer BGSD_HARNESS_SCRIPT for complex scripts) |
| `BGSD_HARNESS=1` | Auto-set by harness; enables intent pane in app |
| `BGSD_HARNESS_TIMEOUT=<ms>` | Watchdog timeout (scripted default: 120000, interactive: 1800000) |
| `BGSD_SHOT_PREFIX=<name>` | Prefix for screenshot filenames (defaults to script filename) |

## data-testid Convention

Every interactive element gets a `data-testid` attribute so the REPL
can target by intent, not by pixel coordinates:
- `add-{i}` — "Add" button for row i (dynamic per-row)
- `element-N-name` — element name field (N = index)
- `element-N-expand` — expand/collapse toggle
- `element-N-delete` — delete element button
- `element-N-add-KEY` — add sub-node button (KEY = e.g. `BOX_FEATURE`)
- `kv-KEY-editor` — inline editor for a key (e.g. `kv-BOX_SIZE_XYZ-editor`)
- `kv-KEY-x`, `kv-KEY-y`, `kv-KEY-z` — individual fields for xyz types
- `kv-KEY-delete` — delete a key-value row
- `save-status` — save indicator in status bar
- `intent-text` — harness intent pane text area

## Intent Pane (in-app, always visible)

The app has a bottom strip that is always rendered and captured in every screenshot:
- **Intent**: large readable text showing what I expect to happen.
- **Step**: current step number.

This makes every screenshot self-describing: the intent text inside the image
says what should be true, and the rest of the image shows what actually happened.

## Test Scripts (`harness/scripts/`)

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
| `test-hide-defaults.txt` | Exercise per-block default parameter visibility, screenshot each state |

There are 43+ test scripts total. Run `ls harness/scripts/test-*.txt` for the full list.

**Run the full suite** (all scripts sequentially):

```bash
npm run build && \
for f in harness/scripts/test-*.txt; do
  BGSD_HARNESS_SCRIPT="$f" xvfb-run -a node harness/run.js
done
```
