const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SIDECAR_VERSION = 1;
const DEFAULT_MAX_REVISIONS = 100;
const DEFAULT_AUTOSAVE_COALESCE_MS = 2 * 60 * 1000;
const SIGNIFICANT_AUTO_CHANGE_LINES = 4;
const SIGNIFICANT_AUTO_CHANGE_RATIO = 0.35;

function sidecarPath(filePath) {
  return `${filePath}.undo`;
}

function hashText(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function newRevisionId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return crypto.randomBytes(16).toString("hex");
}

function splitText(text) {
  return String(text ?? "").split("\n");
}

function joinLines(lines) {
  return lines.join("\n");
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function countLabel(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function summarizePatch(patch) {
  const oldCount = patch.oldLines.length;
  const newCount = patch.newLines.length;
  if (oldCount === 0 && newCount === 0) return "No content changes";
  if (oldCount === 0) return `${countLabel(newCount, "line")} added`;
  if (newCount === 0) return `${countLabel(oldCount, "line")} removed`;
  if (oldCount === newCount) return `${countLabel(oldCount, "line")} changed`;
  return `${countLabel(oldCount, "line")} replaced by ${countLabel(newCount, "line")}`;
}

function timestampMs(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function makePatch(oldText, newText) {
  const oldLines = splitText(oldText);
  const newLines = splitText(newText);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start++;
  }

  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (oldEnd >= start && newEnd >= start && oldLines[oldEnd] === newLines[newEnd]) {
    oldEnd--;
    newEnd--;
  }

  return {
    oldStart: start,
    oldLines: oldLines.slice(start, oldEnd + 1),
    newLines: newLines.slice(start, newEnd + 1),
  };
}

function unifiedHeaderCount(count) {
  return count === 1 ? "1" : String(count);
}

function makeUnifiedDiff(patch) {
  const oldStart = patch.oldStart + 1;
  const newStart = patch.oldStart + 1;
  const lines = [
    `@@ -${oldStart},${unifiedHeaderCount(patch.oldLines.length)} +${newStart},${unifiedHeaderCount(patch.newLines.length)} @@`,
  ];
  for (const line of patch.oldLines) lines.push(`-${line}`);
  for (const line of patch.newLines) lines.push(`+${line}`);
  return lines.join("\n");
}

function applyPatch(text, patch) {
  if (!patch || typeof patch.oldStart !== "number" || !Array.isArray(patch.oldLines) || !Array.isArray(patch.newLines)) {
    throw new Error("Invalid undo patch");
  }
  const lines = splitText(text);
  const actual = lines.slice(patch.oldStart, patch.oldStart + patch.oldLines.length);
  if (!arraysEqual(actual, patch.oldLines)) {
    throw new Error("Undo patch does not match source text");
  }
  lines.splice(patch.oldStart, patch.oldLines.length, ...patch.newLines);
  return joinLines(lines);
}

function makeEntry(previousText, nextText, metadata = {}) {
  const patch = makePatch(previousText, nextText);
  const timestamp = metadata.timestamp || nowIso();
  return {
    id: metadata.id || newRevisionId(),
    timestamp,
    previousHash: hashText(previousText),
    nextHash: hashText(nextText),
    diff: makeUnifiedDiff(patch),
    patch,
    label: metadata.label || "",
    pinned: !!metadata.pinned,
    changeSummary: metadata.changeSummary || summarizePatch(patch),
  };
}

function makeBaseRevision(filePath, text, metadata = {}) {
  return {
    id: metadata.id || newRevisionId(),
    timestamp: metadata.timestamp || nowIso(),
    hash: hashText(text),
    label: metadata.label || "",
    pinned: !!metadata.pinned,
    changeSummary: metadata.changeSummary || "Initial saved text",
    text,
  };
}

function createSidecar(filePath, text) {
  const timestamp = nowIso();
  return {
    version: SIDECAR_VERSION,
    sourceFile: path.resolve(filePath),
    createdAt: timestamp,
    updatedAt: timestamp,
    retention: { maxRevisions: DEFAULT_MAX_REVISIONS },
    base: makeBaseRevision(filePath, text, { timestamp }),
    entries: [],
  };
}

function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  fs.renameSync(tmp, filePath);
}

function validateSidecarShape(sidecar) {
  if (!sidecar || typeof sidecar !== "object") throw new Error("Undo sidecar is not an object");
  if (sidecar.version !== SIDECAR_VERSION) throw new Error(`Unsupported undo sidecar version: ${sidecar.version}`);
  if (!sidecar.base || typeof sidecar.base.text !== "string") throw new Error("Undo sidecar has no base text");
  if (sidecar.base.hash !== hashText(sidecar.base.text)) throw new Error("Undo sidecar base hash mismatch");
  if (!Array.isArray(sidecar.entries)) throw new Error("Undo sidecar entries are invalid");
  for (const entry of sidecar.entries) {
    if (!entry || typeof entry !== "object") throw new Error("Undo sidecar entry is invalid");
    if (!entry.id || !entry.previousHash || !entry.nextHash) throw new Error("Undo sidecar entry is missing hashes");
    if (!entry.patch) throw new Error("Undo sidecar entry is missing patch data");
  }
}

function normalizeSidecar(filePath, sidecar) {
  validateSidecarShape(sidecar);
  sidecar.sourceFile = sidecar.sourceFile || path.resolve(filePath);
  sidecar.createdAt = sidecar.createdAt || sidecar.base.timestamp || nowIso();
  sidecar.updatedAt = sidecar.updatedAt || sidecar.createdAt;
  sidecar.retention = sidecar.retention || { maxRevisions: DEFAULT_MAX_REVISIONS };
  sidecar.base.id = sidecar.base.id || newRevisionId();
  sidecar.base.timestamp = sidecar.base.timestamp || sidecar.createdAt;
  sidecar.base.label = sidecar.base.label || "";
  sidecar.base.pinned = !!sidecar.base.pinned;
  sidecar.base.changeSummary = sidecar.base.changeSummary || "Initial saved text";
  for (const entry of sidecar.entries) {
    entry.timestamp = entry.timestamp || sidecar.updatedAt;
    entry.label = entry.label || "";
    entry.pinned = !!entry.pinned;
    entry.diff = entry.diff || makeUnifiedDiff(entry.patch);
    entry.changeSummary = entry.changeSummary || summarizePatch(entry.patch);
  }
  reconstructLatest(sidecar);
  return sidecar;
}

function readSidecar(filePath) {
  const undoPath = sidecarPath(filePath);
  if (!fs.existsSync(undoPath)) return null;
  const raw = fs.readFileSync(undoPath, "utf-8");
  return normalizeSidecar(filePath, JSON.parse(raw));
}

function uniqueBadPath(undoPath) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  let candidate = `${undoPath}.bad-${stamp}`;
  let index = 2;
  while (fs.existsSync(candidate)) candidate = `${undoPath}.bad-${stamp}-${index++}`;
  return candidate;
}

