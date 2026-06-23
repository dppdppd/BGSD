const { app, BrowserWindow, ipcMain, dialog, Menu, shell, net } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Buffer } = require("buffer");
const { importScad } = require("./importer");
const { ensureLatestLibrary, ensureLibraryForInclude, initWorkingDir, updateLibraries, checkLibraryUpdates, fetchLatestReleaseTag, getInstalledLibraryVersions, isInsideWorkingDir, isRepoFile, loadManifest, profiles, setProxy } = require("./lib/library-manager");
const { parseConstantsFile } = require("./lib/constants-parser");
const { createStlExportPlan } = require("./lib/stl-export");
const undoSidecar = require("./lib/undo-sidecar");

// Prevent GPU-related crashes on Windows (packaged exe doesn't get --disable-gpu)
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("no-sandbox");

let mainWindow;

// --- Recent files ---
const RECENT_FILE = path.join(app.getPath("userData"), "recent-files.json");
const MAX_RECENT = 10;

// --- Preferences ---
const PREFS_FILE = path.join(app.getPath("userData"), "preferences.json");
const DEFAULT_PREFS = { openScadPath: "", autoOpenInOpenScad: true, workingDir: "", proxy: "", theme: "light" };
let openScadAlive = false;
let openScadProc = null;
let openScadFile = null;
let pendingReadOnlyPrompt = false;

// Local YYYYMMDD-HHMMSS stamp for default new-file names — easier to
// read at a glance and to sort chronologically than the raw epoch.
function fileTimestamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function appIconPath() {
  const candidates = process.platform === "win32"
    ? ["build/icon.ico", "build/icon-256.png", "build/icon.png"]
    : ["build/icon.png", "build/icon-256.png"];
  for (const rel of candidates) {
    const file = path.join(__dirname, rel);
    if (fs.existsSync(file)) return file;
  }
  return undefined;
}

function loadPrefs() {
  try {
    if (fs.existsSync(PREFS_FILE)) {
      return { ...DEFAULT_PREFS, ...JSON.parse(fs.readFileSync(PREFS_FILE, "utf-8")) };
    }
  } catch (err) { console.error("Failed to load preferences:", err); }
  return { ...DEFAULT_PREFS };
}

function savePrefs(prefs) {
  try { fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2), "utf-8"); } catch (err) { console.error("Failed to save preferences:", err); }
}

function loadRecent() {
  try {
    if (fs.existsSync(RECENT_FILE)) return JSON.parse(fs.readFileSync(RECENT_FILE, "utf-8"));
  } catch (err) { console.error("Failed to load recent files:", err); }
  return [];
}

function saveRecent(list) {
  try { fs.writeFileSync(RECENT_FILE, JSON.stringify(list), "utf-8"); } catch (err) { console.error("Failed to save recent files:", err); }
}

function addRecent(filePath) {
  let list = loadRecent().filter(f => f !== filePath);
  list.unshift(filePath);
  if (list.length > MAX_RECENT) list = list.slice(0, MAX_RECENT);
  saveRecent(list);
  rebuildMenu();
}

const INCLUDE_RE = /^\s*include\s*<\s*(.+?)\s*>\s*;?\s*(?:\/\/.*)?$/gmi;

async function ensureLibrariesForScadText(scadText, filePath) {
  const prefs = loadPrefs();
  const results = [];
  const seen = new Set();
  for (const match of String(scadText || "").matchAll(INCLUDE_RE)) {
    const includeFile = match[1].trim();
    if (seen.has(includeFile)) continue;
    seen.add(includeFile);
    try {
      const result = await ensureLibraryForInclude(includeFile, filePath, { workingDir: prefs.workingDir });
      if (result) results.push(result);
    } catch (err) {
      results.push({ ok: false, includeFile, error: err.message });
      console.warn(`[library] failed to ensure ${includeFile}:`, err.message);
    }
  }
  return results;
}

async function importScadWithLibraries(content, filePath) {
  const libraryEnsures = await ensureLibrariesForScadText(content, filePath);
  const project = importScad(content);
  return { project, libraryEnsures };
}

async function openFilePath(filePath) {
  if (!validateFilePath(filePath)) {
    console.error("Open rejected: invalid file path", filePath);
    return;
  }
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const fileState = fileSnapshot(filePath, content);
    const { project, libraryEnsures } = await importScadWithLibraries(content, filePath);
    mainWindow.webContents.send("menu-open", { data: project, filePath, fileState, libraryEnsures });
    addRecent(filePath);
  } catch (err) {
    console.error("Open failed:", err.message);
  }
}

function rebuildMenu() {
  const recentFiles = loadRecent();
  const recentSubmenu = recentFiles.length > 0
    ? [
        ...recentFiles.map(f => ({
          label: path.basename(f),
          sublabel: f,
          click: () => openFilePath(f),
        })),
        { type: "separator" },
        { label: "Clear Recent", click: () => { saveRecent([]); rebuildMenu(); } },
      ]
    : [{ label: "No Recent Files", enabled: false }];

  const menuTemplate = [
    {
      label: "File",
      submenu: [
        {
          label: "New",
          submenu: [
            {
              label: "BIT — Storage Insert",
              accelerator: "CmdOrCtrl+N",
              click: () => mainWindow.webContents.send("menu-new", "bit"),
            },
            {
              label: "CTD — Counter Tray",
              click: () => mainWindow.webContents.send("menu-new", "ctd"),
            },
          ],
        },
        {
          label: "Open...",
          accelerator: "CmdOrCtrl+O",
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow, {
              title: "Open SCAD File",
              filters: [{ name: "OpenSCAD", extensions: ["scad"] }],
              properties: ["openFile"],
            });
            if (!result.canceled) openFilePath(result.filePaths[0]);
          },
        },
        {
          label: "Open Recent",
          submenu: recentSubmenu,
        },
        {
          label: "Save Version",
          accelerator: "CmdOrCtrl+S",
          click: () => mainWindow.webContents.send("menu-save"),
        },
        {
          label: "Save As...",
          accelerator: "CmdOrCtrl+Shift+S",
          click: () => mainWindow.webContents.send("menu-save-as"),
        },
        {
          label: "Version History...",
          click: () => mainWindow.webContents.send("menu-file-history"),
        },
        { type: "separator" },
        {
          label: "Preferences...",
          accelerator: "CmdOrCtrl+,",
          click: () => mainWindow.webContents.send("menu-preferences"),
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        {
          label: "Undo",
          accelerator: "CmdOrCtrl+Z",
          click: () => mainWindow.webContents.send("menu-undo"),
        },
        {
          label: "Redo",
          accelerator: "CmdOrCtrl+Shift+Z",
          click: () => mainWindow.webContents.send("menu-redo"),
        },
        {
          label: "Redo",
          accelerator: "CmdOrCtrl+Y",
          visible: false,
          click: () => mainWindow.webContents.send("menu-redo"),
        },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          id: "show-scad",
          label: "Show SCAD",
          type: "checkbox",
          checked: false,
          accelerator: "CmdOrCtrl+U",
          click: (menuItem) => mainWindow.webContents.send("menu-toggle-show-scad", menuItem.checked),
        },
      ],
    },
    {
      label: "Tools",
      submenu: [
        {
          label: "Open in OpenSCAD",
          accelerator: "CmdOrCtrl+E",
          click: () => mainWindow.webContents.send("menu-open-in-openscad"),
        },
      ],
    },
  ];
  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);
}

