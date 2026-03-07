// Constants parser — reads .scad files with @preset annotations.
//
// parseConstantsFile(filePath) → [{ name, value, field, label }]
// Recursively follows `include <...>` directives relative to the same directory.
//
// Supports multiple @preset annotations per line:
//   half_inch = 13.3; // @preset COUNTER_SIZE_X "1/2\"" @preset COUNTER_SIZE_Y "1/2\""

const fs = require("fs");
const path = require("path");

const ASSIGN_RE = /^(\w+)\s*=\s*(.+?)\s*;\s*\/\//;
const PRESET_TAG_RE = /@preset\s+(\w+)\s+"((?:[^"\\]|\\.)*)"/g;
const INCLUDE_RE = /^\s*include\s*<\s*(.+?)\s*>\s*;?\s*$/;

/**
 * Parse a .scad constants file for @preset annotations.
 * Recursively follows include directives.
 * @param {string} filePath - Absolute path to the .scad file
 * @param {Set<string>} [visited] - Already-visited files (cycle prevention)
 * @returns {{ name: string, value: string, field: string, label: string }[]}
 */
function parseConstantsFile(filePath, visited) {
  if (!visited) visited = new Set();
  const resolved = path.resolve(filePath);
  if (visited.has(resolved)) return [];
  visited.add(resolved);

  let content;
  try {
    content = fs.readFileSync(resolved, "utf-8");
  } catch (_) {
    return [];
  }

  const dir = path.dirname(resolved);
  const results = [];

  for (const line of content.split("\n")) {
    // Follow includes
    const incMatch = line.match(INCLUDE_RE);
    if (incMatch) {
      const incPath = path.join(dir, incMatch[1].trim());
      results.push(...parseConstantsFile(incPath, visited));
      continue;
    }

    // Check for assignment + comment with @preset tags
    const assignMatch = line.match(ASSIGN_RE);
    if (!assignMatch) continue;

    const varName = assignMatch[1];
    const varValue = assignMatch[2].trim();

    // Find all @preset tags in the comment portion
    let m;
    PRESET_TAG_RE.lastIndex = 0;
    while ((m = PRESET_TAG_RE.exec(line)) !== null) {
      results.push({
        name: varName,
        value: varValue,
        field: m[1],
        label: m[2].replace(/\\(.)/g, "$1"),
      });
    }
  }

  return results;
}

module.exports = { parseConstantsFile };