function quarantineSidecar(filePath) {
  const undoPath = sidecarPath(filePath);
  if (!fs.existsSync(undoPath)) return null;
  const badPath = uniqueBadPath(undoPath);
  fs.renameSync(undoPath, badPath);
  return badPath;
}

function writeSidecar(filePath, sidecar) {
  sidecar.updatedAt = nowIso();
  sidecar.sourceFile = path.resolve(filePath);
  writeJsonAtomic(sidecarPath(filePath), sidecar);
}

function initializeSidecar(filePath, text, options = {}) {
  if (!filePath || !/\.scad$/i.test(filePath)) return { ok: true, tracked: false };
  if (!options.reset && fs.existsSync(sidecarPath(filePath))) {
    try {
      return { ok: true, tracked: true, sidecar: readSidecar(filePath), sidecarPath: sidecarPath(filePath), existing: true };
    } catch (err) {
      if (!options.quarantineCorrupt) throw err;
      quarantineSidecar(filePath);
    }
  }
  const sidecar = createSidecar(filePath, text ?? "");
  writeSidecar(filePath, sidecar);
  return { ok: true, tracked: true, sidecar, sidecarPath: sidecarPath(filePath), created: true };
}

function reconstructAll(sidecar) {
  validateSidecarShape(sidecar);
  const records = [
    {
      id: sidecar.base.id,
      timestamp: sidecar.base.timestamp,
      hash: sidecar.base.hash,
      label: sidecar.base.label || "",
      pinned: !!sidecar.base.pinned,
      changeSummary: sidecar.base.changeSummary || "Initial saved text",
      isBase: true,
      text: sidecar.base.text,
    },
  ];
  let text = sidecar.base.text;
  let currentHash = hashText(text);
  if (currentHash !== sidecar.base.hash) throw new Error("Undo sidecar base hash mismatch");

  for (const entry of sidecar.entries) {
    if (currentHash !== entry.previousHash) throw new Error("Undo sidecar patch chain hash mismatch");
    text = applyPatch(text, entry.patch);
    currentHash = hashText(text);
    if (currentHash !== entry.nextHash) throw new Error("Undo sidecar patch output hash mismatch");
    records.push({
      id: entry.id,
      timestamp: entry.timestamp,
      hash: entry.nextHash,
      label: entry.label || "",
      pinned: !!entry.pinned,
      changeSummary: entry.changeSummary || summarizePatch(entry.patch),
      isBase: false,
      text,
    });
  }
  return records;
}

