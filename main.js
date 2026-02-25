const { app, BrowserWindow, ipcMain, dialog, Menu } = require("electron");
const path = require("path");
const fs = require("fs");
const { importScad } = require("./importer");
const { ensureLibrary, copyLibToDir, initWorkingDir, updateLibraries, isInsideWorkingDir, isRepoFile, loadManifest, profiles, setProxy, getProxy } = require("./lib/library-manager");

// Prevent GPU-related crashes on Windows (packaged exe doesn't get --disable-gpu)
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("no-sandbox");

let mainWindow;

// --- Recent files ---
const RECENT_FILE = path.join(app.getPath("userData"), "recent-files.json");
const MAX_RECENT = 10;

// --- Preferences ---
const PREFS_FILE = path.join(app.getPath("userData"), "preferences.json");
const DEFAULT_PREFS = { openScadPath: "", autoOpenInOpenScad: true, reuseOpenScad: true, workingDir: "", proxy: "" };
let openScadAlive = false;
let openScadProc = null;
let openScadFile = null;

function loadPrefs() {
  try {
    if (fs.existsSync(PREFS_FILE)) {
      return { ...DEFAULT_PREFS, ...JSON.parse(fs.readFileSync(PREFS_FILE, "utf-8")) };
    }
  } catch (_) {}
  return { ...DEFAULT_PREFS };
}

function savePrefs(prefs) {
  try { fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2), "utf-8"); } catch (_) {}
}

function loadRecent() {
  try {
    if (fs.existsSync(RECENT_FILE)) return JSON.parse(fs.readFileSync(RECENT_FILE, "utf-8"));
  } catch (_) {}
  return [];
}

function saveRecent(list) {
  try { fs.writeFileSync(RECENT_FILE, JSON.stringify(list), "utf-8"); } catch (_) {}
}

function addRecent(filePath) {
  let list = loadRecent().filter(f => f !== filePath);
  list.unshift(filePath);
  if (list.length > MAX_RECENT) list = list.slice(0, MAX_RECENT);
  saveRecent(list);
  rebuildMenu();
}

