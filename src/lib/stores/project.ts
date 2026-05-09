import { writable } from "svelte/store";
import { INDENT } from "../config";

/** Preset entries keyed by schema field name (e.g. "COUNTER_SIZE_XYZ"). */
export const presets = writable<Record<string, { name: string; label: string; value: string }[]>>({});

/** Set of known constant names from parsed presets — emitted unquoted by formatKvValue.
 *  Plain Set for use in formatKvValue (non-reactive). */
export const knownConstants = new Set<string>();

/** Reactive version of knownConstants for UI re-rendering. */
export const knownConstantsStore = writable<Set<string>>(new Set());

/** Reactive map from constant name → display label. Writable store so UI re-renders when populated. */
export const constantLabels = writable<Record<string, string>>({});

/** A single line in the SCAD file. */
export interface Line {
  /** The original raw text of this line. */
  raw: string;
  /**
   * What we recognised this line as:
   *  - "raw"      : unrecognised → editable text input
   *  - "include"  : BIT lib include → badge (regenerated as v4)
   *  - "global"   : recognized global → inline control
   *  - "marker"   : // BGSD → badge (regenerated)
   *  - "makeall"  : Make(var); → badge (regenerated)
   *  - "kv"       : recognized [ KEY, VALUE ] → native control
   *  - "open"     : structural opening bracket
   *  - "close"    : structural closing bracket
   *  - "variable" : top-level variable assignment (e.g. `foo = [1,2,3];`)
   *  - "comment"  : standalone comment line (e.g. `// note`)
   */
  kind: string;
  /** Bracket nesting depth (0 = top level). */
  depth: number;
  /** For "open"/"close": structural role (data, object, params, label, lid, feature_list, feature, etc.) */
  role?: string;
  /** For "open"/"close": display label */
  label?: string;
  /** For "global" lines */
  globalKey?: string;
  globalValue?: any;
  /** True when global came from v4 inline [ G_*, value ] inside data[] */
  inlineGlobal?: boolean;
  /** For "kv" lines: recognized BIT key-value pair */
  kvKey?: string;
  kvValue?: any;
  /** For "include" lines: the file path inside angle brackets */
  includeFile?: string;
  /** Trailing comment (without the //) */
  comment?: string;
  /** For "open": true when this line opens two bracket levels (e.g. `[ "name", [`) */
  mergedOpen?: boolean;
  /** For "close": true when this line closes two bracket levels (e.g. `]],`) */
  mergedClose?: boolean;
  /** For data open/close and makeall lines: the scene variable name (e.g. "data", "scene_1") */
  varName?: string;
  /** For "variable" lines: the raw expression value (not parsed) */
  varValue?: string;
}

export interface Project {
  version: number;
  lines: Line[];
  hasMarker?: boolean;
  /** Detected library profile ID (e.g. "bit") */
  libraryProfile?: string;
  /** The include filename detected from the file (e.g. "boardgame_insert_toolkit_lib.4.scad") */
  libraryInclude?: string;
  /** Publisher constants file detected from includes (e.g. "gmt_constants.scad") */
  publisherConstantsFile?: string | null;
}

const emptyProject: Project = {
  version: 1,
  lines: [],
};

export const project = writable<Project>(emptyProject);

// --- Line operations ---

export function updateLineRaw(index: number, raw: string) {
  project.update((p) => {
    p.lines[index] = { ...p.lines[index], raw };
    return { ...p };
  });
}

/** Replace a line entirely (e.g. after re-classification). */
export function replaceLine(index: number, line: Line) {
  project.update((p) => {
    const existing = p.lines[index];
    // Cannot replace a structural bracket with a non-bracket.
    if ((existing?.kind === "open" || existing?.kind === "close") &&
        line.kind !== "open" && line.kind !== "close") return p;
    p.lines[index] = line;
    return { ...p };
  });
}

export function deleteLine(index: number) {
  project.update((p) => {
    const line = p.lines[index];
    // Structural brackets cannot be deleted individually.
    if (line?.kind === "open" || line?.kind === "close") return p;
    p.lines = p.lines.filter((_, i) => i !== index);
    return { ...p };
  });
}