function reconstructLatest(sidecar) {
  const records = reconstructAll(sidecar);
  return records[records.length - 1].text;
}

function loadSidecarForAppend(filePath, initialText) {
  try {
    const sidecar = readSidecar(filePath);
    if (sidecar) return { sidecar, quarantinedPath: null };
  } catch {
    const quarantinedPath = quarantineSidecar(filePath);
    return { sidecar: createSidecar(filePath, initialText ?? ""), quarantinedPath };
  }
  return { sidecar: createSidecar(filePath, initialText ?? ""), quarantinedPath: null };
}

function appendEntry(sidecar, previousText, nextText, metadata = {}) {
  const entry = makeEntry(previousText, nextText, metadata);
  sidecar.entries.push(entry);
  return entry;
}

function changedLineCount(patch) {
  return Math.max(patch.oldLines.length, patch.newLines.length);
}

function isSignificantAutoChange(anchorText, nextText, options = {}) {
  const lineThreshold = Number.isFinite(options.significantLineCount)
    ? Math.max(1, Math.floor(options.significantLineCount))
    : SIGNIFICANT_AUTO_CHANGE_LINES;
  const ratioThreshold = Number.isFinite(options.significantChangeRatio)
    ? Math.max(0, Number(options.significantChangeRatio))
    : SIGNIFICANT_AUTO_CHANGE_RATIO;
  const patch = makePatch(anchorText, nextText);
  const changed = changedLineCount(patch);
  const total = Math.max(splitText(anchorText).length, splitText(nextText).length, 1);
  return changed >= lineThreshold || changed / total >= ratioThreshold;
}

function isProtectedEntry(entry) {
  return !!entry?.pinned || !!String(entry?.label || "").trim();
}

function shouldCoalesceLastEntry(sidecar, records, nextText, metadata = {}, options = {}) {
  if (!options.coalesce || options.forceNewRevision) return false;
  if (sidecar.entries.length === 0 || records.length < 2) return false;

  const lastEntry = sidecar.entries[sidecar.entries.length - 1];
  if (isProtectedEntry(lastEntry)) return false;
  if (lastEntry.changeSummary === "File changed outside saved history") return false;

  const windowMs = Number.isFinite(options.coalesceWindowMs)
    ? Math.max(0, Number(options.coalesceWindowMs))
    : DEFAULT_AUTOSAVE_COALESCE_MS;
  if (windowMs === 0) return false;

  const nextTimestamp = metadata.timestamp || nowIso();
  const lastMs = timestampMs(lastEntry.timestamp);
  const nextMs = timestampMs(nextTimestamp);
  if (lastMs === null || nextMs === null || nextMs < lastMs) return false;
  if (nextMs - lastMs >= windowMs) return false;

  const anchorText = records[records.length - 2].text;
  return !isSignificantAutoChange(anchorText, nextText, options);
}