function openFilePath(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const project = importScad(content);
    mainWindow.webContents.send("menu-open", { data: project, filePath });
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
              label: "BIT — Board Game Insert",
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
          label: "Save As...",
          accelerator: "CmdOrCtrl+Shift+S",
          click: () => mainWindow.webContents.send("menu-save-as"),
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
      label: "View",
      submenu: [
        {
          id: "hide-defaults",
          label: "Hide Defaults",
          type: "checkbox",
          checked: false,
          click: (menuItem) => mainWindow.webContents.send("menu-toggle-hide-defaults", menuItem.checked),
        },
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
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  mainWindow.loadFile(path.join(__dirname, "dist", "index.html"));

  rebuildMenu();

  // Auto-load file from env or CLI arg
  const autoLoad = process.env.BGSD_OPEN || process.argv.find(a => a.endsWith(".scad"));
  if (autoLoad) {
    try {
      console.log("Auto-loading:", autoLoad);
      const content = fs.readFileSync(autoLoad, "utf-8");
      const proj = importScad(content);
      console.log("Parsed", proj.lines.length, "lines");
      pendingLoad = { data: proj, filePath: autoLoad };
      addRecent(autoLoad);
    } catch (err) {
      console.error("Auto-load failed:", err.message);
    }
  }
}

// --- Helpers ---

function atomicWrite(filePath, content) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, content, "utf-8");
  fs.renameSync(tmp, filePath);
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
    const project = importScad(content);
    addRecent(filePath);
    return { ok: true, filePath, data: project };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("save-file", async (_event, filePath, scadText, needsBackup, profileId) => {
  try {
    // Reject saves to repo-tracked files — they'll be overwritten on library update
    const prefs = loadPrefs();
    if (isRepoFile(filePath, prefs.workingDir)) {
      return { ok: false, error: "repo-file", repoFile: true };
    }
    if (needsBackup && fs.existsSync(filePath)) {
      const bakPath = filePath + ".bak";
      if (!fs.existsSync(bakPath)) {
        fs.copyFileSync(filePath, bakPath);
      }
    }
    atomicWrite(filePath, scadText);
    // Copy library files next to saved .scad so OpenSCAD includes resolve
    // Skip if the file is inside the working directory (libs already in lib/)
    let libraryError = null;
    if (profileId && !isInsideWorkingDir(filePath, prefs.workingDir)) {
      try { await copyLibToDir(profileId, path.dirname(filePath)); } catch (e) {
        libraryError = e.message;
        console.warn("Library copy failed (non-fatal):", e.message);
      }
    }
    return { ok: true, filePath, libraryError };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("save-file-as", async (_event, scadText, profileId, currentPath) => {
  const defaultPath = currentPath ? path.join(path.dirname(currentPath), "design.scad") : "design.scad";
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Save SCAD File",
    filters: [{ name: "OpenSCAD", extensions: ["scad"] }],
    defaultPath,
  });
  if (result.canceled) return { ok: false };
  try {
    // If we have an existing on-disk file, copy it (preserves includes, comments, etc.)
    if (currentPath && fs.existsSync(currentPath)) {
      fs.copyFileSync(currentPath, result.filePath);
    } else {
      atomicWrite(result.filePath, scadText);
    }
    let libraryError = null;
    const saPrefs = loadPrefs();
    if (profileId && !isInsideWorkingDir(result.filePath, saPrefs.workingDir)) {
      try { await copyLibToDir(profileId, path.dirname(result.filePath)); } catch (e) {
        libraryError = e.message;
        console.warn("Library copy failed (non-fatal):", e.message);
      }
    }
    return { ok: true, filePath: result.filePath, libraryError };
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
      const designsDir = path.join(prefs.workingDir, profileId, profiles[profileId].designsDir || "designs");
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
    return { ok: true, filePath: result.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- OpenSCAD path resolution ---

function findOpenScad() {
  const prefs = loadPrefs();

  // 1. Check user-configured path from preferences
  if (prefs.openScadPath && fs.existsSync(prefs.openScadPath)) {
    return prefs.openScadPath;
  }

  // 2. Platform-specific candidate paths
  let platformCandidates;
  if (process.platform === "win32") {
    platformCandidates = [
      "C:\\Program Files\\OpenSCAD\\openscad.exe",
      "C:\\Program Files (x86)\\OpenSCAD\\openscad.exe",
      "C:\\Program Files\\OpenSCAD (Nightly)\\openscad.exe",
    ];
  } else if (process.platform === "darwin") {
    platformCandidates = ["/Applications/OpenSCAD.app/Contents/MacOS/OpenSCAD"];
  } else {
    platformCandidates = ["/usr/bin/openscad", "/usr/local/bin/openscad", "/snap/bin/openscad"];
  }

  const found = platformCandidates.find(c => fs.existsSync(c));
  if (found) return found;

  // 3. Fall back to bare "openscad" (PATH lookup)
  return "openscad";
}

ipcMain.handle("open-in-openscad", async (_event, filePath, profileId) => {
  const { spawn } = require("child_process");
  if (!filePath || !fs.existsSync(filePath)) {
    return { ok: false, error: `File not found: ${filePath || "(no path)"}` };
  }

  // Ensure library files are next to the .scad before launching OpenSCAD
  // Skip if file is inside the working directory (libs already in lib/)
  const prefs = loadPrefs();
  let libraryError = null;
  if (profileId && !isInsideWorkingDir(filePath, prefs.workingDir)) {
    try { await copyLibToDir(profileId, path.dirname(filePath)); } catch (e) {
      libraryError = e.message;
      console.warn("Library copy failed (non-fatal):", e.message);
    }
  }

  // If reuse is enabled and OpenSCAD is already showing this exact file, skip
  if (prefs.reuseOpenScad && openScadAlive && openScadFile === filePath) {
    return { ok: true, libraryError };
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
    } catch (_) {}
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

  const cmd = findOpenScad();

  // On Windows without a found path, use 'start' as last resort
  if (process.platform === "win32" && cmd === "openscad") {
    try {
      spawnOpenScad("cmd", ["/c", "start", "", filePath]);
      return { ok: true, libraryError };
    } catch (_) {
      return { ok: false, error: "not-found", libraryError };
    }
  }

  try {
    spawnOpenScad(cmd, [filePath]);
    return { ok: true, libraryError };
  } catch (err) {
    return { ok: false, error: "not-found", libraryError };
  }
});

ipcMain.handle("export-stl", async (_event, sourcePath) => {
  const { execFile } = require("child_process");
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return { ok: false, error: `File not found: ${sourcePath || "(no path)"}` };
  }

  // Ensure library files are accessible
  const prefs = loadPrefs();
  if (!isInsideWorkingDir(sourcePath, prefs.workingDir)) {
    // Detect profile from path to copy libs
    const profileId = isRepoFile(sourcePath, prefs.workingDir);
    if (profileId) {
      try { await copyLibToDir(profileId, path.dirname(sourcePath)); } catch (_) {}
    }
  }

  // Show Save dialog for .stl output
  const defaultName = path.basename(sourcePath, ".scad") + ".stl";
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Export STL",
    filters: [{ name: "STL Files", extensions: ["stl"] }],
    defaultPath: path.join(path.dirname(sourcePath), defaultName),
  });
  if (result.canceled) return { ok: false };

  const cmd = findOpenScad();

  // Verify OpenSCAD is reachable before starting a long export
  const canRun = await new Promise((resolve) => {
    execFile(cmd, ["--version"], { timeout: 5000 }, (err) => resolve(!err));
  });
  if (!canRun) return { ok: false, error: "not-found" };

  return new Promise((resolve) => {
    execFile(cmd, ["-o", result.filePath, sourcePath], { timeout: 120000 }, (err, _stdout, stderr) => {
      if (err) {
        resolve({ ok: false, error: stderr || err.message });
      } else {
        resolve({ ok: true, filePath: result.filePath });
      }
    });
  });
});

// --- Preferences IPC ---

ipcMain.handle("get-preferences", () => loadPrefs());

ipcMain.handle("set-preferences", (_event, prefs) => {
  const merged = { ...loadPrefs(), ...prefs };
  savePrefs(merged);
  if ("proxy" in prefs) setProxy(merged.proxy);
  return merged;
});

ipcMain.handle("browse-openscad", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Locate OpenSCAD Executable",
    filters: process.platform === "win32"
      ? [{ name: "Executables", extensions: ["exe"] }]
      : [{ name: "All Files", extensions: ["*"] }],
    properties: ["openFile"],
  });
  if (result.canceled) return { ok: false };
  return { ok: true, path: result.filePaths[0] };
});

