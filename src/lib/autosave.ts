import { get } from "svelte/store";
import { project } from "./stores/project";
import { generateScad } from "./scad";

let filePath: string | null = null;
let needsBackup = false;
let readOnly = false;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let saveStatus: (msg: string) => void = () => {};
let onReadOnlySave: (() => void) | null = null;

const DEBOUNCE_MS = 300;

export function setFilePath(path: string) {
  filePath = path;
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

export function onSaveStatus(cb: (msg: string) => void) {
  saveStatus = cb;
}

async function doSave() {
  if (!filePath) return;
  if (readOnly) return;
  const bgsd = (window as any).bgsd;
  if (!bgsd?.saveFile) return;

  const proj = get(project);
  const scadText = generateScad(proj);
  saveStatus("Saving...");
  const result = await bgsd.saveFile(filePath, scadText, needsBackup, proj.libraryProfile);
  if (result.ok) {
    if (result.filePath && typeof result.filePath === "string") {
      filePath = result.filePath;
    }
    needsBackup = false; // Only backup once
    saveStatus(`Saved ${new Date().toLocaleTimeString()}`);
  } else if (result.repoFile) {
    // Server-side safety net: file is repo-tracked
    readOnly = true;
    if (onReadOnlySave) onReadOnlySave();
  } else {
    saveStatus(`Save failed: ${result.error}`);
  }
}

export async function saveNow(): Promise<string | null> {
  await doSave();
  return filePath;
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
    triggerSave();
  });
}