function createWindow() {
  const width = parseInt(process.env.BGSD_WINDOW_WIDTH || "1000", 10);
  const height = parseInt(process.env.BGSD_WINDOW_HEIGHT || "1200", 10);

  mainWindow = new BrowserWindow({
    width,
    height,
    autoHideMenuBar: true,
    icon: appIconPath(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.loadFile(path.join(__dirname, "dist", "index.html"));

  rebuildMenu();
  mainWindow.setMenuBarVisibility(false);

  // Auto-load file from env or CLI arg
  const autoLoad = process.env.BGSD_OPEN || process.argv.find(a => a.endsWith(".scad"));
  if (autoLoad) {
    void (async () => {
      try {
        console.log("Auto-loading:", autoLoad);
        const content = fs.readFileSync(autoLoad, "utf-8");
        const fileState = fileSnapshot(autoLoad, content);
        const { project, libraryEnsures } = await importScadWithLibraries(content, autoLoad);
        console.log("Parsed", project.lines.length, "lines");
        pendingLoad = { data: project, filePath: autoLoad, fileState, libraryEnsures };
        addRecent(autoLoad);
      } catch (err) {
        console.error("Auto-load failed:", err.message);
      }
    })();
  }
}

// --- Helpers ---

/** Reject paths that traverse above the filesystem root or contain null bytes. */
function validateFilePath(filePath) {
  if (!filePath || typeof filePath !== "string") return false;
  if (filePath.includes("\0")) return false;
  const resolved = path.resolve(filePath);
  // Ensure the resolved path starts with a valid root (not escaped via ../)
  return resolved === filePath || !filePath.includes("..");
}

function fileSnapshot(filePath, content = undefined) {
  if (!validateFilePath(filePath) || !fs.existsSync(filePath)) {
    return { exists: false, size: 0, mtimeMs: 0, sha256: "" };
  }
  const stat = fs.statSync(filePath);
  const text = content === undefined ? fs.readFileSync(filePath, "utf-8") : String(content);
  return {
    exists: true,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256: crypto.createHash("sha256").update(text).digest("hex"),
  };
}

function normalizeFileState(state) {
  if (!state || typeof state !== "object") return null;
  return {
    exists: state.exists !== false,
    size: Number(state.size || 0),
    mtimeMs: Number(state.mtimeMs || 0),
    sha256: typeof state.sha256 === "string" ? state.sha256 : "",
  };
}

function fileStatesMatch(expectedState, actualState) {
  const expected = normalizeFileState(expectedState);
  const actual = normalizeFileState(actualState);
  if (!expected || !actual) return true;
  if (expected.exists !== actual.exists) return false;
  if (!expected.exists) return true;
  if (expected.sha256 && actual.sha256) return expected.sha256 === actual.sha256;
  return expected.size === actual.size && expected.mtimeMs === actual.mtimeMs;
}

function externalChangeSaveResult(filePath, fileState) {
  return {
    ok: false,
    externalChange: true,
    deleted: !fileState.exists,
    filePath,
    fileState,
    error: fileState.exists ? "File changed outside BGSD" : "File deleted outside BGSD",
  };
}

async function atomicWrite(filePath, content) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, content, "utf-8");

  // Retry rename — cloud-sync tools (OneDrive, Dropbox) briefly lock files
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.renameSync(tmp, filePath);
      return;
    } catch (err) {
      if (err.code !== "EPERM" && err.code !== "EACCES") throw err;
      await new Promise(r => setTimeout(r, 200));
    }
  }

  // Retries exhausted — fall back to direct write (not atomic, but reliable)
  console.warn("atomicWrite: rename failed after retries, falling back to direct write for", filePath);
  fs.writeFileSync(filePath, content, "utf-8");
  try { fs.unlinkSync(tmp); } catch {
    // Best-effort cleanup after falling back to direct write.
  }
}

// --- Auto-load state ---
let pendingLoad = null;

ipcMain.handle("get-pending-load", () => {
  const p = pendingLoad;
  pendingLoad = null;
  return p;
});

ipcMain.on("set-title", (_event, title) => {
  if (mainWindow) mainWindow.setTitle(title);
});

// --- IPC Handlers ---
//
// Convention:
//   File I/O & mutations → { ok: true, ... } | { ok: false, error: string }
//   Getters (get-preferences, get-presets) → raw data
//   Fire-and-forget (open-external, set-title) → void

