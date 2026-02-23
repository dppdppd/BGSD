const { app, BrowserWindow, ipcMain, dialog, Menu } = require("electron");
const path = require("path");
const fs = require("fs");
const { importScad } = require("./importer");
const { ensureLibrary, copyLibToDir, initWorkingDir, updateLibraries, isInsideWorkingDir, isRepoFile, loadManifest, profiles } = require("./lib/library-manager");

// Prevent GPU-related crashes on Windows (packaged exe doesn't get --disable-gpu)
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("no-sandbox");

let mainWindow;

// --- Recent files ---
const RECENT_FILE = path.join(app.getPath("userData"), "recent-files.json");
const MAX_RECENT = 10;

// --- Preferences ---
const PREFS_FILE = path.join(app.getPath("userData"), "preferences.json");
const DEFAULT_PREFS = { openScadPath: "", autoOpenInOpenScad: true, reuseOpenScad: true, workingDir: "" };
let openScadAlive = false;

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

ipcMain.handle("save-file-as", async (_event, scadText, profileId) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: "Save SCAD File",
    filters: [{ name: "OpenSCAD", extensions: ["scad"] }],
    defaultPath: "design.scad",
  });
  if (result.canceled) return { ok: false };
  try {
    atomicWrite(result.filePath, scadText);
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

  // If reuse is enabled and an OpenSCAD instance is already running, skip respawn
  if (prefs.reuseOpenScad && openScadAlive) {
    return { ok: true, libraryError };
  }

  function spawnOpenScad(cmd, args) {
    const proc = spawn(cmd, args, { detached: true, stdio: "ignore" });
    proc.unref();
    openScadAlive = true;
    proc.on("exit", () => { openScadAlive = false; });
    proc.on("error", () => { openScadAlive = false; });
    return proc;
  }

  // 1. Check user-configured path from preferences
  if (prefs.openScadPath && fs.existsSync(prefs.openScadPath)) {
    try {
      spawnOpenScad(prefs.openScadPath, [filePath]);
      return { ok: true, libraryError };
    } catch (err) {
      return { ok: false, error: err.message, libraryError };
    }
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

  let cmd = platformCandidates.find(c => fs.existsSync(c)) || null;

  // 3. Fall back to bare "openscad" (PATH lookup)
  if (!cmd) cmd = "openscad";

  // 4. On Windows without a found path, use 'start' as last resort
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

// --- Preferences IPC ---

ipcMain.handle("get-preferences", () => loadPrefs());

ipcMain.handle("set-preferences", (_event, prefs) => {
  const merged = { ...loadPrefs(), ...prefs };
  savePrefs(merged);
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
    const manifestPath = path.join(prefs.workingDir, profileId, ".manifest.json");
    const manifest = loadManifest(manifestPath);
    const designFiles = Object.keys(manifest.files || {}).filter(
      f => !f.startsWith("lib/") && f.endsWith(".scad")
    );
    if (!designFiles.length) continue;
    const publishers = {};
    for (const fp of designFiles) {
      const parts = fp.split("/");
      if (parts.length < 2) continue;
      const pub = parts[0];
      const name = parts.slice(1).join("/").replace(/\.scad$/, "");
      if (!publishers[pub]) publishers[pub] = [];
      publishers[pub].push({ name, path: path.join(prefs.workingDir, profileId, fp) });
    }
    result[profileId] = { name: profile.name, publishers };
  }
  return { ok: true, tree: result };
});

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());

// Surface errors as a dialog instead of a silent crash
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  try { dialog.showErrorBox("BGSD Error", err.stack || err.message); } catch (_) {}
  app.exit(1);
});