/**
 * Delete a matched block: from the open bracket at `index` through its matching close.
 * The last remaining data block cannot be deleted.
 */
export function deleteBlock(index: number) {
  project.update((p) => {
    const line = p.lines[index];
    if (line?.kind !== "open") return p;
    if (line.role === "data") {
      // Don't delete the last scene
      const sceneCount = p.lines.filter(l => l.kind === "open" && l.role === "data").length;
      if (sceneCount <= 1) return p;
    }

    // Find matching close by tracking depth (merged brackets count as 2)
    let depth = 0;
    let closeIdx = -1;
    for (let i = index; i < p.lines.length; i++) {
      if (p.lines[i].kind === "open") depth += p.lines[i].mergedOpen ? 2 : 1;
      if (p.lines[i].kind === "close") {
        depth -= p.lines[i].mergedClose ? 2 : 1;
        if (depth <= 0) { closeIdx = i; break; }
      }
    }
    if (closeIdx < 0) return p; // unmatched — shouldn't happen

    p.lines.splice(index, closeIdx - index + 1);

    // After a scene deletion, the file should still have exactly one Make(...).
    // If any makeall now references a varName that no longer exists, re-point
    // it at the first remaining scene so the SCAD stays valid.
    if (line.role === "data") {
      const sceneVarNames = new Set(
        p.lines.filter((l) => l.kind === "open" && l.role === "data").map((l) => l.varName)
      );
      const firstSceneName = p.lines.find((l) => l.kind === "open" && l.role === "data")?.varName;
      if (firstSceneName) {
        for (const l of p.lines) {
          if (l.kind === "makeall" && l.varName && !sceneVarNames.has(l.varName)) {
            l.varName = firstSceneName;
            l.raw = `Make(${firstSceneName});`;
          }
        }
      }
    }

    return { ...p };
  });
}

/**
 * Duplicate a block: clone from the open bracket at `index` through its matching close,
 * and insert the copy immediately after the original.
 */
export function duplicateBlock(index: number) {
  project.update((p) => {
    const line = p.lines[index];
    if (line?.kind !== "open") return p;

    // Find matching close
    let depth = 0;
    let closeIdx = -1;
    for (let i = index; i < p.lines.length; i++) {
      if (p.lines[i].kind === "open") depth += p.lines[i].mergedOpen ? 2 : 1;
      if (p.lines[i].kind === "close") {
        depth -= p.lines[i].mergedClose ? 2 : 1;
        if (depth <= 0) { closeIdx = i; break; }
      }
    }
    if (closeIdx < 0) return p;

    // Deep-clone the block lines
    const cloned = p.lines.slice(index, closeIdx + 1).map(l => ({ ...l }));

    // Insert after the close bracket
    p.lines.splice(closeIdx + 1, 0, ...cloned);
    return { ...p };
  });
}

export function insertLine(index: number, line: Line) {
  project.update((p) => {
    p.lines.splice(index, 0, line);
    return { ...p };
  });
}

/** Update a global line's value. */
export function updateGlobal(index: number, value: any) {
  project.update((p) => {
    const line = p.lines[index];
    if (line?.kind !== "global" || !line.globalKey) return p;
    line.globalValue = value;
    line.raw = formatGlobalRaw(line.globalKey, value, line.inlineGlobal, line.raw);
    return { ...p };
  });
}

/** Update a global line's value, or delete if it matches the schema default. */
export function updateGlobalWithDefault(index: number, value: any, schemaDefault: any) {
  project.update((p) => {
    const line = p.lines[index];
    if (line?.kind !== "global" || !line.globalKey) return p;
    if (schemaDefault !== undefined && JSON.stringify(value) === JSON.stringify(schemaDefault)) {
      p.lines.splice(index, 1);
      return { ...p };
    }
    line.globalValue = value;
    line.raw = formatGlobalRaw(line.globalKey, value, line.inlineGlobal, line.raw);
    return { ...p };
  });
}

/** Materialize a virtual global: insert a kind:"global" line before `beforeIndex`. */
export function materializeGlobal(beforeIndex: number, key: string, value: any) {
  project.update((p) => {
    const raw = formatInlineGlobalRaw(key, value);
    p.lines.splice(beforeIndex, 0, { raw, kind: "global", depth: 1, globalKey: key, globalValue: value, inlineGlobal: true });
    return { ...p };
  });
}

