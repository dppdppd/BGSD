const { contextBridge, ipcRenderer } = require("electron");
const profiles = require("./lib/profiles.json");

// Static lib versions parsed from each profile's include filename
// (e.g. "boardgame_insert_toolkit_lib.4.scad" → 4). Computed once at preload
// time so the renderer can render all profiles up-front without an IPC round
// trip. Profile id is the key (e.g. "bit" → 4, "ctd" → 1).
const libVersions = (() => {
  const out = {};
  for (const [id, p] of Object.entries(profiles)) {
    const m = (p.include || "").match(/_lib\.(\d+)\.scad/);
    out[id] = { name: p.name, major: m ? parseInt(m[1], 10) : null };
  }
  return out;
})();

contextBridge.exposeInMainWorld("bgsd", {
  getPendingLoad: () => ipcRenderer.invoke("get-pending-load"),
  platform: process.platform,
  harness: !!process.env.BGSD_HARNESS,
  libVersions,

  setTitle: (title) => ipcRenderer.send("set-title", title),
  openFile: () => ipcRenderer.invoke("open-file"),
  saveFile: (filePath, scadText, needsBackup, profileId) => ipcRenderer.invoke("save-file", filePath, scadText, needsBackup, profileId),
  saveFileAs: (scadText, profileId, currentPath) => ipcRenderer.invoke("save-file-as", scadText, profileId, currentPath),
  openInOpenScad: (filePath, profileId) => ipcRenderer.invoke("open-in-openscad", filePath, profileId),
  loadFilePath: (filePath) => ipcRenderer.invoke("load-file-path", filePath),
  newProjectToPath: (profile) => ipcRenderer.invoke("new-project-to-path", profile),

  copyTemplate: (sourcePath) => ipcRenderer.invoke("copy-template", sourcePath),
  exportStl: (sourcePath) => ipcRenderer.invoke("export-stl", sourcePath),
  checkRepoFile: (filePath) => ipcRenderer.invoke("check-repo-file", filePath),
  deleteFile: (filePath) => ipcRenderer.invoke("delete-file", filePath),
  renameFile: (filePath, newName) => ipcRenderer.invoke("rename-file", filePath, newName),
  getLibraryTree: () => ipcRenderer.invoke("get-library-tree"),

  // Working directory
  browseWorkingDir: () => ipcRenderer.invoke("browse-working-dir"),
  initWorkingDir: (dirPath) => ipcRenderer.invoke("init-working-dir", dirPath),
  updateLibraries: () => ipcRenderer.invoke("update-libraries"),
  getWorkingDirStatus: () => ipcRenderer.invoke("get-working-dir-status"),
  checkUpdates: () => ipcRenderer.invoke("check-updates"),

  // Presets
  getPresets: (publisherFile) => ipcRenderer.invoke("get-presets", publisherFile),

  // External links
  openExternal: (url) => ipcRenderer.invoke("open-external", url),

  // Preferences
  getPreferences: () => ipcRenderer.invoke("get-preferences"),
  setPreferences: (prefs) => ipcRenderer.invoke("set-preferences", prefs),
  browseOpenScad: () => ipcRenderer.invoke("browse-openscad"),

  onWorkingDirProgress: (callback) => ipcRenderer.on("working-dir-progress", (_event, msg) => callback(msg)),

  // Menu event listeners
  onMenuNew: (callback) => ipcRenderer.on("menu-new", (_event, profile) => callback(_event, profile)),
  onMenuOpen: (callback) => ipcRenderer.on("menu-open", (_event, data) => callback(data)),
  onMenuSaveAs: (callback) => ipcRenderer.on("menu-save-as", callback),
  onMenuOpenInOpenScad: (callback) => ipcRenderer.on("menu-open-in-openscad", callback),
  onMenuPreferences: (callback) => ipcRenderer.on("menu-preferences", callback),
  onMenuUndo: (callback) => ipcRenderer.on("menu-undo", callback),
  onMenuRedo: (callback) => ipcRenderer.on("menu-redo", callback),
  onMenuDefaultsMode: (callback) => ipcRenderer.on("menu-defaults-mode", (_event, mode) => callback(mode)),
  onMenuToggleShowScad: (callback) => ipcRenderer.on("menu-toggle-show-scad", (_event, checked) => callback(checked)),
});
