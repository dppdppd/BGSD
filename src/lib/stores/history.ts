import { get, writable } from "svelte/store";
import { project, type Line } from "./project";

const MAX_HISTORY = 100;

let undoStack: Line[][] = [];
let redoStack: Line[][] = [];
let isRestoring = false;
let lastLines: Line[] | null = null;

export const canUndo = writable(false);
export const canRedo = writable(false);

function cloneLines(lines: Line[]): Line[] {
  return JSON.parse(JSON.stringify(lines));
}

function updateFlags() {
  canUndo.set(undoStack.length > 0);
  canRedo.set(redoStack.length > 0);
}

/** Start recording project changes for undo/redo. Call once at startup. */
export function startHistory() {
  const p = get(project);
  lastLines = cloneLines(p.lines);

  let first = true;
  project.subscribe((p) => {
    if (first) { first = false; return; }
    if (isRestoring) return;
    if (lastLines !== null) {
      undoStack.push(lastLines);
      if (undoStack.length > MAX_HISTORY) undoStack.shift();
      redoStack = [];
      updateFlags();
    }
    lastLines = cloneLines(p.lines);
  });
}

/** Clear all history (call when loading a new file). */
export function clearHistory() {
  undoStack = [];
  redoStack = [];
  const p = get(project);
  lastLines = cloneLines(p.lines);
  updateFlags();
}

/** Commit any uncommitted input before undo/redo so it becomes a recoverable edit. */
function commitActiveInput() {
  const el = document.activeElement;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

export function undo() {
  commitActiveInput();
  if (undoStack.length === 0) return;
  const current = get(project);
  redoStack.push(cloneLines(current.lines));
  const prev = undoStack.pop()!;
  isRestoring = true;
  project.update((p) => ({ ...p, lines: prev }));
  lastLines = cloneLines(prev);
  isRestoring = false;
  updateFlags();
}

export function redo() {
  commitActiveInput();
  if (redoStack.length === 0) return;
  const current = get(project);
  undoStack.push(cloneLines(current.lines));
  const next = redoStack.pop()!;
  isRestoring = true;
  project.update((p) => ({ ...p, lines: next }));
  lastLines = cloneLines(next);
  isRestoring = false;
  updateFlags();
}
