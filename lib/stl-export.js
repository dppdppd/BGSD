const path = require("path");
const { importScad } = require("../importer");

function printGroupValues(value) {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => printGroupValues(entry));
  }
  return [];
}

function collectPrintGroups(scadText) {
  const groups = new Set();
  const project = importScad(scadText || "");
  for (const line of project.lines || []) {
    if (line.kind === "kv" && line.kvKey === "PRINT_GROUP") {
      for (const value of printGroupValues(line.kvValue)) groups.add(value);
    }
  }

  return [...groups].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function findMakeVarName(scadText) {
  const project = importScad(scadText || "");
  const makeLine = (project.lines || []).find((line) => line.kind === "makeall" && line.varName);
  if (makeLine?.varName) return makeLine.varName;

  const match = String(scadText || "").match(/^\s*Make\s*\(\s*([A-Za-z_]\w*)\b[\s\S]*?\)\s*;\s*(?:\/\/.*)?$/m);
  return match?.[1] || null;
}

function selectorLiteral(group) {
  if (group === false) return "false";
  return JSON.stringify(String(group));
}

function scadWithPrintGroup(scadText, group) {
  const varName = findMakeVarName(scadText);
  if (!varName) throw new Error("No Make(data) call found in SCAD file.");

  const makeRe = /^([ \t]*)Make\s*\(\s*([A-Za-z_]\w*)\s*(?:,[^)]*)?\)\s*;\s*(\/\/.*)?$/m;
  if (!makeRe.test(scadText)) throw new Error("No supported Make(data) call found in SCAD file.");

  return String(scadText).replace(makeRe, (_match, indent, makeVarName, comment) => {
    const suffix = comment ? ` ${comment}` : "";
    return `${indent}Make(${makeVarName}, print_group = ${selectorLiteral(group)});${suffix}`;
  });
}

function sanitizeFileSegment(value) {
  const cleaned = String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return (cleaned || "group").slice(0, 80);
}

function uniqueGroupFilePath(targetFilePath, group, usedNames) {
  const dir = path.dirname(targetFilePath);
  const ext = path.extname(targetFilePath) || ".stl";
  const base = path.basename(targetFilePath, ext);
  const groupSegment = sanitizeFileSegment(group);
  let candidate = `${base} - ${groupSegment}${ext}`;
  let i = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${base} - ${groupSegment} ${i}${ext}`;
    i += 1;
  }
  usedNames.add(candidate.toLowerCase());
  return path.join(dir, candidate);
}

function createStlExportPlan({ sourcePath, targetFilePath, scadText, tempToken = "export" }) {
  if (!sourcePath) throw new Error("sourcePath is required.");
  if (!targetFilePath) throw new Error("targetFilePath is required.");

  const groups = collectPrintGroups(scadText);
  const hasPrintGroupSelector = /\bG_PRINT_GROUP\b/.test(scadText || "");
  const shouldUsePrintGroupOverride = groups.length > 0 || hasPrintGroupSelector;
  const sourceDir = path.dirname(sourcePath);
  const sourceBase = path.basename(sourcePath, ".scad");
  const jobs = [];

  if (shouldUsePrintGroupOverride) {
    jobs.push({
      kind: "combined",
      label: "all combined",
      filePath: targetFilePath,
      tempScadPath: path.join(sourceDir, `.${sourceBase}.bgsd-export-${tempToken}-all.scad`),
      scadText: scadWithPrintGroup(scadText, false),
    });
  } else {
    jobs.push({
      kind: "combined",
      label: "all combined",
      filePath: targetFilePath,
      sourcePath,
    });
  }

  const usedNames = new Set([path.basename(targetFilePath).toLowerCase()]);
  for (const group of groups) {
    const slug = sanitizeFileSegment(group);
    jobs.push({
      kind: "group",
      label: group,
      group,
      filePath: uniqueGroupFilePath(targetFilePath, group, usedNames),
      tempScadPath: path.join(sourceDir, `.${sourceBase}.bgsd-export-${tempToken}-${slug}.scad`),
      scadText: scadWithPrintGroup(scadText, group),
    });
  }

  return { groups, jobs };
}

module.exports = {
  collectPrintGroups,
  createStlExportPlan,
  sanitizeFileSegment,
  scadWithPrintGroup,
};
