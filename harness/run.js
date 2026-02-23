#!/usr/bin/env node
// BGSD Harness — Playwright-driven Electron REPL
// Usage: node harness/run.js

const { _electron: electron } = require("playwright");
const path = require("path");
const fs = require("fs");
const readline = require("readline");

const BGSD = path.resolve(__dirname, "..");
const OUT_DIR = path.join(__dirname, "out");
fs.mkdirSync(OUT_DIR, { recursive: true });

let shotCounter = 0;
// Resume counter from existing files
try {
  const files = fs.readdirSync(OUT_DIR).filter((f) => /^\d{3}_/.test(f));
  if (files.length) {
    const nums = files.map((f) => parseInt(f.split("_")[0], 10));
    shotCounter = Math.max(...nums) + 1;
  }
} catch {}

// Shot prefix: defaults to script filename (without extension) if running a script
let shotPrefix = process.env.BGSD_SHOT_PREFIX || "";
if (!shotPrefix && process.env.BGSD_HARNESS_SCRIPT) {
  shotPrefix = path.basename(process.env.BGSD_HARNESS_SCRIPT, path.extname(process.env.BGSD_HARNESS_SCRIPT));
}

let app, page;

async function screenshot(label) {
  const num = String(shotCounter++).padStart(3, "0");
  const parts = [num];
  if (shotPrefix) parts.push(shotPrefix);
  parts.push(label || "shot");
  const fname = parts.join("_") + ".png";
  const fpath = path.join(OUT_DIR, fname);
  await page.screenshot({ path: fpath });
  console.log(`  Screenshot: ${fname}`);
  return fname;
}

