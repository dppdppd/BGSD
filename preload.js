const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bgsd", {
  getPendingLoad: () => ipcRenderer.invoke("get-pending-load"),
  platform: process.platform,
  harness: !!process.env.BGSD_HARNESS,

  setTitle: (title) => ipcRenderer.send("set-title", title),
  openFile: () => ipcRenderer.invoke("open-file"),
  saveFile: (filePath, scadText, needsBackup, profileId) => ipcRenderer.invoke("save-file", filePath, scadText, needsBackup, profileId),
  saveFileAs: (scadText, profileId) => ipcRenderer.invoke("save-file-as", scadText, profileId),
  openInOpenScad: (filePath, profileId) => ipcRenderer.invoke("open-in-openscad", filePath, profileId),
  loadFilePath: (filePath) => ipcRenderer.invoke("load-file-path", filePath),
  newProjectToPath: (profile) => ipcRenderer.invoke("new-project-to-path", profile),

  checkRepoFile: (filePath) => ipcRenderer.invoke("check-repo-file", filePath),
  getLibraryTree: () => ipcRenderer.invoke("get-library-tree"),

  // Working directory
  browseWorkingDir: () => ipcRenderer.invoke("browse-working-dir"),
  initWorkingDir: (dirPath) => ipcRenderer.invoke("init-working-dir", dirPath),
  updateLibraries: () => ipcRenderer.invoke("update-libraries"),
  getWorkingDirStatus: () => ipcRenderer.invoke("get-working-dir-status"),

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
  onMenuToggleHideDefaults: (callback) => ipcRenderer.on("menu-toggle-hide-defaults", (_event, checked) => callback(checked)),
  onMenuToggleShowScad: (callback) => ipcRenderer.on("menu-toggle-show-scad", (_event, checked) => callback(checked)),
});