function coalesceLastEntry(sidecar, records, nextText, metadata = {}) {
  const lastEntry = sidecar.entries[sidecar.entries.length - 1];
  const anchorText = records[records.length - 2].text;
  const replacement = makeEntry(anchorText, nextText, {
    ...metadata,
    id: lastEntry.id,
    label: lastEntry.label,
    pinned: lastEntry.pinned,
  });
  sidecar.entries[sidecar.entries.length - 1] = replacement;
  return replacement;
}

function pruneLoadedSidecar(sidecar, keepCount = DEFAULT_MAX_REVISIONS) {
  const count = Math.max(1, Number.isFinite(keepCount) ? Math.floor(keepCount) : DEFAULT_MAX_REVISIONS);
  const records = reconstructAll(sidecar);
  if (records.length <= count) return { sidecar, pruned: false, removed: 0 };

  const keepIds = new Set();
  const recent = records.slice(-count);
  for (const record of recent) keepIds.add(record.id);
  for (const record of records) {
    if (record.pinned) keepIds.add(record.id);
  }
  keepIds.add(records[records.length - 1].id);

  const kept = records.filter((record) => keepIds.has(record.id));
  const first = kept[0];
  const newSidecar = {
    version: sidecar.version,
    sourceFile: sidecar.sourceFile,
    createdAt: sidecar.createdAt,
    updatedAt: nowIso(),
    retention: sidecar.retention || { maxRevisions: DEFAULT_MAX_REVISIONS },
    base: makeBaseRevision(sidecar.sourceFile || "", first.text, {
      id: first.id,
      timestamp: first.timestamp,
      label: first.label,
      pinned: first.pinned,
      changeSummary: first.changeSummary,
    }),
    entries: [],
  };

  let previousText = first.text;
  for (let i = 1; i < kept.length; i++) {
    const record = kept[i];
    const entry = makeEntry(previousText, record.text, {
      id: record.id,
      timestamp: record.timestamp,
      label: record.label,
      pinned: record.pinned,
    });
    newSidecar.entries.push(entry);
    previousText = record.text;
  }

  return { sidecar: newSidecar, pruned: true, removed: records.length - kept.length };
}