async function handleCommand(line) {
  const trimmed = line.trim();
  if (!trimmed) return;

  const parts = trimmed.match(/^(\S+)\s*(.*)/);
  if (!parts) return;
  const [, cmd, rest] = parts;

  try {
    switch (cmd) {
      case "shot":
        await screenshot(rest || "manual");
        break;

      case "click":
        await page.click(`[data-testid="${rest}"]`);
        console.log(`  Clicked: ${rest}`);
        await screenshot(`click_${rest}`);
        break;

      case "type": {
        const m = rest.match(/^(\S+)\s+"([^"]*)"/);
        if (!m) {
          console.log('  Usage: type <testid> "text"');
          break;
        }
        await page.fill(`[data-testid="${m[1]}"]`, m[2]);
        console.log(`  Typed "${m[2]}" into: ${m[1]}`);
        await screenshot(`type_${m[1]}`);
        break;
      }

      case "intent": {
        const text = rest.replace(/^"/, "").replace(/"$/, "");
        await page.fill('[data-testid="intent-text"]', text);
        await screenshot("intent");
        break;
      }

      case "act": {
        const m = rest.match(/^"([^"]*)"\s+(\S+)\s*(.*)/);
        if (!m) {
          console.log('  Usage: act "intent text" <command> <args>');
          break;
        }
        await page.fill('[data-testid="intent-text"]', m[1]);
        await handleCommand(`${m[2]} ${m[3]}`);
        break;
      }

      case "js": {
        const result = await page.evaluate(rest);
        console.log("  =>", JSON.stringify(result));
        break;
      }

      case "ipc": {
        // Send IPC message to renderer: ipc <channel> [json-args...]
        const m = rest.match(/^(\S+)\s*(.*)/);
        if (!m) { console.log("  Usage: ipc <channel> [json-args...]"); break; }
        const channel = m[1];
        const args = m[2] ? JSON.parse(m[2]) : undefined;
        await app.evaluate(({ BrowserWindow }, { channel, args }) => {
          const win = BrowserWindow.getAllWindows()[0];
          if (win) win.webContents.send(channel, args);
        }, { channel, args });
        await page.waitForTimeout(200); // let renderer process
        console.log(`  IPC: ${channel} ${m[2] || ""}`);
        break;
      }

      case "new": {
        // Create a new project without Save As dialog: new bit | new ctd
        const profile = rest.trim() || "bit";
        const result = await page.evaluate(
          (p) => window.bgsd.newProjectToPath(p),
          profile
        );
        await page.waitForTimeout(500);
        if (result?.ok) {
          console.log(`  New ${profile} project: ${result.filePath}`);
        } else {
          console.log(`  Failed: ${result?.error || "unknown"}`);
        }
        await screenshot(`new_${profile}`);
        break;
      }

      case "open": {
        // Open a file by path: open /path/to/file.scad
        const openPath = rest.trim();
        if (!openPath) { console.log("  Usage: open <filepath>"); break; }
        // Use the renderer's loadFilePath IPC then trigger handleLoad via menu-open
        const loadResult = await page.evaluate(
          async (fp) => {
            const r = await window.bgsd.loadFilePath(fp);
            return r;
          },
          openPath
        );
        if (loadResult?.ok) {
          // Send menu-open to renderer to trigger handleLoad
          await app.evaluate(({ BrowserWindow }, payload) => {
            const win = BrowserWindow.getAllWindows()[0];
            if (win) win.webContents.send("menu-open", payload);
          }, { data: loadResult.data, filePath: loadResult.filePath });
          await page.waitForTimeout(500);
          console.log(`  Opened: ${openPath}`);
        } else {
          console.log(`  Open failed: ${loadResult?.error || "unknown"}`);
        }
        await screenshot(`open_${path.basename(openPath, ".scad")}`);
        break;
      }

      case "scad": {
        // Print the current SCAD output (from hidden harness element)
        const scad = await page.evaluate(
          () => document.querySelector('[data-testid="scad-output"]')?.textContent || ""
        );
        if (scad) {
          console.log(scad);
        } else {
          console.log("  (no SCAD output — is a project loaded?)");
        }
        break;
      }

      case "render": {
        // Render current SCAD with OpenSCAD: render [label]
        const scad = await page.evaluate(
          () => document.querySelector('[data-testid="scad-output"]')?.textContent || ""
        );
        if (!scad) {
          console.log("  (no SCAD output — is a project loaded?)");
          break;
        }
        const renderLabel = rest.trim() || "render";
        const num = String(shotCounter++).padStart(3, "0");
        const renderParts = [num];
        if (shotPrefix) renderParts.push(shotPrefix);
        renderParts.push(renderLabel);
        const renderFname = renderParts.join("_") + ".png";
        const renderFpath = path.join(OUT_DIR, renderFname);
        // Write SCAD to a temp dir with proper lib/ structure for ../lib/ includes
        const os = require("os");
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bgsd_render_"));
        // Detect if SCAD uses ../lib/ includes (new structure) or flat includes
        const usesLibDir = /include\s*<\.\.\/lib\//.test(scad);
        const scadDir = usesLibDir ? path.join(tmpDir, "designs") : tmpDir;
        const libDir = usesLibDir ? path.join(tmpDir, "lib") : tmpDir;
        fs.mkdirSync(scadDir, { recursive: true });
        fs.mkdirSync(libDir, { recursive: true });
        const tmpScad = path.join(scadDir, "render.scad");
        fs.writeFileSync(tmpScad, scad, "utf-8");
        // Detect profile from include line and copy library files
        const profilesData = JSON.parse(
          fs.readFileSync(path.join(BGSD, "lib", "profiles.json"), "utf-8")
        );
        const userDataDir = await app.evaluate(({ app: eApp }) => eApp.getPath("userData"));
        for (const [profileId, prof] of Object.entries(profilesData)) {
          const re = new RegExp(prof.includePattern, "i");
          if (re.test(scad)) {
            const cacheDir = path.join(userDataDir, "lib-cache", profileId);
            for (const libFile of prof.files) {
              const basename = path.basename(libFile);
              const src = path.join(cacheDir, basename);
              if (fs.existsSync(src)) {
                fs.copyFileSync(src, path.join(libDir, basename));
              } else {
                console.log(`  WARNING: library file not cached: ${src}`);
              }
            }
            // For CTD designs that include publisher constants via ../lib/,
            // also copy all *_constants.scad from the workspace lib/ if available
            const workDirStatus = await page.evaluate(
              () => (async () => window.bgsd.getWorkingDirStatus())()
            );
            if (workDirStatus?.set) {
              const wsLibDir = path.join(workDirStatus.path, profileId, "lib");
              if (fs.existsSync(wsLibDir)) {
                for (const f of fs.readdirSync(wsLibDir)) {
                  if (f.endsWith(".scad")) {
                    const dst = path.join(libDir, f);
                    if (!fs.existsSync(dst)) {
                      fs.copyFileSync(path.join(wsLibDir, f), dst);
                    }
                  }
                }
              }
            }
            break;
          }
        }
        try {
          const { execSync } = require("child_process");
          execSync(`openscad -o "${renderFpath}" --autocenter --viewall --imgsize=800,600 "${tmpScad}"`, {
            timeout: 60000,
            stdio: ["ignore", "pipe", "pipe"],
          });
          console.log(`  OpenSCAD render: ${renderFname}`);
        } catch (err) {
          console.log(`  OpenSCAD render failed: ${err.message.split("\n")[0]}`);
        }
        // Clean up temp dir
        try {
          const { execSync: execClean } = require("child_process");
          execClean(`rm -rf "${tmpDir}"`);
        } catch {}
        break;
      }

      case "wait":
        await page.waitForSelector(`[data-testid="${rest}"]`, {
          timeout: 15000,
        });
        console.log(`  Found: ${rest}`);
        break;

      case "help":
        console.log(`
  Commands:
    shot <label>              Take screenshot
    click <testid>            Click element by data-testid
    type <testid> "text"      Fill element with text
    intent "text"             Set intent pane text + screenshot
    act "intent" cmd args     Set intent + execute + screenshot
    js <expression>           Evaluate JS in page
    ipc <channel> [json]      Send IPC to renderer
    wait <testid>             Wait for element
    new <bit|ctd>             Create new project (no dialog)
    open <filepath>           Open a .scad file by path
    scad                      Print current SCAD output
    render [label]            Render SCAD with OpenSCAD to PNG
    help                      Show this help
    quit                      Exit
`);
        break;

      case "quit":
      case "exit":
      case "q":
        await app.close();
        process.exit(0);

      default:
        console.log(`  Unknown command: ${cmd}. Type 'help'.`);
    }
  } catch (err) {
    console.log(`  Error: ${err.message}`);
  }
}