ipcMain.handle("open-file", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Open SCAD File",
    filters: [{ name: "OpenSCAD", extensions: ["scad"] }],
    properties: ["openFile"],
  });
  if (result.canceled) return { ok: false };
  try {
    const filePath = result.filePaths[0];
    const content = fs.readFileSync(filePath, "utf-8");
    const fileState = fileSnapshot(filePath, content);
    const { project, libraryEnsures } = await importScadWithLibraries(content, filePath);
    addRecent(filePath);
    return { ok: true, filePath, fileState, data: project, libraryEnsures };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("save-file", async (_event, filePath, scadText, needsBackup, profileId, saveOptions = {}) => {
  try {
    void profileId;
    if (!validateFilePath(filePath)) {
      return { ok: false, error: "Invalid file path" };
    }
    // Reject saves to repo-tracked files — they'll be overwritten on library update
    const prefs = loadPrefs();
    if (isRepoFile(filePath, prefs.workingDir)) {
      return { ok: false, error: "repo-file", repoFile: true };
    }

    let previousText = null;
    let currentState = fileSnapshot(filePath);
    if (currentState.exists) {
      previousText = fs.readFileSync(filePath, "utf-8");
      currentState = fileSnapshot(filePath, previousText);
    }
    if (!saveOptions?.allowOverwriteExternal && saveOptions?.fileState && !fileStatesMatch(saveOptions.fileState, currentState)) {
      return externalChangeSaveResult(filePath, currentState);
    }

    // Detect read-only files (e.g. manually copied into working dir)
    if (fs.existsSync(filePath)) {
      try {
        fs.accessSync(filePath, fs.constants.W_OK);
      } catch (_) {
        // Already showing a prompt — return benign failure until it resolves
        if (pendingReadOnlyPrompt) {
          return { ok: false, error: "Waiting for permission to make file writable" };
        }
        pendingReadOnlyPrompt = true;
        try {
          const resp = await dialog.showMessageBox(mainWindow, {
            type: "question",
            title: "File is read-only",
            message: `"${path.basename(filePath)}" is read-only.\n\nMake it writable so BGSD can save your changes?`,
            buttons: ["Make Writable", "Cancel"],
            defaultId: 0,
            cancelId: 1,
          });
          if (resp.response === 0) {
            fs.chmodSync(filePath, 0o644);
          } else {
            return { ok: false, readOnlyFile: true };
          }
        } finally {
          pendingReadOnlyPrompt = false;
        }
      }
    }

    if (!saveOptions?.allowOverwriteExternal && saveOptions?.fileState) {
      const preWriteState = fileSnapshot(filePath);
      if (!fileStatesMatch(saveOptions.fileState, preWriteState)) {
        return externalChangeSaveResult(filePath, preWriteState);
      }
    }

    if (needsBackup && fs.existsSync(filePath)) {
      const bakPath = filePath + ".bak";
      if (!fs.existsSync(bakPath)) {
        fs.copyFileSync(filePath, bakPath);
      }
    }
    await atomicWrite(filePath, scadText);
    const fileState = fileSnapshot(filePath);
    try {
      undoSidecar.recordSavedRevision(filePath, previousText, scadText, {
        coalesce: !saveOptions?.forceNewRevision,
        forceNewRevision: !!saveOptions?.forceNewRevision,
      });
    } catch (err) {
      console.warn("[undo-sidecar] save history failed:", err.message);
    }
    return { ok: true, filePath, fileState };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("save-file-as", async (_event, scadText, profileId, currentPath) => {
  let defaultPath;
  if (currentPath) {
    defaultPath = currentPath;
  } else {
    // For new files, default to the profile's designs directory
    const prefs = loadPrefs();
    if (prefs.workingDir && profileId && profiles[profileId]) {
      const designsDir = path.join(prefs.workingDir, profileId, profiles[profileId].designsDir || "my_designs");
      fs.mkdirSync(designsDir, { recursive: true });
      defaultPath = path.join(designsDir, `${profileId.toUpperCase()}-${fileTimestamp()}.scad`);
    } else {
      defaultPath = "design.scad";
    }
  }
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Save SCAD File",
    filters: [{ name: "OpenSCAD", extensions: ["scad"] }],
    defaultPath,
  });
  if (result.canceled) return { ok: false };
  try {
    const prefs = loadPrefs();
    if (isRepoFile(result.filePath, prefs.workingDir)) {
      return { ok: false, error: "Cannot save over a library-tracked file" };
    }
    const samePath = currentPath && path.resolve(result.filePath) === path.resolve(currentPath);
    const previousText = fs.existsSync(result.filePath) ? fs.readFileSync(result.filePath, "utf-8") : null;
    await atomicWrite(result.filePath, scadText);
    const fileState = fileSnapshot(result.filePath);
    try { fs.chmodSync(result.filePath, 0o644); } catch {
      // Some filesystems ignore chmod; save-as still proceeds if the file was written.
    }
    try {
      if (samePath) {
        undoSidecar.recordSavedRevision(result.filePath, previousText, scadText, { forceNewRevision: true });
      } else {
        undoSidecar.initializeSidecar(result.filePath, scadText, { reset: true });
      }
    } catch (err) {
      console.warn("[undo-sidecar] save-as history init failed:", err.message);
    }
    return { ok: true, filePath: result.filePath, fileState };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("check-file-state", (_event, filePath, knownState) => {
  if (!validateFilePath(filePath)) {
    return { ok: false, error: "Invalid file path" };
  }
  try {
    const fileState = fileSnapshot(filePath);
    return {
      ok: true,
      filePath,
      fileState,
      changed: !fileStatesMatch(knownState, fileState),
      deleted: !fileState.exists,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("copy-template", async (_event, sourcePath) => {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return { ok: false, error: "Template not found" };
  }
  const prefs = loadPrefs();
  const sourceDir = path.dirname(sourcePath);
  const sourceName = path.basename(sourcePath);
  // Default to working dir designs folder if set, otherwise template's folder
  let defaultDir = sourceDir;
  if (prefs.workingDir) {
    // Detect profile from source path to pick the right designs subfolder
    const profileId = isRepoFile(sourcePath, prefs.workingDir);
    if (profileId && profiles[profileId]) {
      const designsDir = path.join(prefs.workingDir, profileId, profiles[profileId].designsDir || "my_designs");
      if (fs.existsSync(designsDir)) defaultDir = designsDir;
    }
  }
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Save Copy As",
    filters: [{ name: "OpenSCAD", extensions: ["scad"] }],
    defaultPath: path.join(defaultDir, sourceName),
  });
  if (result.canceled) return { ok: false };
  try {
    fs.copyFileSync(sourcePath, result.filePath);
    // Ensure the copy is writable (source may be a read-only repo file)
    try { fs.chmodSync(result.filePath, 0o644); } catch {
      // Some filesystems ignore chmod; the copied file may still be writable.
    }
    try {
      undoSidecar.initializeSidecar(result.filePath, fs.readFileSync(result.filePath, "utf-8"), { reset: true });
    } catch (err) {
      console.warn("[undo-sidecar] copied template history init failed:", err.message);
    }
    return { ok: true, filePath: result.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- OpenSCAD path resolution ---

// macOS apps are folders ("bundles"); the real command-line program lives at
// <App>.app/Contents/MacOS/<name>. Given any path a user might supply — the
// .app bundle, a containing folder, or the binary itself — work out what is
// actually runnable and, when it isn't, say precisely why.
//   kind: "ok" | "missing" | "bundle-no-binary" | "dir-no-binary"
function inspectOpenScadPath(p) {
  if (typeof p === "string") p = p.trim();
  if (!p) return { kind: "missing", path: p };
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return { kind: "missing", path: p };
  }
  if (st.isFile()) return { kind: "ok", path: p };
  if (st.isDirectory()) {
    // An .app bundle (or a folder that contains one) — look for the binary inside.
    let macosDir = null;
    if (fs.existsSync(path.join(p, "Contents", "MacOS"))) {
      macosDir = path.join(p, "Contents", "MacOS");
    } else if (path.basename(p) === "MacOS") {
      macosDir = p;
    }
    if (macosDir) {
      // Only accept an executable regular file (on Unix the exec bit must be set).
      const isExecFile = (f) => {
        try {
          const s = fs.statSync(f);
          return s.isFile() && (process.platform === "win32" || (s.mode & 0o111) !== 0);
        } catch { return false; }
      };
      const preferred = path.join(macosDir, "OpenSCAD");
      if (isExecFile(preferred)) return { kind: "ok", path: preferred, fromBundle: p };
      // No file named exactly "OpenSCAD": pick deterministically (sorted), and
      // prefer one whose name looks like openscad over an arbitrary helper.
      let files = [];
      try {
        files = fs.readdirSync(macosDir).sort()
          .map((name) => path.join(macosDir, name))
          .filter(isExecFile);
      } catch { /* unreadable */ }
      const chosen = files.find((f) => /openscad/i.test(path.basename(f))) || files[0];
      if (chosen) return { kind: "ok", path: chosen, fromBundle: p };
      return { kind: "bundle-no-binary", path: p, lookedIn: macosDir };
    }
    return { kind: "dir-no-binary", path: p };
  }
  return { kind: "missing", path: p };
}

// Candidate install locations, in priority order, per platform.
function openScadCandidates() {
  const os = require("os");
  const home = os.homedir();
  if (process.platform === "win32") {
    return [
      "C:\\Program Files\\OpenSCAD\\openscad.exe",
      "C:\\Program Files (x86)\\OpenSCAD\\openscad.exe",
      "C:\\Program Files\\OpenSCAD (Nightly)\\openscad.exe",
    ];
  }
  if (process.platform === "darwin") {
    const out = [];
    for (const dir of ["/Applications", path.join(home, "Applications")]) {
      out.push(path.join(dir, "OpenSCAD.app"));
      out.push(path.join(dir, "OpenSCAD (Nightly).app"));
      // Any versioned or dev build: "OpenSCAD-2021.01.app", "OpenSCAD (snapshot).app", ...
      try {
        for (const name of fs.readdirSync(dir)) {
          if (/^openscad.*\.app$/i.test(name)) out.push(path.join(dir, name));
        }
      } catch { /* dir may not exist */ }
    }
    // Homebrew / command-line installs.
    out.push("/opt/homebrew/bin/openscad", "/usr/local/bin/openscad");
    return out;
  }
  return ["/usr/bin/openscad", "/usr/local/bin/openscad", "/opt/homebrew/bin/openscad", "/snap/bin/openscad"];
}

// Resolve OpenSCAD to a runnable binary, with diagnostics about why it failed.
// Returns { cmd, source, configured?, problem?, fromBundle? }; cmd is null when
// nothing usable was found (callers may still try a bare-"openscad" PATH lookup).
function resolveOpenScad() {
  const prefs = loadPrefs();

  // 1. User-configured path from Preferences.
  if (prefs.openScadPath && String(prefs.openScadPath).trim()) {
    const info = inspectOpenScadPath(prefs.openScadPath);
    if (info.kind === "ok") {
      return { cmd: info.path, source: "prefs", configured: prefs.openScadPath, fromBundle: info.fromBundle || null };
    }
    return { cmd: null, source: "prefs", configured: prefs.openScadPath, problem: info };
  }

  // 2. Platform-specific candidate locations.
  for (const c of openScadCandidates()) {
    const info = inspectOpenScadPath(c);
    if (info.kind === "ok") {
      return { cmd: info.path, source: "candidate", fromBundle: info.fromBundle || null };
    }
  }

  // 3. Nothing concrete — caller falls back to a bare "openscad" PATH lookup.
  return { cmd: null, source: "path" };
}

// Backward-compatible: a runnable command string (bare "openscad" as last resort).
function findOpenScad() {
  return resolveOpenScad().cmd || "openscad";
}

// One-line, platform-aware instruction for the status bar / dialogs.
function openScadPathHint() {
  if (process.platform === "darwin") {
    return "Open Preferences and set the OpenSCAD path to the program inside the app bundle: /Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD";
  }
  if (process.platform === "win32") {
    return "Open Preferences and set the OpenSCAD path to openscad.exe, e.g. C:\\Program Files\\OpenSCAD\\openscad.exe";
  }
  return "Open Preferences and set the OpenSCAD path, or install OpenSCAD (e.g. /usr/bin/openscad).";
}

// Turn a resolution result (and an optional exec error) into a specific,
// user-facing explanation. This is what reaches the status bar, so a bug report
// tells us exactly which case fired.
function describeOpenScadProblem(res, execErr) {
  const hint = openScadPathHint();
  if (res && res.source === "prefs" && res.problem) {
    const p = res.problem;
    if (p.kind === "missing") {
      return `The OpenSCAD path set in Preferences does not exist: "${res.configured}". ${hint}`;
    }
    if (p.kind === "bundle-no-binary") {
      return `The OpenSCAD app bundle has no runnable program inside (looked in ${p.lookedIn}). It may be incomplete or a different app. ${hint}`;
    }
    if (p.kind === "dir-no-binary") {
      return `The OpenSCAD path in Preferences is a folder, not a program: "${res.configured}". ${hint}`;
    }
  }
  if (execErr) {
    const code = execErr.code || "";
    // Killed by our timeout (cold first launch, Gatekeeper scan, slow disk) —
    // OpenSCAD is installed, it just didn't answer in time. Not "missing".
    if (execErr.killed || code === "ETIMEDOUT") {
      return "OpenSCAD did not respond in time. If this is its first launch it may still be passing a security check — try again in a moment.";
    }
    if (code === "EACCES" || code === "EPERM") {
      // Quote the binary/bundle that actually failed, not a hard-coded path.
      const target = (res && (res.fromBundle || res.configured || res.cmd)) || "";
      if (process.platform === "darwin") {
        const quoted = target || "/Applications/OpenSCAD.app";
        return `macOS blocked OpenSCAD from running (${code}). Right-click → Open clears the app icon, but the command-line program inside it can still be quarantined. In Terminal run:  xattr -dr com.apple.quarantine "${quoted}"  then try again.`;
      }
      if (process.platform === "win32") {
        return `Windows blocked OpenSCAD from running (${code}). It may be locked or in use — for example by antivirus. Close anything using ${target || "openscad.exe"}, confirm it is allowed to run, then try again.`;
      }
      return `OpenSCAD is not allowed to run (${code}). Make sure it is executable:  chmod +x "${target || "openscad"}"  then try again.`;
    }
    if (code === "ENOENT") {
      return `OpenSCAD was not found on your system. ${hint}`;
    }
  }
  return `OpenSCAD was not found. ${hint}`;
}

// Resolve + actually run "openscad --version" to confirm it works. Catches the
// cases a path check can't: quarantine/permissions (EACCES) and a broken binary.
// Pass overridePath to test a specific path without saving it to Preferences.
function verifyOpenScad(overridePath) {
  const { execFile } = require("child_process");
  let res;
  if (overridePath != null && String(overridePath).trim()) {
    const info = inspectOpenScadPath(overridePath);
    res = info.kind === "ok"
      ? { cmd: info.path, source: "prefs", configured: overridePath, fromBundle: info.fromBundle || null }
      : { cmd: null, source: "prefs", configured: overridePath, problem: info };
    if (!res.cmd) {
      return Promise.resolve({ ok: false, cmd: null, error: "not-found", detail: describeOpenScadProblem(res, null) });
    }
  } else {
    res = resolveOpenScad();
  }
  const cmd = res.cmd || "openscad";
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      execFile(cmd, ["--version"], { timeout: 8000 }, (err, stdout, stderr) => {
        if (!err) {
          const version = String(stderr || stdout || "").trim() || "OpenSCAD";
          finish({ ok: true, cmd, version });
          return;
        }
        finish({
          ok: false,
          cmd,
          error: (err.code === "EACCES" || err.code === "EPERM") ? "blocked"
            : (err.killed || err.code === "ETIMEDOUT") ? "timeout"
            : "not-found",
          detail: describeOpenScadProblem(res, err),
        });
      });
    } catch (err) {
      finish({ ok: false, cmd, error: "not-found", detail: describeOpenScadProblem(res, err) });
    }
  });
}

async function launchOpenScadFile(filePath) {
  const { spawn } = require("child_process");
  if (!validateFilePath(filePath) || !fs.existsSync(filePath)) {
    return { ok: false, error: `File not found: ${filePath || "(no path)"}` };
  }

  // If OpenSCAD is already showing this exact file, skip
  if (openScadAlive && openScadFile === filePath) {
    return { ok: true };
  }

  // Kill the previous instance and wait for it to exit before spawning a new one
  if (openScadAlive && openScadProc) {
    const oldProc = openScadProc;
    openScadAlive = false;
    openScadProc = null;
    openScadFile = null;
    try {
      await new Promise((resolve) => {
        oldProc.on("exit", resolve);
        oldProc.on("error", resolve);
        const killed = oldProc.kill();
        if (!killed) resolve(); // kill returned false — process already gone
        setTimeout(resolve, 2000); // safety timeout
      });
    } catch (err) { console.error("Failed to kill previous OpenSCAD:", err); }
  }

  function spawnOpenScad(cmd, args) {
    const proc = spawn(cmd, args, { stdio: "ignore" });
    proc.unref();
    openScadAlive = true;
    openScadProc = proc;
    openScadFile = filePath;
    proc.on("exit", () => { openScadAlive = false; openScadProc = null; openScadFile = null; });
    proc.on("error", () => { openScadAlive = false; openScadProc = null; openScadFile = null; });
    return proc;
  }

  const res = resolveOpenScad();

  // Windows: if we couldn't resolve a binary, fall back to Shell "start".
  if (process.platform === "win32" && !res.cmd) {
    try {
      spawnOpenScad("cmd", ["/c", "start", "", filePath]);
      return { ok: true };
    } catch (err) {
      console.error("[openscad] launch via cmd start failed:", err);
      return { ok: false, error: "not-found", detail: describeOpenScadProblem(res, err) };
    }
  }

  // Confirm OpenSCAD actually runs before launching. spawn() reports a missing,
  // non-executable, or quarantined binary *asynchronously*, so a bare spawn would
  // silently no-op yet return success. verifyOpenScad() execs "--version" and
  // classifies the failure (e.g. an EACCES quarantine) into an actionable reason.
  const check = await verifyOpenScad();
  if (!check.ok) {
    console.warn("[openscad] not runnable:", check.detail);
    return { ok: false, error: check.error, detail: check.detail };
  }

  const cmd = check.cmd;
  try {
    const proc = spawnOpenScad(cmd, [filePath]);
    // The verify above already ruled out a bad binary; log if one slips through.
    proc.on("error", (err) => console.error(`[openscad] launch failed (${cmd}):`, err && err.message));
    return { ok: true };
  } catch (err) {
    console.error("[openscad] launch threw:", err);
    return {
      ok: false,
      error: (err.code === "EACCES" || err.code === "EPERM") ? "blocked" : "not-found",
      detail: describeOpenScadProblem(res, err),
    };
  }
}

ipcMain.handle("open-in-openscad", async (_event, filePath, profileId) => {
  void profileId;
  return launchOpenScadFile(filePath);
});

function unquoteOpenScadEchoValue(value) {
  const text = String(value || "").trim();
  if (text.length >= 2 && text.startsWith("\"") && text.endsWith("\"")) {
    return text.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
  return text;
}

function parseBgsdEchoIssue(raw) {
  const echoMatch = raw.match(/^ECHO:\s*(.*)$/i);
  if (!echoMatch) return null;

  const payload = unquoteOpenScadEchoValue(echoMatch[1]);
  const match = payload.match(/^BGSD_(ERROR|WARNING|INFO)\b\s*(.*)$/i);
  if (!match) return null;

  const severity = match[1].toLowerCase() === "error"
    ? "error"
    : match[1].toLowerCase() === "warning"
      ? "warning"
      : "info";
  let rest = match[2].trim();
  const metadata = {};
  rest = rest.replace(/^:\s*/, "").trim();
  while (rest.startsWith("[")) {
    const metaMatch = rest.match(/^\[([a-zA-Z][a-zA-Z0-9_-]*)=([^\]\s]+)\]\s*/);
    if (!metaMatch) break;
    metadata[metaMatch[1]] = metaMatch[2];
    rest = rest.slice(metaMatch[0].length).trim();
  }
  rest = rest.replace(/^:\s*/, "").trim();

  return {
    severity,
    message: rest || payload,
    line: null,
    file: null,
    raw,
    ...metadata,
  };
}

function parseOpenScadIssues(output, fallbackExitIssue = null, tempScadPath = "", sourcePath = "") {
  const issues = [];
  const lines = String(output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const tempName = tempScadPath ? path.basename(tempScadPath) : "";
  const sourceName = sourcePath ? path.basename(sourcePath) : "generated SCAD";

  for (const raw of lines) {
    const echoIssue = parseBgsdEchoIssue(raw);
    if (echoIssue) {
      issues.push(echoIssue);
      continue;
    }
    if (/^ECHO:/i.test(raw)) continue;
    const severityMatch = raw.match(/\b(ERROR|WARNING):\s*(.*)$/i);
    const looksLikeIssue = severityMatch || /\b(can't open|cannot open|parser error|syntax error|undefined operation)\b/i.test(raw);
    if (!looksLikeIssue) continue;

    const severity = severityMatch
      ? (severityMatch[1].toLowerCase() === "warning" ? "warning" : "error")
      : "error";
    let message = severityMatch ? severityMatch[2].trim() : raw;
    if (tempName) message = message.split(tempName).join(sourceName);
    message = message.replace(/\s+/g, " ");

    const lineMatch = raw.match(/\bline\s+(\d+)\b/i);
    const fileMatch = raw.match(/\bfile\s+(.+?)(?:,|\s+line\b|$)/i);
    let file = fileMatch ? fileMatch[1].trim() : null;
    if (file && tempName && path.basename(file) === tempName) file = sourcePath || null;
    issues.push({
      severity,
      message: message || raw,
      line: lineMatch ? Number.parseInt(lineMatch[1], 10) : null,
      file,
      raw,
    });
  }

  if (fallbackExitIssue && !issues.some((issue) => issue.severity === "error")) {
    issues.push(fallbackExitIssue);
  }

  return issues;
}

function tempOpenScadPaths(sourcePath) {
  const baseDir = validateFilePath(sourcePath) && fs.existsSync(path.dirname(sourcePath || ""))
    ? path.dirname(sourcePath)
    : app.getPath("temp");
  const stem = `.bgsd-check-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  return {
    scadPath: path.join(baseDir, `${stem}.scad`),
    outputPath: path.join(baseDir, `${stem}.csg`),
  };
}

async function unlinkIfExists(filePath) {
  try {
    await fs.promises.unlink(filePath);
  } catch (err) {
    if (err.code !== "ENOENT") console.warn("[check-openscad] cleanup failed:", err.message);
  }
}

ipcMain.handle("check-openscad", async (_event, payload) => {
  const { execFile } = require("child_process");
  const requestId = payload?.requestId ?? null;
  const scadText = String(payload?.scadText || "");
  const filePath = payload?.filePath || "";
  if (!scadText.trim()) {
    return { ok: true, requestId, issues: [], elapsedMs: 0 };
  }

  const osRes = resolveOpenScad();
  const cmd = osRes.cmd || "openscad";
  const { scadPath, outputPath } = tempOpenScadPaths(filePath);
  const cwd = path.dirname(scadPath);
  const started = Date.now();

  try {
    await ensureLibrariesForScadText(scadText, filePath);
  } catch (err) {
    console.warn("[check-openscad] library ensure failed:", err.message);
  }

  try {
    await fs.promises.writeFile(scadPath, scadText, "utf-8");
  } catch (err) {
    return {
      ok: false,
      requestId,
      error: err.message,
      issues: [{ severity: "error", message: `Could not prepare OpenSCAD check: ${err.message}`, line: null, file: null, raw: err.message }],
      elapsedMs: Date.now() - started,
    };
  }

  return new Promise((resolve) => {
    execFile(cmd, ["-o", outputPath, scadPath], { cwd, timeout: 30000 }, (err, stdout, stderr) => {
      void (async () => {
        await Promise.all([unlinkIfExists(scadPath), unlinkIfExists(outputPath)]);

        const output = [stdout, stderr].filter(Boolean).join("\n");
        if (err && (err.code === "ENOENT" || err.code === "EACCES" || err.code === "EPERM")) {
          const detail = describeOpenScadProblem(osRes, err);
          resolve({
            ok: false,
            requestId,
            error: (err.code === "EACCES" || err.code === "EPERM") ? "blocked" : "not-found",
            detail,
            issues: [{ severity: "error", message: detail, line: null, file: null, raw: err.message }],
            elapsedMs: Date.now() - started,
          });
          return;
        }

        const fallbackExitIssue = err
          ? { severity: "error", message: (stderr || err.message || "OpenSCAD check failed").trim(), line: null, file: null, raw: stderr || err.message }
          : null;
        resolve({
          ok: !err,
          requestId,
          exitCode: err?.code ?? 0,
          signal: err?.signal ?? null,
          issues: parseOpenScadIssues(output, fallbackExitIssue, scadPath, filePath),
          elapsedMs: Date.now() - started,
        });
      })();
    });
  });
});

ipcMain.handle("open-undo-revision-in-openscad", async (_event, filePath, revisionId, profileId) => {
  void profileId;
  if (!validateFilePath(filePath)) return { ok: false, error: "Invalid file path" };
  const result = undoSidecar.loadRevision(filePath, revisionId);
  if (!result.ok) return result;

  const baseName = path.basename(filePath, ".scad");
  const shortId = String(revisionId || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) || "revision";
  const previewPath = path.join(path.dirname(filePath), `.${baseName}.history-${shortId}.scad`);
  try {
    await atomicWrite(previewPath, result.scadText);
  } catch (err) {
    return { ok: false, error: `Could not write version preview: ${err.message}` };
  }

  if (process.env.BGSD_HARNESS) {
    return { ok: true, filePath: previewPath, harness: true };
  }
  const launched = await launchOpenScadFile(previewPath);
  return { ...launched, filePath: previewPath };
});

ipcMain.handle("export-stl", async (_event, sourcePath) => {
  const { execFile } = require("child_process");
  if (!validateFilePath(sourcePath) || !fs.existsSync(sourcePath)) {
    return { ok: false, error: `File not found: ${sourcePath || "(no path)"}` };
  }

  // Show Save dialog for the combined .stl output. If the design uses
  // PRINT_GROUP tags, sibling files are exported for each group.
  const defaultName = path.basename(sourcePath, ".scad") + ".stl";
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Export STL Files",
    filters: [{ name: "STL Files", extensions: ["stl"] }],
    defaultPath: path.join(path.dirname(sourcePath), defaultName),
  });
  if (result.canceled) return { ok: false };

  // Verify OpenSCAD is reachable before starting a long export, with a
  // specific reason if it isn't.
  const check = await verifyOpenScad();
  if (!check.ok) return { ok: false, error: check.error, detail: check.detail };
  const cmd = check.cmd;

  let plan;
  const tempPaths = [];
  try {
    const scadText = await fs.promises.readFile(sourcePath, "utf-8");
    plan = createStlExportPlan({
      sourcePath,
      targetFilePath: result.filePath,
      scadText,
      tempToken: crypto.randomBytes(6).toString("hex"),
    });
    for (const job of plan.jobs) {
      if (job.tempScadPath && job.scadText) {
        await fs.promises.writeFile(job.tempScadPath, job.scadText, "utf-8");
        tempPaths.push(job.tempScadPath);
      }
    }
  } catch (err) {
    for (const tempPath of tempPaths) {
      fs.promises.unlink(tempPath).catch(() => {});
    }
    return { ok: false, error: `Could not prepare STL export: ${err.message}` };
  }

  async function runExportJob(job) {
    const inputPath = job.tempScadPath || job.sourcePath || sourcePath;
    return new Promise((resolve) => {
      execFile(cmd, ["-o", job.filePath, inputPath], { timeout: 120000 }, (err, _stdout, stderr) => {
        if (err) {
          resolve({ ok: false, error: stderr || err.message, job });
        } else {
          resolve({ ok: true, job });
        }
      });
    });
  }

  try {
    const files = [];
    for (const job of plan.jobs) {
      const exported = await runExportJob(job);
      if (!exported.ok) {
        return {
          ok: false,
          error: exported.error,
          failedFilePath: job.filePath,
          failedGroup: job.kind === "group" ? job.group : null,
          files,
        };
      }
      files.push(job.filePath);
    }
    return { ok: true, filePath: result.filePath, files, groups: plan.groups };
  } finally {
    await Promise.all(tempPaths.map((tempPath) =>
      fs.promises.unlink(tempPath).catch((err) => {
        if (err.code !== "ENOENT") console.warn("[export-stl] cleanup failed:", err.message);
      })
    ));
  }
});

// --- Preferences IPC ---

ipcMain.handle("open-external", (_event, url) => {
  if (typeof url === "string" && url.startsWith("https://")) shell.openExternal(url);
});

ipcMain.handle("get-preferences", () => loadPrefs());

ipcMain.handle("set-preferences", (_event, prefs) => {
  const merged = { ...loadPrefs(), ...prefs };
  savePrefs(merged);
  if ("proxy" in prefs) setProxy(merged.proxy);
  return merged;
});

ipcMain.handle("browse-openscad", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Locate OpenSCAD",
    filters: process.platform === "win32"
      ? [{ name: "Executables", extensions: ["exe"] }]
      : [{ name: "All Files", extensions: ["*"] }],
    properties: ["openFile"],
    // Let macOS users either pick OpenSCAD.app or click into it; we resolve
    // whichever they choose to the actual command-line binary below.
    ...(process.platform === "darwin" ? { treatsFilePackagesAsDirectories: true } : {}),
  });
  if (result.canceled) return { ok: false };
  const picked = result.filePaths[0];
  const info = inspectOpenScadPath(picked);
  // Save the resolved inner binary when we found one; otherwise keep what they
  // picked so the Test button can explain what's wrong.
  return { ok: true, path: info.kind === "ok" ? info.path : picked };
});

ipcMain.handle("test-openscad", async (_event, payload) => {
  const override = payload && typeof payload.path === "string" ? payload.path : null;
  return verifyOpenScad(override);
});

// --- Create new project to temp path or working dir ---
ipcMain.handle("new-project-to-path", async (_event, profile) => {
  const os = require("os");
  const profileObj = profiles[profile];
  const prefs = loadPrefs();
  let includeFile = profileObj ? profileObj.include : "boardgame_insert_toolkit_lib.4.scad";
  if (profileObj?.latestFilePattern) {
    try {
      const latest = await ensureLatestLibrary(profile, { workingDir: prefs.workingDir });
      includeFile = latest.include;
    } catch (err) {
      console.warn(`[new-project] latest ${profile} library probe failed:`, err.message);
    }
  }
  const templates = {
    bit: `// BGSD\ninclude <${includeFile}>;\ndata = [\n    [ OBJECT_BOX,\n        [ NAME, "box 1" ],\n        [ BOX_SIZE_XYZ, [50, 50, 20] ],\n    ],\n];\nMake(data);`,
    ctd: `// BGSD\ninclude <${includeFile}>;\nscene_1 = [\n    [ TRAY,\n        [ COUNTER_SET,\n            [ COUNTER_SIZE_XYZ, [13.3, 13.3, 3] ],\n        ],\n    ],\n    [ LID,\n    ],\n];\nMake(scene_1);`,
  };
  const scad = templates[profile] || templates.bit;

  // Use working directory if set, otherwise fall back to tmpdir
  let filePath;
  if (prefs.workingDir && profileObj) {
    const designsDir = path.join(prefs.workingDir, profile, profileObj.designsDir || "my_designs");
    fs.mkdirSync(designsDir, { recursive: true });
    filePath = path.join(designsDir, `${profile.toUpperCase()}-${fileTimestamp()}.scad`);
  } else {
    filePath = path.join(os.tmpdir(), `${profile.toUpperCase()}-${fileTimestamp()}.scad`);
  }

  try {
    await atomicWrite(filePath, scad);
    const fileState = fileSnapshot(filePath);
    try {
      undoSidecar.initializeSidecar(filePath, scad, { reset: true });
    } catch (err) {
      console.warn("[undo-sidecar] new project history init failed:", err.message);
    }
    const project = importScad(fs.readFileSync(filePath, "utf-8"));
    addRecent(filePath);
    if (mainWindow) mainWindow.webContents.send("menu-open", { data: project, filePath, fileState });
    return { ok: true, filePath, fileState };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- Load file by path (for new-project round-trip) ---
ipcMain.handle("load-file-path", async (_event, filePath) => {
  if (!validateFilePath(filePath)) {
    return { ok: false, error: "Invalid file path" };
  }
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const fileState = fileSnapshot(filePath, content);
    const { project, libraryEnsures } = await importScadWithLibraries(content, filePath);
    addRecent(filePath);
    return { ok: true, data: project, filePath, fileState, libraryEnsures };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("get-recent-files", () => {
  return loadRecent();
});

// --- Persistent file history IPC ---

ipcMain.handle("list-undo-history", (_event, filePath) => {
  if (!validateFilePath(filePath)) return { ok: false, error: "Invalid file path" };
  return undoSidecar.listHistory(filePath);
});

ipcMain.handle("get-undo-history", (_event, filePath) => {
  if (!validateFilePath(filePath)) return { ok: false, error: "Invalid file path" };
  return undoSidecar.listHistory(filePath);
});

ipcMain.handle("load-undo-revision", (_event, filePath, revisionId) => {
  if (!validateFilePath(filePath)) return { ok: false, error: "Invalid file path" };
  const result = undoSidecar.loadRevision(filePath, revisionId);
  if (!result.ok) return result;
  try {
    return { ...result, data: importScad(result.scadText) };
  } catch (err) {
    return { ok: false, error: `Revision import failed: ${err.message}` };
  }
});

ipcMain.handle("label-undo-revision", (_event, filePath, revisionId, label) => {
  if (!validateFilePath(filePath)) return { ok: false, error: "Invalid file path" };
  return undoSidecar.labelRevision(filePath, revisionId, label);
});

ipcMain.handle("pin-undo-revision", (_event, filePath, revisionId, pinned) => {
  if (!validateFilePath(filePath)) return { ok: false, error: "Invalid file path" };
  return undoSidecar.pinRevision(filePath, revisionId, pinned);
});

ipcMain.handle("prune-undo-history", (_event, filePath, keepCount) => {
  if (!validateFilePath(filePath)) return { ok: false, error: "Invalid file path" };
  return undoSidecar.pruneHistory(filePath, keepCount);
});

// --- Working directory IPC ---

ipcMain.handle("browse-working-dir", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose Working Directory",
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled) return { ok: false };
  return { ok: true, path: result.filePaths[0] };
});

ipcMain.handle("init-working-dir", async (_event, dirPath) => {
  try {
    const messages = [];
    await initWorkingDir(dirPath, (msg) => {
      messages.push(msg);
      if (mainWindow) mainWindow.webContents.send("working-dir-progress", msg);
    });
    const prefs = loadPrefs();
    prefs.workingDir = dirPath;
    savePrefs(prefs);
    return { ok: true, messages };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("update-libraries", async () => {
  const prefs = loadPrefs();
  if (!prefs.workingDir) return { ok: false, error: "No working directory set" };
  try {
    const messages = [];
    const result = await updateLibraries(prefs.workingDir, (msg) => {
      messages.push(msg);
      if (mainWindow) mainWindow.webContents.send("working-dir-progress", msg);
    });

    // Show dialog if user files were skipped
    if (result?.skippedUserFiles?.length > 0 && mainWindow) {
      const files = result.skippedUserFiles;
      const dirs = [...new Set(files.map((f) => f.dir))];
      const list = files.map((f) => `  ${f.profileName}: ${f.localPath}`).join("\n");
      const resp = await dialog.showMessageBox(mainWindow, {
        type: "info",
        title: "Files not overwritten",
        message: `${files.length} local file(s) were not overwritten because they have local modifications:\n\n${list}`,
        buttons: ["OK", "Open Directory"],
        defaultId: 0,
      });
      if (resp.response === 1 && dirs.length > 0) {
        shell.openPath(dirs[0]);
      }
    }

    return { ok: true, messages };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("ensure-latest-library", async (_event, profileId) => {
  const prefs = loadPrefs();
  try {
    const latest = await ensureLatestLibrary(profileId, { workingDir: prefs.workingDir });
    return { ok: true, ...latest };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("get-working-dir-status", () => {
  const prefs = loadPrefs();
  return { set: !!prefs.workingDir, path: prefs.workingDir || "" };
});

// Static lib versions parsed from local installed libraries, without network.
// Used by the status bar to render BIT/CTD chips up-front before the update
// probe resolves whether those local versions are current with upstream.
ipcMain.handle("get-lib-versions", () => {
  const prefs = loadPrefs();
  return getInstalledLibraryVersions(prefs.workingDir);
});

// Compare strings like "0.5.13" / "v0.5.13" / "0.5.13-rc1". Returns true when
// `latest` is strictly newer than `current` (semver-ish, dotted numeric segments).
function isNewerVersion(current, latest) {
  if (!current || !latest) return false;
  const norm = (s) => String(s).replace(/^v/i, "").split("-")[0].split(".").map((p) => parseInt(p, 10) || 0);
  const a = norm(current);
  const b = norm(latest);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] || 0;
    const bv = b[i] || 0;
    if (bv > av) return true;
    if (bv < av) return false;
  }
  return false;
}

// Repo for self-update check. Could move to package.json `repository` field
// in the future; for now the URL is stable.
const BGSD_REPO = "dppdppd/BGSD";

ipcMain.handle("check-updates", async () => {
  const current = app.getVersion();
  const result = {
    bgsd: { current, latest: null, hasUpdate: false, releaseUrl: `https://github.com/${BGSD_REPO}/releases/latest` },
    libs: {},
  };
  // App version
  try {
    const tag = await fetchLatestReleaseTag(BGSD_REPO);
    if (tag) {
      result.bgsd.latest = tag.replace(/^v/i, "");
      result.bgsd.hasUpdate = isNewerVersion(current, tag);
    }
  } catch (err) {
    console.warn("[check-updates] BGSD release probe failed:", err.message);
  }
  // Lib files
  try {
    const prefs = loadPrefs();
    if (prefs.workingDir) {
      result.libs = await checkLibraryUpdates(prefs.workingDir);
    }
  } catch (err) {
    console.warn("[check-updates] lib probe failed:", err.message);
  }
  // One-line summary so users running from a terminal can grep the result
  const libSummary = Object.entries(result.libs)
    .map(([id, l]) => `${id}=${l.hasUpdate ? "update" : "current"}`)
    .join(" ");
  console.log(`[check-updates] bgsd ${current}→${result.bgsd.latest || "?"} (${result.bgsd.hasUpdate ? "update" : "current"}) | libs ${libSummary || "(no workdir)"}`);
  return result;
});

// --- Self-update -----------------------------------------------------------
//
// Bootstrap pattern: download the platform's release asset and either replace
// the running binary in place (Linux AppImage allows this; the inode is
// preserved for the live process) or stage it for the user to finish (macOS
// .app and Windows .exe both refuse to be replaced while running, so we drop
// the new binary in ~/Downloads and pop the file manager).
//
// No code-signing, no electron-updater feed — just the release asset URL from
// the GitHub API. Once a user has v0.5.x installed, every subsequent update
// rides this path.

function pickReleaseAsset(assets, platform) {
  for (const a of assets) {
    if (platform === "linux" && a.name.endsWith(".AppImage")) return a;
    if (platform === "darwin" && a.name.endsWith("-mac.zip")) return a;
    if (platform === "win32" && a.name.toLowerCase().endsWith(".exe")) return a;
  }
  return null;
}

async function downloadReleaseAsset(url, destPath, onProgress) {
  // GitHub release URLs redirect to S3; net.fetch follows redirects by default.
  const resp = await net.fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const total = parseInt(resp.headers.get("content-length") || "0", 10);
  const reader = resp.body.getReader();
  const ws = fs.createWriteStream(destPath);
  let bytesRead = 0;
  let lastTick = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    ws.write(Buffer.from(value));
    bytesRead += value.length;
    // Throttle progress to ~5/s
    const now = Date.now();
    if (onProgress && now - lastTick > 200) {
      onProgress(bytesRead, total);
      lastTick = now;
    }
  }
  await new Promise((res, rej) => { ws.end(); ws.on("close", res); ws.on("error", rej); });
  if (onProgress) onProgress(bytesRead, total);
}

ipcMain.handle("self-update", async () => {
  try {
    const text = await (async () => {
      const r = await net.fetch(`https://api.github.com/repos/${BGSD_REPO}/releases/latest`);
      if (!r.ok) throw new Error(`HTTP ${r.status} fetching release info`);
      return r.text();
    })();
    const release = JSON.parse(text);
    const asset = pickReleaseAsset(release.assets || [], process.platform);
    if (!asset) return { ok: false, error: `No release asset for ${process.platform}` };

    const sendProgress = (received, total) => {
      if (mainWindow) mainWindow.webContents.send("self-update-progress", { received, total, name: asset.name });
    };

    if (process.platform === "linux") {
      const appImagePath = process.env.APPIMAGE;
      if (!appImagePath) {
        return { ok: false, error: "Auto-update only works when launched from an AppImage; download manually from the release page." };
      }
      const tmpPath = appImagePath + ".updating";
      const bakPath = appImagePath + ".bak";
      // Clean any stale tmp from a previous aborted attempt
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
      console.log(`[self-update] downloading ${asset.name} → ${tmpPath}`);
      await downloadReleaseAsset(asset.browser_download_url, tmpPath, sendProgress);

      // Sanity check the download — AppImages start with the ELF magic
      // (0x7F 'E' 'L' 'F'); a truncated/corrupt download won't.
      const stat = fs.statSync(tmpPath);
      if (stat.size < 1_000_000) {
        fs.unlinkSync(tmpPath);
        return { ok: false, error: `Downloaded file is too small (${stat.size} bytes) — likely a partial download` };
      }
      const fd = fs.openSync(tmpPath, "r");
      const head = Buffer.alloc(4);
      try { fs.readSync(fd, head, 0, 4, 0); } finally { fs.closeSync(fd); }
      if (!(head[0] === 0x7F && head[1] === 0x45 && head[2] === 0x4C && head[3] === 0x46)) {
        fs.unlinkSync(tmpPath);
        return { ok: false, error: "Downloaded file isn't a valid AppImage (ELF header missing)" };
      }
      fs.chmodSync(tmpPath, 0o755);

      // Backup the current AppImage before swap so the user can manually
      // restore if the new build is broken: `mv BGSD-X.AppImage.bak BGSD-X.AppImage`.
      try { if (fs.existsSync(bakPath)) fs.unlinkSync(bakPath); } catch (_) { /* ignore */ }
      try {
        fs.renameSync(appImagePath, bakPath);
      } catch (err) {
        // Backup failed — abort to avoid leaving the user with no working binary.
        try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
        return { ok: false, error: `Could not back up current AppImage: ${err.message}` };
      }
      try {
        // AppImage swap: the live process keeps its old inode via the .bak handle.
        fs.renameSync(tmpPath, appImagePath);
      } catch (err) {
        // Restore backup if the new file rename fails.
        try { fs.renameSync(bakPath, appImagePath); } catch (_) { /* ignore */ }
        return { ok: false, error: `Could not install new AppImage: ${err.message}` };
      }
      console.log(`[self-update] replaced ${appImagePath} (backup at ${bakPath}); relaunching`);
      // Defer relaunch so the IPC reply lands first
      setTimeout(() => { app.relaunch(); app.exit(0); }, 200);
      return { ok: true, restarting: true, version: release.tag_name, backup: bakPath };
    }

    // macOS / Windows: stage the asset and pop the file manager. The running
    // bundle/exe can't be replaced safely while live; user finishes the install.
    const downloadsDir = app.getPath("downloads");
    fs.mkdirSync(downloadsDir, { recursive: true });
    const destPath = path.join(downloadsDir, asset.name);
    console.log(`[self-update] staging ${asset.name} → ${destPath}`);
    await downloadReleaseAsset(asset.browser_download_url, destPath, sendProgress);
    shell.showItemInFolder(destPath);
    return { ok: true, staged: true, path: destPath, version: release.tag_name };
  } catch (err) {
    console.warn("[self-update] failed:", err.message);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("check-repo-file", (_event, filePath) => {
  const prefs = loadPrefs();
  const profileId = isRepoFile(filePath, prefs.workingDir);
  return { repoFile: !!profileId, profileId };
});

ipcMain.handle("get-library-tree", () => {
  const prefs = loadPrefs();
  if (!prefs.workingDir) return { ok: false };
  const result = {};
  for (const [profileId, profile] of Object.entries(profiles)) {
    const profileDir = path.join(prefs.workingDir, profileId);
    if (!fs.existsSync(profileDir)) {
      result[profileId] = { name: profile.name, publishers: {} };
      continue;
    }
    const manifestPath = path.join(profileDir, ".manifest.json");
    const manifest = loadManifest(manifestPath);
    const publishers = {};
    // Recursively walk profile directory for all .scad files
    function walk(dir) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) { console.error("Failed to read directory:", dir, err); return; }
      for (const entry of entries) {
        // Skip the lib subtree and any dotfile/dotdir. This filters
        // .manifest.json, .bgsd-check-*.scad (temporary OpenSCAD check
        // files), .history-*.scad (version snapshots) and any other
        // hidden artefact users don't want in the homepage lister.
        if (entry.name === "lib" || entry.name.startsWith(".")) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(".scad")) {
          const relPath = path.relative(profileDir, fullPath).replace(/\\/g, "/");
          const parts = relPath.split("/");
          if (parts.length < 2) continue;
          const folder = parts[0];
          const name = parts.slice(1).join("/").replace(/\.scad$/, "");
          const isRepo = !!manifest.files[relPath];
          let mtime = 0;
          try { mtime = fs.statSync(fullPath).mtimeMs; } catch (err) { console.error("Failed to stat file:", fullPath, err); }
          if (!publishers[folder]) publishers[folder] = [];
          publishers[folder].push({ name, path: fullPath, isRepo, mtime });
        }
      }
    }
    walk(profileDir);
    result[profileId] = { name: profile.name, publishers, designsDir: profile.designsDir || "my_designs" };
  }
  return { ok: true, tree: result };
});

ipcMain.handle("delete-file", (_event, filePath) => {
  const prefs = loadPrefs();
  if (!validateFilePath(filePath) || !fs.existsSync(filePath)) {
    return { ok: false, error: "File not found" };
  }
  if (isRepoFile(filePath, prefs.workingDir)) {
    return { ok: false, error: "Cannot delete library-tracked file" };
  }
  if (!prefs.workingDir || !isInsideWorkingDir(filePath, prefs.workingDir)) {
    return { ok: false, error: "File is not inside the working directory" };
  }
  try {
    fs.unlinkSync(filePath);
    try { undoSidecar.deleteSidecar(filePath); } catch (err) { console.warn("[undo-sidecar] delete sidecar failed:", err.message); }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("rename-file", (_event, filePath, newName) => {
  const prefs = loadPrefs();
  if (!validateFilePath(filePath) || !fs.existsSync(filePath)) {
    return { ok: false, error: "File not found" };
  }
  if (isRepoFile(filePath, prefs.workingDir)) {
    return { ok: false, error: "Cannot rename library-tracked file" };
  }
  if (!prefs.workingDir || !isInsideWorkingDir(filePath, prefs.workingDir)) {
    return { ok: false, error: "File is not inside the working directory" };
  }
  if (typeof newName !== "string") return { ok: false, error: "Invalid name" };
  const trimmed = newName.trim();
  if (!trimmed) return { ok: false, error: "Name cannot be empty" };
  if (/[\\/\0]/.test(trimmed) || trimmed === "." || trimmed === "..") {
    return { ok: false, error: "Name contains invalid characters" };
  }
  const ext = path.extname(filePath);
  const baseName = trimmed.toLowerCase().endsWith(ext.toLowerCase()) ? trimmed : trimmed + ext;
  const newPath = path.join(path.dirname(filePath), baseName);
  if (newPath === filePath) return { ok: true, filePath: newPath };
  if (!isInsideWorkingDir(newPath, prefs.workingDir)) {
    return { ok: false, error: "Target path is outside the working directory" };
  }
  if (fs.existsSync(newPath)) {
    return { ok: false, error: "A file with that name already exists" };
  }
  try {
    fs.renameSync(filePath, newPath);
    try { undoSidecar.renameSidecar(filePath, newPath); } catch (err) { console.warn("[undo-sidecar] rename sidecar failed:", err.message); }
    return { ok: true, filePath: newPath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("duplicate-file", (_event, filePath) => {
  const prefs = loadPrefs();
  if (!validateFilePath(filePath) || !fs.existsSync(filePath)) {
    return { ok: false, error: "File not found" };
  }
  if (!prefs.workingDir || !isInsideWorkingDir(filePath, prefs.workingDir)) {
    return { ok: false, error: "File is not inside the working directory" };
  }
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  // Find unique destination: <base>_copy<ext>, <base>_copy_2<ext>, ...
  let candidate = path.join(dir, `${base}_copy${ext}`);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}_copy_${n++}${ext}`);
    if (n > 999) return { ok: false, error: "Could not find a unique name" };
  }
  if (!isInsideWorkingDir(candidate, prefs.workingDir)) {
    return { ok: false, error: "Target path is outside the working directory" };
  }
  try {
    fs.copyFileSync(filePath, candidate);
    // Make the new file writable (the source might be a read-only repo copy)
    try { fs.chmodSync(candidate, 0o644); } catch {
      // Some filesystems ignore chmod; duplicate still succeeds if the copy exists.
    }
    try {
      undoSidecar.initializeSidecar(candidate, fs.readFileSync(candidate, "utf-8"), { reset: true });
    } catch (err) {
      console.warn("[undo-sidecar] duplicate history init failed:", err.message);
    }
    return { ok: true, filePath: candidate };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- Presets IPC ---

ipcMain.handle("get-presets", (_event, publisherConstantsFile) => {
  const prefs = loadPrefs();
  if (!prefs.workingDir) return {};

  const libDir = path.join(prefs.workingDir, "ctd", "lib");
  let entries = [];

  if (publisherConstantsFile) {
    const constPath = path.join(libDir, publisherConstantsFile);
    entries = parseConstantsFile(constPath);
  } else {
    // Fall back to global_constants.scad only
    const globalPath = path.join(libDir, "global_constants.scad");
    entries = parseConstantsFile(globalPath);
  }

  // Group by field name
  const map = {};
  for (const entry of entries) {
    if (!map[entry.field]) map[entry.field] = [];
    map[entry.field].push({ name: entry.name, label: entry.label, value: entry.value });
  }
  return map;
});

async function refreshLatestProfileCachesOnStartup(prefs) {
  for (const [profileId, profile] of Object.entries(profiles)) {
    if (!profile.latestFilePattern) continue;
    try {
      const latest = await ensureLatestLibrary(profileId, { workingDir: prefs.workingDir });
      console.log(`[library] latest ${profileId}: ${latest.filename}`);
    } catch (err) {
      console.warn(`[library] latest ${profileId} probe failed:`, err.message);
    }
  }
}

async function refreshLibrariesOnStartup() {
  const prefs = loadPrefs();
  await refreshLatestProfileCachesOnStartup(prefs);

  if (!prefs.workingDir) return;

  const messages = [];
  try {
    const result = await updateLibraries(prefs.workingDir, (msg) => {
      messages.push(msg);
      console.log(`[library] ${msg}`);
    });
    const skipped = result?.skippedUserFiles || [];
    if (skipped.length > 0) {
      console.log(`[library] startup update skipped ${skipped.length} writable local file(s)`);
    }
    console.log(`[library] startup update complete (${messages.length} refreshed message(s))`);
    if (mainWindow) {
      mainWindow.webContents.send("startup-libraries-updated", { ok: true, messages, skippedUserFiles: skipped });
    }
  } catch (err) {
    console.warn("[library] startup update failed:", err.message);
    if (mainWindow) {
      mainWindow.webContents.send("startup-libraries-updated", { ok: false, error: err.message });
    }
  }
}

app.whenReady().then(() => {
  const prefs = loadPrefs();
  if (prefs.proxy) setProxy(prefs.proxy);
  createWindow();
  void refreshLibrariesOnStartup();
});
app.on("window-all-closed", () => app.quit());

// Surface errors as a dialog instead of a silent crash
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  try { dialog.showErrorBox("BGSD Error", err.stack || err.message); } catch (e) { console.error("Failed to show error dialog:", e); }
  app.exit(1);
});
