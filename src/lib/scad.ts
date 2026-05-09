import { formatKvValue, type Project } from "./stores/project";
import { INDENT } from "./config";

export interface GeneratedScad {
  text: string;
  /** 0-based generated SCAD line -> 0-based project line index. */
  sourceMap: (number | null)[];
}

function pushGeneratedLine(out: string[], sourceMap: (number | null)[], text: string, sourceIndex: number | null) {
  const parts = String(text).split("\n");
  for (const part of parts) {
    out.push(part);
    sourceMap.push(sourceIndex);
  }
}

/**
 * Generate SCAD output from line-based project.
 *
 * Recognized lines (include, marker, makeall, global, kv) are regenerated.
 * Structural lines (open, close) and raw lines are emitted verbatim.
 */
export function generateScadWithSourceMap(project: Project): GeneratedScad {
  const out: string[] = [];
  const sourceMap: (number | null)[] = [];

  for (let i = 0; i < project.lines.length; i++) {
    const line = project.lines[i];
    switch (line.kind) {
      case "include":
      case "marker":
        pushGeneratedLine(out, sourceMap, line.raw, i);
        break;
      case "makeall":
        pushGeneratedLine(out, sourceMap, `Make(${line.varName || "data"});`, i);
        break;
      case "modulevar":
        // Emit verbatim: file-scope variable like g_make_filler = 1;
        pushGeneratedLine(out, sourceMap, line.raw, i);
        break;
      case "global": {
        // v4 format: emit as [ G_KEY, value ] inside data array
        const gk = line.globalKey ?? "";
        const indent = (line.raw ?? "").match(/^(\s*)/)?.[1] ?? INDENT;
        if (typeof line.globalValue === "boolean") {
          pushGeneratedLine(out, sourceMap, `${indent}[ ${gk}, ${line.globalValue} ],`, i);
        } else if (typeof line.globalValue === "number") {
          pushGeneratedLine(out, sourceMap, `${indent}[ ${gk}, ${line.globalValue} ],`, i);
        } else if (Array.isArray(line.globalValue)) {
          pushGeneratedLine(out, sourceMap, `${indent}[ ${gk}, [${line.globalValue.map(formatKvValue).join(", ")}] ],`, i);
        } else if (gk) {
          pushGeneratedLine(out, sourceMap, `${indent}[ ${gk}, "${line.globalValue ?? ""}" ],`, i);
        }
        break;
      }
      case "blank":
        pushGeneratedLine(out, sourceMap, "", i);
        break;
      case "variable":
      case "comment":
        pushGeneratedLine(out, sourceMap, line.raw, i);
        break;
      case "kv":
      case "open":
      case "close":
      case "raw":
      default:
        // Emit verbatim — kv lines have their raw regenerated on edit via updateKv().
        pushGeneratedLine(out, sourceMap, line.raw, i);
        break;
    }
  }

  return { text: out.join("\n"), sourceMap };
}

export function generateScad(project: Project): string {
  return generateScadWithSourceMap(project).text;
}