// --- Create new project to temp path or working dir ---
ipcMain.handle("new-project-to-path", async (_event, profile) => {
  const os = require("os");
  const profileObj = profiles[profile];
  const includeFile = profileObj ? profileObj.include : "boardgame_insert_toolkit_lib.4.scad";
  const templates = {
    bit: `// BGSD\ninclude <${includeFile}>;\ndata = [\n    [ OBJECT_BOX, [\n        [ NAME, "box 1" ],\n        [ BOX_SIZE_XYZ, [50, 50, 20] ],\n    ]],\n];\nMake(data);`,
    ctd: `// BGSD\ninclude <${includeFile}>;\nscene_1 = [\n    [ COUNTER_SET,\n        [ COUNTER_SIZE_XYZ, [13.3, 13.3, 3] ],\n    ],\n];\nMake(scene_1);`,
  };
  const scad = templates[profile] || templates.bit;

  // Use working directory if set, otherwise fall back to tmpdir
  const prefs = loadPrefs();
  let filePath;
  if (prefs.workingDir && profileObj) {
    const designsDir = path.join(prefs.workingDir, profile, profileObj.designsDir || "designs");
    fs.mkdirSync(designsDir, { recursive: true });
    filePath = path.join(designsDir, `bgsd_${profile}_${Date.now()}.scad`);
  } else {
    filePath = path.join(os.tmpdir(), `bgsd_${profile}_${Date.now()}.scad`);
  }

  try {
    atomicWrite(filePath, scad);
    // Only copy libs beside the file if NOT inside working dir
    if (!prefs.workingDir || !isInsideWorkingDir(filePath, prefs.workingDir)) {
      try { await copyLibToDir(profile, path.dirname(filePath)); } catch {}
    }
    const project = importScad(fs.readFileSync(filePath, "utf-8"));
    addRecent(filePath);
    if (mainWindow) mainWindow.webContents.send("menu-open", { data: project, filePath });
    return { ok: true, filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// --- Load file by path (for new-project round-trip) ---
ipcMain.handle("load-file-path", (_event, filePath) => {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const project = importScad(content);
    addRecent(filePath);
    return { ok: true, data: project, filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
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
    await updateLibraries(prefs.workingDir, (msg) => {
      messages.push(msg);
      if (mainWindow) mainWindow.webContents.send("working-dir-progress", msg);
    });
    return { ok: true, messages };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle("get-working-dir-status", () => {
  const prefs = loadPrefs();
  return { set: !!prefs.workingDir, path: prefs.workingDir || "" };
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
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = path.relative(profileDir, fullPath).replace(/\\/g, "/");
        if (relPath.startsWith("lib/") || relPath === "lib") continue;
        if (entry.name === ".manifest.json") continue;
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(".scad")) {
          const parts = relPath.split("/");
          if (parts.length < 2) continue;
          const folder = parts[0];
          const name = parts.slice(1).join("/").replace(/\.scad$/, "");
          const isRepo = !!manifest.files[relPath];
          let mtime = 0;
          try { mtime = fs.statSync(fullPath).mtimeMs; } catch (_) {}
          if (!publishers[folder]) publishers[folder] = [];
          publishers[folder].push({ name, path: fullPath, isRepo, mtime });
        }
      }
    }
    walk(profileDir);
    result[profileId] = { name: profile.name, publishers, designsDir: profile.designsDir || "designs" };
  }
  return { ok: true, tree: result };
});

ipcMain.handle("delete-file", (_event, filePath) => {
  const prefs = loadPrefs();
  if (!filePath || !fs.existsSync(filePath)) {
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
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

app.whenReady().then(() => {
  const prefs = loadPrefs();
  if (prefs.proxy) setProxy(prefs.proxy);
  createWindow();
});
app.on("window-all-closed", () => app.quit());

// Surface errors as a dialog instead of a silent crash
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  try { dialog.showErrorBox("BGSD Error", err.stack || err.message); } catch (_) {}
  app.exit(1);
});