function formatGlobalRaw(key: string, value: any, inline?: boolean, existingRaw?: string): string {
  if (inline) {
    const indent = (existingRaw ?? "").match(/^(\s*)/)?.[1] ?? INDENT;
    return formatInlineGlobalRawWithIndent(key, value, indent);
  }
  if (typeof value === "boolean") return `${key} = ${value ? "true" : "false"};`;
  if (typeof value === "number") return `${key} = ${value};`;
  if (Array.isArray(value)) return `${key} = [${value.map(formatKvValue).join(", ")}];`;
  return `${key} = "${value}";`;
}

function formatInlineGlobalRaw(key: string, value: any): string {
  return formatInlineGlobalRawWithIndent(key, value, INDENT);
}

function formatInlineGlobalRawWithIndent(key: string, value: any, indent: string): string {
  if (typeof value === "boolean") return `${indent}[ ${key}, ${value} ],`;
  if (typeof value === "number") return `${indent}[ ${key}, ${value} ],`;
  if (Array.isArray(value)) return `${indent}[ ${key}, [${value.map(formatKvValue).join(", ")}] ],`;
  return `${indent}[ ${key}, "${value ?? ""}" ],`;
}

/** Update a kv line's value. If the new value equals the schema default, delete the line. */
export function updateKv(index: number, value: any, schemaDefault?: any) {
  project.update((p) => {
    const line = p.lines[index];
    if (line?.kind !== "kv" || !line.kvKey) return p;

    // If value matches default, dematerialize (delete the line)
    if (schemaDefault !== undefined && JSON.stringify(value) === JSON.stringify(schemaDefault)) {
      p.lines.splice(index, 1);
      return { ...p };
    }

    line.kvValue = value;
    const indent = line.raw.match(/^(\s*)/)?.[1] || "";
    line.raw = `${indent}[ ${line.kvKey}, ${formatKvValue(value)} ],`;
    return { ...p };
  });
}

/**
 * Materialize a virtual default row: insert a real kv line before `beforeIndex`
 * at the given depth.
 */
export function materializeKv(beforeIndex: number, key: string, value: any, depth: number) {
  project.update((p) => {
    const indent = INDENT.repeat(depth);
    const raw = `${indent}[ ${key}, ${formatKvValue(value)} ],`;
    p.lines.splice(beforeIndex, 0, { raw, kind: "kv", depth, kvKey: key, kvValue: value });
    return { ...p };
  });
}

/**
 * Replace a contiguous run of lines [startIndex..startIndex+count) with new lines.
 */
export function spliceLines(startIndex: number, count: number, newLines: Line[]) {
  project.update((p) => {
    p.lines.splice(startIndex, count, ...newLines);
    return { ...p };
  });
}

/** Update a variable line's value expression. */
export function updateVariable(index: number, value: string) {
  project.update((p) => {
    const line = p.lines[index];
    if (line?.kind !== "variable" || !line.varName) return p;
    line.varValue = value;
    const indent = line.raw.match(/^(\s*)/)?.[1] || "";
    const comment = line.comment ? ` // ${line.comment}` : "";
    line.raw = `${indent}${line.varName} = ${value};${comment}`;
    return { ...p };
  });
}

/** Update a line's trailing comment. */
export function updateComment(index: number, comment: string) {
  project.update((p) => {
    const line = p.lines[index];
    if (!line) return p;
    line.comment = comment || undefined;
    // Rebuild raw: strip old comment, append new one
    const stripped = line.raw.replace(/\s*\/\/.*$/, "");
    line.raw = comment ? `${stripped} // ${comment}` : stripped;
    return { ...p };
  });
}

