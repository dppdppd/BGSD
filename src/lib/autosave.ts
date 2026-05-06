import { get } from "svelte/store";
import { project } from "./stores/project";
import { generateScad } from "./scad";
import { DEBOUNCE_MS } from "./config";

let filePath: string | null = null;
let needsBackup = false;
let readOnly = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let suppressNextProjectSave = false;
let saveStatus: (msg: string) => void = () => {};
let onReadOnlySave: (() => void) | null = null;
let onExternalChange: ((result: SaveResult) => void) | null = null;
let fileState: FileState | null = null;
let externalChangePending = false;
let externalChangeResult: SaveResult | null = null;

export interface FileState {
  exists: boolean;
  size: number;
  mtimeMs: number;
  sha256: string;
}

export interface SaveResult {
  ok: boolean;
  filePath?: string;
  error?: string;
  repoFile?: boolean;
  readOnlyFile?: boolean;
  externalChange?: boolean;
  deleted?: boolean;
  fileState?: FileState;
}

export interface SaveOptions {
  forceNewRevision?: boolean;
  allowOverwriteExternal?: boolean;
}

export function setFilePath(path: string | null) {
  filePath = path || null;
  fileState = null;
  clearExternalFileChange();
}

export function getFilePath(): string | null {
  return filePath;
}

export function setNeedsBackup(val: boolean) {
  needsBackup = val;
}

export function getNeedsBackup(): boolean {
  return needsBackup;
}

export function setReadOnly(val: boolean) {
  readOnly = val;
}

export function getReadOnly(): boolean {
  return readOnly;
}

export function onReadOnlyEdit(cb: () => void) {
  onReadOnlySave = cb;
}

export function onExternalFileChange(cb: (result: SaveResult) => void) {
  onExternalChange = cb;
}

export function onSaveStatus(cb: (msg: string) => void) {
  saveStatus = cb;
}

export function suppressNextAutosave() {
  suppressNextProjectSave = true;
}

export function setFileState(state: FileState | null | undefined) {
  fileState = state || null;
}

export function getFileState(): FileState | null {
  return fileState;
}

export function markExternalFileChange(result: SaveResult) {
  externalChangePending = true;
  externalChangeResult = result;
}

export function clearExternalFileChange() {
  externalChangePending = false;
  externalChangeResult = null;
}

async function doSave(options: SaveOptions = {}): Promise<SaveResult> {
  if (!filePath) return { ok: false, error: "No file open" };
  if (readOnly) return { ok: false, error: "Read-only file", readOnlyFile: true };
  if (externalChangePending && !options.allowOverwriteExternal) {
    const result = externalChangeResult || { ok: false, filePath, error: "File changed outside BGSD", externalChange: true };
    saveStatus(result.deleted ? "File deleted outside BGSD" : "File changed outside BGSD");
    if (onExternalChange) onExternalChange({ ...result, filePath });
    return { ...result, filePath };
  }
  const bgsd = (window as any).bgsd;
  if (!bgsd?.saveFile) return { ok: false, error: "Save API unavailable" };

  const proj = get(project);
  const scadText = generateScad(proj);
  saveStatus("Saving...");
  const result = await bgsd.saveFile(filePath, scadText, needsBackup, proj.libraryProfile, { ...options, fileState }) as SaveResult;
  if (result.ok) {
    if (result.filePath && typeof result.filePath === "string") {
      filePath = result.filePath;
    }
    if (result.fileState) fileState = result.fileState;
    clearExternalFileChange();
    needsBackup = false; // Only backup once
    saveStatus(`${options.forceNewRevision ? "Version saved" : "Saved"} ${new Date().toLocaleTimeString()}`);
  } else if (result.externalChange) {
    markExternalFileChange({ ...result, filePath });
    saveStatus(result.deleted ? "File deleted outside BGSD" : "File changed outside BGSD");
    if (onExternalChange) onExternalChange({ ...result, filePath });
  } else if (result.repoFile) {
    // Server-side safety net: file is repo-tracked
    readOnly = true;
    if (onReadOnlySave) onReadOnlySave();
  } else if (result.readOnlyFile) {
    // User declined to make the file writable
    readOnly = true;
    saveStatus("Read-only — use File > Save As to create an editable copy");
  } else {
    saveStatus(`Save failed: ${result.error}`);
  }
  return { ...result, filePath };
}

export async function saveNow(options: SaveOptions = {}): Promise<string | null> {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  const result = await doSave(options);
  return result.ok ? filePath : null;
}

export async function saveNowDetailed(options: SaveOptions = {}): Promise<SaveResult> {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  return doSave(options);
}

export function triggerSave() {
  if (readOnly) {
    if (onReadOnlySave) onReadOnlySave();
    return;
  }
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(doSave, DEBOUNCE_MS);
}

export function startAutosave() {
  let first = true;
  project.subscribe(() => {
    if (first) { first = false; return; }
    if (suppressNextProjectSave) {
      suppressNextProjectSave = false;
      return;
    }
    triggerSave();
  });
}
