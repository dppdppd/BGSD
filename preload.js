const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bgsd", {
  getPendingLoad: () => ipcRenderer.invoke("get-pending-load"),
  platform: process.platform,
  harness: !!process.env.BGSD_HARNESS,
  // libVersions used to be computed at preload load time via
  // require("./lib/profiles.json"), but in packaged builds the preload
  // runs sandboxed (contextIsolation: true) and arbitrary file requires
  // throw — taking the whole bridge down with them. Use IPC instead.
  getLibVersions: () => ipcRenderer.invoke("get-lib-versions"),

  setTitle: (title) => ipcRenderer.send("set-title", title),
  openFile: () => ipcRenderer.invoke("open-file"),
  saveFile: (filePath, scadText, needsBackup, profileId, options) => ipcRenderer.invoke("save-file", filePath, scadText, needsBackup, profileId, options),
  saveFileAs: (scadText, profileId, currentPath) => ipcRenderer.invoke("save-file-as", scadText, profileId, currentPath),
  checkFileState: (filePath, fileState) => ipcRenderer.invoke("check-file-state", filePath, fileState),
  checkOpenScad: (payload) => ipcRenderer.invoke("check-openscad", payload),
  openInOpenScad: (filePath, profileId) => ipcRenderer.invoke("open-in-openscad", filePath, profileId),
  openUndoRevisionInOpenScad: (filePath, revisionId, profileId) => ipcRenderer.invoke("open-undo-revision-in-openscad", filePath, revisionId, profileId),
  loadFilePath: (filePath) => ipcRenderer.invoke("load-file-path", filePath),
  getRecentFiles: () => ipcRenderer.invoke("get-recent-files"),
  newProjectToPath: (profile) => ipcRenderer.invoke("new-project-to-path", profile),
  getUndoHistory: (filePath) => ipcRenderer.invoke("get-undo-history", filePath),
  listUndoHistory: (filePath) => ipcRenderer.invoke("list-undo-history", filePath),
  loadUndoRevision: (filePath, revisionId) => ipcRenderer.invoke("load-undo-revision", filePath, revisionId),
  labelUndoRevision: (filePath, revisionId, label) => ipcRenderer.invoke("label-undo-revision", filePath, revisionId, label),
  pinUndoRevision: (filePath, revisionId, pinned) => ipcRenderer.invoke("pin-undo-revision", filePath, revisionId, pinned),
  pruneUndoHistory: (filePath, keepCount) => ipcRenderer.invoke("prune-undo-history", filePath, keepCount),

  copyTemplate: (sourcePath) => ipcRenderer.invoke("copy-template", sourcePath),
  exportStl: (sourcePath) => ipcRenderer.invoke("export-stl", sourcePath),
  checkRepoFile: (filePath) => ipcRenderer.invoke("check-repo-file", filePath),
  deleteFile: (filePath) => ipcRenderer.invoke("delete-file", filePath),
  renameFile: (filePath, newName) => ipcRenderer.invoke("rename-file", filePath, newName),
  duplicateFile: (filePath) => ipcRenderer.invoke("duplicate-file", filePath),
  getLibraryTree: () => ipcRenderer.invoke("get-library-tree"),

  // Working directory
  browseWorkingDir: () => ipcRenderer.invoke("browse-working-dir"),
  initWorkingDir: (dirPath) => ipcRenderer.invoke("init-working-dir", dirPath),
  updateLibraries: () => ipcRenderer.invoke("update-libraries"),
  ensureLatestLibrary: (profile) => ipcRenderer.invoke("ensure-latest-library", profile),
  getWorkingDirStatus: () => ipcRenderer.invoke("get-working-dir-status"),
  checkUpdates: () => ipcRenderer.invoke("check-updates"),
  selfUpdate: () => ipcRenderer.invoke("self-update"),
  onSelfUpdateProgress: (callback) => ipcRenderer.on("self-update-progress", (_event, data) => callback(data)),
  onStartupLibrariesUpdated: (callback) => ipcRenderer.on("startup-libraries-updated", (_event, data) => callback(data)),

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
  onMenuSave: (callback) => ipcRenderer.on("menu-save", callback),
  onMenuSaveAs: (callback) => ipcRenderer.on("menu-save-as", callback),
  onMenuFileHistory: (callback) => ipcRenderer.on("menu-file-history", callback),
  onMenuOpenInOpenScad: (callback) => ipcRenderer.on("menu-open-in-openscad", callback),
  onMenuPreferences: (callback) => ipcRenderer.on("menu-preferences", callback),
  onMenuUndo: (callback) => ipcRenderer.on("menu-undo", callback),
  onMenuRedo: (callback) => ipcRenderer.on("menu-redo", callback),
  onMenuToggleShowScad: (callback) => ipcRenderer.on("menu-toggle-show-scad", (_event, checked) => callback(checked)),
});