/** Rename a scene: updates open line, matching close line, and any makeall lines referencing the old name. */
export function updateSceneName(openIndex: number, newName: string) {
  project.update((p) => {
    const openLine = p.lines[openIndex];
    if (!openLine || openLine.kind !== "open" || openLine.role !== "data") return p;
    const oldName = openLine.varName || "data";
    if (newName === oldName) return p;

    // Update the open line
    openLine.varName = newName;
    openLine.label = newName;
    openLine.raw = openLine.raw.replace(/^\s*\S+\s*=/, `${newName} =`);

    // Find and update the matching close line
    let depth = 0;
    for (let i = openIndex; i < p.lines.length; i++) {
      if (p.lines[i].kind === "open") depth += p.lines[i].mergedOpen ? 2 : 1;
      if (p.lines[i].kind === "close") {
        depth -= p.lines[i].mergedClose ? 2 : 1;
        if (depth <= 0) {
          p.lines[i].varName = newName;
          p.lines[i].label = newName;
          break;
        }
      }
    }

    // Update any makeall lines that referenced the old name
    for (const line of p.lines) {
      if (line.kind === "makeall" && line.varName === oldName) {
        line.varName = newName;
        line.raw = `Make(${newName});`;
      }
    }

    return { ...p };
  });
}

/**
 * Duplicate a scene: clone the `<varName> = [ ... ];` block and its matching
 * `Make(<varName>);` line, renaming both to `newName`. Inserts the copy right
 * after the original scene's makeall (if present) — otherwise after the close.
 */
export function duplicateScene(openIdx: number, newName: string) {
  project.update((p) => {
    const line = p.lines[openIdx];
    if (line?.kind !== "open" || line.role !== "data") return p;
    const origVarName = line.varName;

    // Find matching close
    let depth = 0;
    let closeIdx = -1;
    for (let i = openIdx; i < p.lines.length; i++) {
      if (p.lines[i].kind === "open") depth += p.lines[i].mergedOpen ? 2 : 1;
      if (p.lines[i].kind === "close") {
        depth -= p.lines[i].mergedClose ? 2 : 1;
        if (depth <= 0) { closeIdx = i; break; }
      }
    }
    if (closeIdx < 0) return p;

    // Clone the block (open through close), renaming the data wrapper.
    // Strip inline globals (`[ G_TOLERANCE, 0.1 ]` etc., which the importer
    // tagged as kind:"global") — globals are file-scoped, not per-scene; the
    // existing definitions in the source scene already apply file-wide via the
    // virtual globals block. Cloning them produces stray editable global lines
    // that don't belong to any scene.
    const cloned = p.lines.slice(openIdx, closeIdx + 1)
      .filter((l) => l.kind !== "global")
      .map((l) => {
        const c = { ...l } as Line;
        if (c.varName === origVarName) {
          c.varName = newName;
          c.label = newName;
          if (c.kind === "open") {
            c.raw = c.raw.replace(new RegExp(`^${origVarName}(\\s*=)`), `${newName}$1`);
          }
        }
        return c;
      });

    // Insert the cloned data block right after its original close. The single
    // Make(...) line in the file is shared across all scenes (UI dropdown
    // selects which scene is rendered) — never clone it.
    p.lines.splice(closeIdx + 1, 0, ...cloned);
    return { ...p };
  });
}

/** Insert a new empty scene (open + close only) after the given line index.
 * The file keeps a single Make(...) line shared across all scenes; it is not
 * duplicated per scene. */
export function addScene(afterIndex: number, sceneName: string) {
  project.update((p) => {
    const lines: Line[] = [
      { raw: `${sceneName} = [`, kind: "open", depth: 0, role: "data", label: sceneName, varName: sceneName },
      { raw: "];", kind: "close", depth: 0, role: "data", label: sceneName, varName: sceneName },
    ];
    p.lines.splice(afterIndex + 1, 0, ...lines);
    return { ...p };
  });
}

export function formatKvValue(value: any): string {
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    // ALL_UPPERCASE identifiers (OpenSCAD constants like SQUARE, BOX, etc.) → unquoted
    if (/^[A-Z][A-Z0-9_]*$/.test(value)) return value;
    // $-prefixed OpenSCAD special variables → unquoted
    if (/^\$[a-zA-Z_]\w*$/.test(value)) return value;
    // Known constants from parsed presets → unquoted
    if (knownConstants.has(value)) return value;
    return `"${value}"`;
  }
  if (Array.isArray(value)) {
    return `[${value.map(formatKvValue).join(", ")}]`;
  }
  return String(value);
}
