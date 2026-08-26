import type { Line } from "./stores/project";

export type CtdInheritedValue = {
  value: any;
  source: "Global Overrides" | "Tray" | null;
};

function bracketWeight(line: Line): number {
  return line.mergedOpen || line.mergedClose ? 2 : 1;
}

function findMatchingClose(lines: Line[], openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < lines.length; i++) {
    const line = lines[i];
    if (line.kind === "open") depth += bracketWeight(line);
    if (line.kind === "close") {
      depth -= bracketWeight(line);
      if (depth <= 0) return i;
    }
  }
  return -1;
}

function findParentOpen(lines: Line[], lineIndex: number): number {
  let depth = 0;
  for (let i = lineIndex - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.kind === "close") depth += bracketWeight(line);
    if (line.kind === "open") {
      depth -= bracketWeight(line);
      if (depth < 0) return i;
    }
  }
  return -1;
}

function directValue(lines: Line[], openIndex: number, key: string): { found: boolean; value?: any } {
  const closeIndex = findMatchingClose(lines, openIndex);
  if (closeIndex < 0) return { found: false };

  // Match BGSD's row model: a block's scalar children sit one level below
  // its closing line. Restricting the lookup to that depth prevents a
  // counter-set value from being mistaken for a tray or scene override.
  const childDepth = (lines[closeIndex].depth ?? 0) + 1;
  for (let i = openIndex + 1; i < closeIndex; i++) {
    const line = lines[i];
    if (line.kind === "kv" && line.depth === childDepth && line.kvKey === key) {
      return { found: true, value: line.kvValue };
    }
  }
  return { found: false };
}

/**
 * CTD builds an effective tray by putting tray entries before scene globals;
 * its first-match lookup therefore gives a tray override precedence. Counter
 * sets repeat that pattern: an explicit set value wins, then the containing
 * tray value, then the scene global, and finally the library default.
 *
 * This function resolves only the inherited fallback for a row in openIndex;
 * the caller still gives any explicit value in that row's own block priority.
 */
export function resolveCtdInheritedValue(
  lines: Line[],
  openIndex: number,
  key: string,
  schemaDefault: any,
): CtdInheritedValue {
  let parentIndex = findParentOpen(lines, openIndex);
  while (parentIndex >= 0) {
    const parent = lines[parentIndex];
    if (parent.role === "object" && parent.label === "TRAY") {
      const trayValue = directValue(lines, parentIndex, key);
      if (trayValue.found) return { value: trayValue.value, source: "Tray" };
    }
    if (parent.role === "data") {
      const globalValue = directValue(lines, parentIndex, key);
      if (globalValue.found) return { value: globalValue.value, source: "Global Overrides" };
      break;
    }
    parentIndex = findParentOpen(lines, parentIndex);
  }
  return { value: schemaDefault, source: null };
}
