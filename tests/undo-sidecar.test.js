import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "module";
import { importScad } from "../importer.js";
import fs from "fs";
import os from "os";
import path from "path";

const require = createRequire(import.meta.url);
const undoSidecar = require("../lib/undo-sidecar.js");

let tempDir;

function scadWithName(name) {
  return `// BGSD
include <boardgame_insert_toolkit_lib.4.scad>;
data = [
    [ OBJECT_BOX, [
        [ NAME, "${name}" ],
        [ BOX_SIZE_XYZ, [50, 50, 20] ],
    ]],
];
Make(data);`;
}

function write(filePath, text) {
  fs.writeFileSync(filePath, text, "utf-8");
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bgsd-undo-test-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("undo sidecar", () => {
  it("appends diffs and replays exact saved revisions", () => {
    const filePath = path.join(tempDir, "design.scad");
    const v1 = scadWithName("box 1");
    const v2 = scadWithName("box 2");
    const v3 = scadWithName("box 3");

    write(filePath, v1);
    undoSidecar.recordSavedRevision(filePath, null, v1);
    write(filePath, v2);
    undoSidecar.recordSavedRevision(filePath, v1, v2);
    write(filePath, v3);
    undoSidecar.recordSavedRevision(filePath, v2, v3);

    const list = undoSidecar.listHistory(filePath);
    expect(list.ok).toBe(true);
    expect(list.revisions).toHaveLength(3);
    expect(list.revisions[0].hash).toBe(undoSidecar.hashText(v3));

    const oldest = list.revisions[2];
    const loaded = undoSidecar.loadRevision(filePath, oldest.id);
    expect(loaded.ok).toBe(true);
    expect(loaded.scadText).toBe(v1);
  });

  it("does not append an entry for no-op saves", () => {
    const filePath = path.join(tempDir, "design.scad");
    const v1 = scadWithName("box 1");
    const v2 = scadWithName("box 2");

    write(filePath, v1);
    undoSidecar.recordSavedRevision(filePath, null, v1);
    write(filePath, v2);
    undoSidecar.recordSavedRevision(filePath, v1, v2);
    undoSidecar.recordSavedRevision(filePath, v2, v2);

    const sidecar = undoSidecar.readSidecar(filePath);
    expect(sidecar.entries).toHaveLength(1);
  });

  it("coalesces rapid autosaves into the latest unlabeled revision", () => {
    const filePath = path.join(tempDir, "design.scad");
    const v1 = scadWithName("box 1");
    const v2 = scadWithName("box 2");
    const v3 = scadWithName("box 3");

    write(filePath, v1);
    undoSidecar.recordSavedRevision(filePath, null, v1);
    write(filePath, v2);
    undoSidecar.recordSavedRevision(filePath, v1, v2, {
      coalesce: true,
      coalesceWindowMs: 120000,
      entryMetadata: { timestamp: "2026-05-03T12:00:00.000Z" },
    });
    write(filePath, v3);
    undoSidecar.recordSavedRevision(filePath, v2, v3, {
      coalesce: true,
      coalesceWindowMs: 120000,
      entryMetadata: { timestamp: "2026-05-03T12:01:00.000Z" },
    });

    const sidecar = undoSidecar.readSidecar(filePath);
    const list = undoSidecar.listHistory(filePath);

    expect(sidecar.entries).toHaveLength(1);
    expect(sidecar.entries[0].timestamp).toBe("2026-05-03T12:01:00.000Z");
    expect(list.revisions).toHaveLength(2);
    expect(list.revisions.some((revision) => revision.hash === undoSidecar.hashText(v2))).toBe(false);
    expect(undoSidecar.loadRevision(filePath, list.revisions[0].id).scadText).toBe(v3);
  });

  it("forces a manual checkpoint even when autosave already wrote the same text", () => {
    const filePath = path.join(tempDir, "design.scad");
    const v1 = scadWithName("box 1");

    write(filePath, v1);
    undoSidecar.recordSavedRevision(filePath, null, v1);
    undoSidecar.recordSavedRevision(filePath, v1, v1, {
      forceNewRevision: true,
      entryMetadata: { timestamp: "2026-05-03T12:00:00.000Z" },
    });

    const sidecar = undoSidecar.readSidecar(filePath);
    const list = undoSidecar.listHistory(filePath);

    expect(sidecar.entries).toHaveLength(1);
    expect(sidecar.entries[0].previousHash).toBe(sidecar.entries[0].nextHash);
    expect(sidecar.entries[0].pinned).toBe(true);
    expect(list.revisions).toHaveLength(2);
    expect(list.revisions[0].changeSummary).toBe("Manual checkpoint");
    expect(list.revisions[0].pinned).toBe(true);
    expect(undoSidecar.loadRevision(filePath, list.revisions[0].id).scadText).toBe(v1);
  });

  it("pins manual checkpoints with content changes", () => {
    const filePath = path.join(tempDir, "design.scad");
    const v1 = scadWithName("box 1");
    const v2 = scadWithName("box 2");

    write(filePath, v1);
    undoSidecar.recordSavedRevision(filePath, null, v1);
    write(filePath, v2);
    undoSidecar.recordSavedRevision(filePath, v1, v2, {
      forceNewRevision: true,
      entryMetadata: { timestamp: "2026-05-03T12:00:00.000Z" },
    });

    const sidecar = undoSidecar.readSidecar(filePath);
    const list = undoSidecar.listHistory(filePath);

    expect(sidecar.entries).toHaveLength(1);
    expect(sidecar.entries[0].pinned).toBe(true);
    expect(list.revisions[0].pinned).toBe(true);
    expect(undoSidecar.loadRevision(filePath, list.revisions[0].id).scadText).toBe(v2);
  });

  it("starts a new autosave revision after a quiet gap", () => {
    const filePath = path.join(tempDir, "design.scad");
    const v1 = scadWithName("box 1");
    const v2 = scadWithName("box 2");
    const v3 = scadWithName("box 3");

    write(filePath, v1);
    undoSidecar.recordSavedRevision(filePath, null, v1);
    write(filePath, v2);
    undoSidecar.recordSavedRevision(filePath, v1, v2, {
      coalesce: true,
      coalesceWindowMs: 120000,
      entryMetadata: { timestamp: "2026-05-03T12:00:00.000Z" },
    });
    write(filePath, v3);
    undoSidecar.recordSavedRevision(filePath, v2, v3, {
      coalesce: true,
      coalesceWindowMs: 120000,
      entryMetadata: { timestamp: "2026-05-03T12:03:00.000Z" },
    });

    const sidecar = undoSidecar.readSidecar(filePath);
    expect(sidecar.entries).toHaveLength(2);
    expect(undoSidecar.listHistory(filePath).revisions).toHaveLength(3);
  });

  it("does not coalesce pinned autosave revisions", () => {
    const filePath = path.join(tempDir, "design.scad");
    const v1 = scadWithName("box 1");
    const v2 = scadWithName("box 2");
    const v3 = scadWithName("box 3");

    write(filePath, v1);
    undoSidecar.recordSavedRevision(filePath, null, v1);
    write(filePath, v2);
    undoSidecar.recordSavedRevision(filePath, v1, v2, {
      coalesce: true,
      coalesceWindowMs: 120000,
      entryMetadata: { timestamp: "2026-05-03T12:00:00.000Z" },
    });
    const pinned = undoSidecar.listHistory(filePath).revisions[0];
    undoSidecar.pinRevision(filePath, pinned.id, true);
    write(filePath, v3);
    undoSidecar.recordSavedRevision(filePath, v2, v3, {
      coalesce: true,
      coalesceWindowMs: 120000,
      entryMetadata: { timestamp: "2026-05-03T12:01:00.000Z" },
    });

    const sidecar = undoSidecar.readSidecar(filePath);
    expect(sidecar.entries).toHaveLength(2);
    expect(undoSidecar.loadRevision(filePath, pinned.id).scadText).toBe(v2);
  });

  it("quarantines corrupt sidecars without blocking a saved revision", () => {
    const filePath = path.join(tempDir, "design.scad");
    const v1 = scadWithName("box 1");
    const v2 = scadWithName("box 2");

    write(filePath, v1);
    write(undoSidecar.sidecarPath(filePath), "{not json", "utf-8");
    write(filePath, v2);
    const result = undoSidecar.recordSavedRevision(filePath, v1, v2);

    expect(result.ok).toBe(true);
    expect(result.quarantinedPath).toBeTruthy();
    expect(fs.existsSync(result.quarantinedPath)).toBe(true);
    const latest = undoSidecar.listHistory(filePath).revisions[0];
    expect(undoSidecar.loadRevision(filePath, latest.id).scadText).toBe(v2);
  });

  it("persists labels and pins without changing revision text", () => {
    const filePath = path.join(tempDir, "design.scad");
    const v1 = scadWithName("box 1");
    const v2 = scadWithName("box 2");

    write(filePath, v1);
    undoSidecar.recordSavedRevision(filePath, null, v1);
    write(filePath, v2);
    undoSidecar.recordSavedRevision(filePath, v1, v2);

    const target = undoSidecar.listHistory(filePath).revisions[0];
    expect(undoSidecar.labelRevision(filePath, target.id, "printed v1").ok).toBe(true);
    expect(undoSidecar.pinRevision(filePath, target.id, true).ok).toBe(true);

    const updated = undoSidecar.listHistory(filePath).revisions[0];
    expect(updated.label).toBe("printed v1");
    expect(updated.pinned).toBe(true);
    expect(undoSidecar.loadRevision(filePath, updated.id).scadText).toBe(v2);
  });

  it("prunes unpinned revisions while protecting pinned revisions", () => {
    const filePath = path.join(tempDir, "design.scad");
    const versions = Array.from({ length: 6 }, (_, i) => scadWithName(`box ${i + 1}`));

    write(filePath, versions[0]);
    undoSidecar.recordSavedRevision(filePath, null, versions[0]);
    for (let i = 1; i < versions.length; i++) {
      write(filePath, versions[i]);
      undoSidecar.recordSavedRevision(filePath, versions[i - 1], versions[i]);
    }

    const before = undoSidecar.listHistory(filePath).revisions;
    const pinnedOld = before.find((revision) => revision.hash === undoSidecar.hashText(versions[1]));
    expect(pinnedOld).toBeTruthy();
    undoSidecar.pinRevision(filePath, pinnedOld.id, true);

    const pruned = undoSidecar.pruneHistory(filePath, 3);
    expect(pruned.ok).toBe(true);
    expect(pruned.revisions.some((revision) => revision.id === pinnedOld.id)).toBe(true);
    expect(pruned.revisions[0].hash).toBe(undoSidecar.hashText(versions[5]));
    expect(undoSidecar.loadRevision(filePath, pinnedOld.id).scadText).toBe(versions[1]);
    expect(undoSidecar.loadRevision(filePath, pruned.revisions[0].id).scadText).toBe(versions[5]);
  });

  it("restored sidecar text imports through the SCAD importer", () => {
    const filePath = path.join(tempDir, "design.scad");
    const v1 = scadWithName("box 1");
    const v2 = scadWithName("box 2");

    write(filePath, v1);
    undoSidecar.recordSavedRevision(filePath, null, v1);
    write(filePath, v2);
    undoSidecar.recordSavedRevision(filePath, v1, v2);

    const oldest = undoSidecar.listHistory(filePath).revisions[1];
    const loaded = undoSidecar.loadRevision(filePath, oldest.id);
    const project = importScad(loaded.scadText);
    const name = project.lines.find((line) => line.kind === "kv" && line.kvKey === "NAME");

    expect(name.kvValue).toBe("box 1");
  });
});