function recordSavedRevision(filePath, previousText, nextText, options = {}) {
  if (!filePath || !/\.scad$/i.test(filePath)) return { ok: true, tracked: false };
  const next = String(nextText ?? "");
  const previous = previousText === null || previousText === undefined ? null : String(previousText);

  if (previous === null) {
    return initializeSidecar(filePath, next, { quarantineCorrupt: true, reset: options.reset });
  }

  const previousHash = hashText(previous);
  const nextHash = hashText(next);
  const entryMetadata = { ...(options.entryMetadata || {}) };
  entryMetadata.timestamp = entryMetadata.timestamp || nowIso();
  if (options.forceNewRevision && !Object.prototype.hasOwnProperty.call(entryMetadata, "pinned")) {
    entryMetadata.pinned = true;
  }
  if (previousHash === nextHash) {
    if (options.forceNewRevision) {
      const loaded = loadSidecarForAppend(filePath, next);
      let { sidecar } = loaded;
      let latestText;
      try {
        latestText = reconstructLatest(sidecar);
      } catch {
        const quarantinedPath = quarantineSidecar(filePath);
        sidecar = createSidecar(filePath, next);
        latestText = next;
        loaded.quarantinedPath = quarantinedPath;
      }
      if (hashText(latestText) !== nextHash) {
        appendEntry(sidecar, latestText, next, {
          timestamp: entryMetadata.timestamp,
          label: "External file state",
          changeSummary: "File changed outside saved history",
        });
      }
      const entry = appendEntry(sidecar, next, next, {
        ...entryMetadata,
        changeSummary: entryMetadata.changeSummary || "Manual checkpoint",
      });
      const keepCount = options.keepCount || sidecar.retention?.maxRevisions || DEFAULT_MAX_REVISIONS;
      const pruned = pruneLoadedSidecar(sidecar, keepCount);
      sidecar = pruned.sidecar;
      writeSidecar(filePath, sidecar);
      return {
        ok: true,
        tracked: true,
        sidecarPath: sidecarPath(filePath),
        revisionId: entry.id,
        forced: true,
        noOp: true,
        quarantinedPath: loaded.quarantinedPath || null,
        pruned: pruned.pruned,
        removed: pruned.removed,
      };
    }
    const initialized = initializeSidecar(filePath, next, { quarantineCorrupt: true, reset: false });
    return { ...initialized, noOp: true };
  }

  const loaded = loadSidecarForAppend(filePath, previous);
  let { sidecar } = loaded;
  let records;
  let latestText;
  try {
    records = reconstructAll(sidecar);
    latestText = records[records.length - 1].text;
  } catch {
    const quarantinedPath = quarantineSidecar(filePath);
    sidecar = createSidecar(filePath, previous);
    records = reconstructAll(sidecar);
    latestText = previous;
    loaded.quarantinedPath = quarantinedPath;
  }

  let externalStateRecorded = false;
  if (hashText(latestText) !== previousHash) {
    appendEntry(sidecar, latestText, previous, {
      timestamp: entryMetadata.timestamp,
      label: "External file state",
      changeSummary: "File changed outside saved history",
    });
    records = reconstructAll(sidecar);
    externalStateRecorded = true;
  }
  if (!externalStateRecorded && shouldCoalesceLastEntry(sidecar, records, next, entryMetadata, options)) {
    const entry = coalesceLastEntry(sidecar, records, next, entryMetadata);
    const keepCount = options.keepCount || sidecar.retention?.maxRevisions || DEFAULT_MAX_REVISIONS;
    const pruned = pruneLoadedSidecar(sidecar, keepCount);
    sidecar = pruned.sidecar;
    writeSidecar(filePath, sidecar);

    return {
      ok: true,
      tracked: true,
      sidecarPath: sidecarPath(filePath),
      revisionId: entry.id,
      coalesced: true,
      quarantinedPath: loaded.quarantinedPath || null,
      pruned: pruned.pruned,
      removed: pruned.removed,
    };
  }
  const entry = appendEntry(sidecar, previous, next, entryMetadata);
  const keepCount = options.keepCount || sidecar.retention?.maxRevisions || DEFAULT_MAX_REVISIONS;
  const pruned = pruneLoadedSidecar(sidecar, keepCount);
  sidecar = pruned.sidecar;
  writeSidecar(filePath, sidecar);

  return {
    ok: true,
    tracked: true,
    sidecarPath: sidecarPath(filePath),
    revisionId: entry.id,
    quarantinedPath: loaded.quarantinedPath || null,
    pruned: pruned.pruned,
    removed: pruned.removed,
  };
}

function revisionListFromSidecar(sidecar) {
  const records = reconstructAll(sidecar);
  return records
    .map((record, index) => ({
      id: record.id,
      timestamp: record.timestamp,
      hash: record.hash,
      hashPrefix: record.hash.slice(0, 10),
      label: record.label || "",
      pinned: !!record.pinned,
      changeSummary: record.changeSummary || "",
      isBase: record.isBase,
      index,
    }))
    .reverse();
}

function listHistory(filePath) {
  try {
    const sidecar = readSidecar(filePath);
    if (!sidecar) return { ok: true, sidecarPath: sidecarPath(filePath), revisions: [] };
    return { ok: true, sidecarPath: sidecarPath(filePath), revisions: revisionListFromSidecar(sidecar) };
  } catch (err) {
    return { ok: false, sidecarPath: sidecarPath(filePath), corrupt: true, error: err.message, revisions: [] };
  }
}