async function main() {
  console.log("Launching Electron...");

  const width = parseInt(process.env.BGSD_WINDOW_WIDTH || "800", 10);
  const height = parseInt(process.env.BGSD_WINDOW_HEIGHT || "1600", 10);

  app = await electron.launch({
    args: [path.join(BGSD, "main.js"), "--disable-gpu", "--no-sandbox"],
    env: {
      ...process.env,
      BGSD_WINDOW_WIDTH: String(width),
      BGSD_WINDOW_HEIGHT: String(height),
      BGSD_HARNESS: "1",
    },
  });

  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.setViewportSize({ width, height });
  console.log(`Window title: ${await page.title()}`);

  // Initial screenshot
  await screenshot("initial");

  // Optional non-interactive script mode (useful in CI / tool-driven runs)
  // Provide either:
  // - BGSD_HARNESS_SCRIPT=/path/to/commands.txt
  // - BGSD_HARNESS_COMMANDS='cmd1\ncmd2\n...'
  const scriptPath = process.env.BGSD_HARNESS_SCRIPT;
  const scriptInline = process.env.BGSD_HARNESS_COMMANDS;
  if (scriptPath || scriptInline) {
    try {
      const script = scriptPath
        ? fs.readFileSync(scriptPath, "utf-8")
        : String(scriptInline || "");
      const cmds = script.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      for (const cmd of cmds) {
        await handleCommand(cmd);
      }
    } catch (err) {
      console.error("Script failed:", err.message);
    }
    await app.close();
    process.exit(0);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "bgsd> ",
  });

  rl.prompt();
  rl.on("line", async (line) => {
    await handleCommand(line);
    rl.prompt();
  });
  rl.on("close", async () => {
    await app.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