function loadRevision(filePath, revisionId) {
  try {
    const sidecar = readSidecar(filePath);
    if (!sidecar) return { ok: false, error: "No undo history sidecar found" };
    const records = reconstructAll(sidecar);
    const record = records.find((candidate) => candidate.id === revisionId);
    if (!record) return { ok: false, error: "Revision not found" };
    return {
      ok: true,
      scadText: record.text,
      revision: {
        id: record.id,
        timestamp: record.timestamp,
        hash: record.hash,
        hashPrefix: record.hash.slice(0, 10),
        label: record.label || "",
        pinned: !!record.pinned,
        changeSummary: record.changeSummary || "",
        isBase: record.isBase,
      },
    };
  } catch (err) {
    return { ok: false, corrupt: true, error: err.message };
  }
}

function updateRevisionMetadata(filePath, revisionId, updates) {
  try {
    const sidecar = readSidecar(filePath);
    if (!sidecar) return { ok: false, error: "No undo history sidecar found" };
    let target = null;
    if (sidecar.base.id === revisionId) {
      target = sidecar.base;
    } else {
      target = sidecar.entries.find((entry) => entry.id === revisionId);
    }
    if (!target) return { ok: false, error: "Revision not found" };
    if (Object.prototype.hasOwnProperty.call(updates, "label")) {
      target.label = String(updates.label || "").trim().slice(0, 120);
    }
    if (Object.prototype.hasOwnProperty.call(updates, "pinned")) {
      target.pinned = !!updates.pinned;
    }
    writeSidecar(filePath, sidecar);
    return { ok: true, revisions: revisionListFromSidecar(sidecar) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function labelRevision(filePath, revisionId, label) {
  return updateRevisionMetadata(filePath, revisionId, { label });
}

function pinRevision(filePath, revisionId, pinned) {
  return updateRevisionMetadata(filePath, revisionId, { pinned });
}

function pruneHistory(filePath, keepCount = DEFAULT_MAX_REVISIONS) {
  try {
    const sidecar = readSidecar(filePath);
    if (!sidecar) return { ok: true, sidecarPath: sidecarPath(filePath), revisions: [], pruned: false, removed: 0 };
    const result = pruneLoadedSidecar(sidecar, keepCount);
    if (result.pruned) writeSidecar(filePath, result.sidecar);
    return {
      ok: true,
      sidecarPath: sidecarPath(filePath),
      revisions: revisionListFromSidecar(result.sidecar),
      pruned: result.pruned,
      removed: result.removed,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function renameSidecar(oldFilePath, newFilePath) {
  const oldUndoPath = sidecarPath(oldFilePath);
  const newUndoPath = sidecarPath(newFilePath);
  if (!fs.existsSync(oldUndoPath)) return;
  fs.renameSync(oldUndoPath, newUndoPath);
  try {
    const sidecar = readSidecar(newFilePath);
    writeSidecar(newFilePath, sidecar);
  } catch {
    // Leave the renamed sidecar in place; later saves will quarantine if needed.
  }
}

function deleteSidecar(filePath) {
  const undoPath = sidecarPath(filePath);
  if (fs.existsSync(undoPath)) fs.unlinkSync(undoPath);
}

module.exports = {
  SIDECAR_VERSION,
  DEFAULT_MAX_REVISIONS,
  DEFAULT_AUTOSAVE_COALESCE_MS,
  sidecarPath,
  hashText,
  makePatch,
  applyPatch,
  makeUnifiedDiff,
  summarizePatch,
  isSignificantAutoChange,
  createSidecar,
  initializeSidecar,
  recordSavedRevision,
  readSidecar,
  reconstructAll,
  reconstructLatest,
  listHistory,
  loadRevision,
  labelRevision,
  pinRevision,
  pruneHistory,
  renameSidecar,
  deleteSidecar,
};
