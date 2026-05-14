import { describe, it, expect } from "vitest";
import { importScad } from "../importer.js";
import fs from "fs";
import path from "path";

const FIXTURES = path.join(__dirname);

function loadFixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), "utf-8");
}

function normalizeNewlines(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

describe("importScad", () => {
  it("parses a minimal BIT file", () => {
    const scad = `// BGSD
include <boardgame_insert_toolkit_lib.4.scad>;
data = [
    [ OBJECT_BOX, [
        [ NAME, "box 1" ],
        [ BOX_SIZE_XYZ, [50, 50, 20] ],
    ]],
];
Make(data);`;
    const project = importScad(scad);
    expect(project.lines.length).toBeGreaterThan(0);
    expect(project.hasMarker).toBe(true);
    expect(project.libraryProfile).toBe("bit");
  });

  it("detects CTD profile from include", () => {
    const scad = loadFixture("design.scad");
    const project = importScad(scad);
    expect(project.libraryProfile).toBe("ctd");
  });

  it("classifies marker lines", () => {
    const project = importScad("// BGSD\ninclude <boardgame_insert_toolkit_lib.4.scad>;\ndata = [\n];\nMake(data);");
    const marker = project.lines.find((l) => l.kind === "marker");
    expect(marker).toBeTruthy();
    expect(marker.raw).toBe("// BGSD");
  });

  it("classifies include lines", () => {
    const project = importScad("// BGSD\ninclude <boardgame_insert_toolkit_lib.4.scad>;\ndata = [\n];\nMake(data);");
    const inc = project.lines.find((l) => l.kind === "include");
    expect(inc).toBeTruthy();
    expect(inc.includeFile).toContain("boardgame_insert_toolkit_lib");
  });

  it("detects BIT profile from versioned library filenames", () => {
    const project = importScad("// BGSD\ninclude <../lib/boardgame_insert_toolkit_lib.4.2.0.scad>;\ndata = [\n];\nMake(data);");
    expect(project.libraryProfile).toBe("bit");
    expect(project.libraryInclude).toBe("../lib/boardgame_insert_toolkit_lib.4.2.0.scad");
  });

  it("parses BIT 4.3.0 generated divider layout feature blocks", () => {
    const scad = `// BGSD
include <../lib/boardgame_insert_toolkit_lib.4.3.0.scad>;
data = [
    [ OBJECT_BOX, [
        [ NAME, "box 1" ],
        [ BOX_FEATURE,
            [ FTR_COMPARTMENT_SIZE_XYZ, [40, 40, 15] ],
            [ FTR_DIVIDERS,
                [ DIV_LAYOUT_BAYS, 3 ],
                [ DIV_LAYOUT_BAY_SIZE, 0 ],
                [ DIV_AXIS, Y ],
                [ DIV_RAIL_SIZE_XYZ, [1, 1.5, 15] ],
                [ DIV_NO_RAILS_B, false ],
            ],
        ],
    ]],
];
Make(data);`;
    const project = importScad(scad);
    expect(project.libraryProfile).toBe("bit");
    expect(project.lines.some((l) => l.kind === "open" && l.role === "feature_dividers")).toBe(true);
    expect(project.lines.some((l) => l.kind === "close" && l.role === "feature_dividers")).toBe(true);
    expect(project.lines.find((l) => l.kind === "kv" && l.kvKey === "DIV_AXIS")?.kvValue).toBe("Y");
    expect(project.lines.find((l) => l.kind === "kv" && l.kvKey === "DIV_LAYOUT_BAYS")?.kvValue).toBe(3);
    expect(project.lines.find((l) => l.kind === "kv" && l.kvKey === "DIV_RAIL_SIZE_XYZ")?.kvValue).toEqual([1, 1.5, 15]);
  });

  it("parses BIT 4.9.0 feature groups, copies, print groups, and nested child features", () => {
    const scad = `// BGSD
include <../lib/boardgame_insert_toolkit_lib.4.9.0.scad>;
data = [
    [ OBJECT_BOX, [
        [ NAME, "box 1" ],
        [ PRINT_GROUP, "red" ],
        [ FEATURE_GROUP,
            [ NAME, "left bank" ],
            [ POSITION_XY, [2, 3] ],
            [ BOX_FEATURE,
                [ FTR_COMPARTMENT_SIZE_XYZ, [20, 20, 10] ],
            ],
            [ FEATURE_GROUP,
                [ NAME, "nested" ],
            ],
            [ FEATURE_COPY,
                [ NAME, "copy 1" ],
                [ FEATURE_REFERENCE, "nested" ],
                [ POSITION_XY, [5, 6] ],
            ],
        ],
    ]],
];
Make(data);`;
    const project = importScad(scad);
    expect(project.libraryProfile).toBe("bit");
    expect(project.lines.filter((l) => l.kind === "open" && l.role === "box_group")).toHaveLength(2);
    expect(project.lines.filter((l) => l.kind === "open" && l.role === "feature_copy")).toHaveLength(1);
    expect(project.lines.some((l) => l.kind === "close" && l.role === "box_group")).toBe(true);
    expect(project.lines.some((l) => l.kind === "close" && l.role === "feature_copy")).toBe(true);
    expect(project.lines.some((l) => l.kind === "open" && l.role === "feature_list")).toBe(true);
    expect(project.lines.find((l) => l.kind === "kv" && l.kvKey === "POSITION_XY")?.kvValue).toEqual([2, 3]);
    expect(project.lines.find((l) => l.kind === "kv" && l.kvKey === "PRINT_GROUP")?.kvValue).toBe("red");
    expect(project.lines.find((l) => l.kind === "kv" && l.kvKey === "FEATURE_REFERENCE")?.kvValue).toBe("nested");
    expect(project.lines.find((l) => l.kind === "kv" && l.kvKey === "FTR_COMPARTMENT_SIZE_XYZ")?.kvValue).toEqual([20, 20, 10]);
  });

  it("still parses legacy BIT 4.6.1 BOX_GROUP files", () => {
    const scad = `// BGSD
include <../lib/boardgame_insert_toolkit_lib.4.6.1.scad>;
data = [
    [ OBJECT_BOX, [
        [ BOX_GROUP,
            [ NAME, "legacy group" ],
        ],
    ]],
];
Make(data);`;
    const project = importScad(scad);
    expect(project.libraryProfile).toBe("bit");
    const group = project.lines.find((l) => l.kind === "open" && l.role === "box_group");
    expect(group?.label).toBe("BOX_GROUP");
    expect(project.lines.some((l) => l.kind === "close" && l.role === "box_group")).toBe(true);
  });

  it("does not keep removed BIT 4.2 divider keys structured", () => {
    const scad = `// BGSD
include <../lib/boardgame_insert_toolkit_lib.4.2.0.scad>;
data = [
    [ OBJECT_BOX, [
        [ BOX_FEATURE,
            [ FTR_COMPARTMENT_SIZE_XYZ, [40, 40, 15] ],
            [ FTR_DIVIDERS,
                [ DIV_NUM_DIVIDERS, 2 ],
                [ DIV_RAILS_B, true ],
            ],
        ],
    ]],
];
Make(data);`;
    const project = importScad(scad);
    expect(project.lines.find((l) => l.kind === "kv" && l.kvKey === "DIV_NUM_DIVIDERS")).toBeUndefined();
    expect(project.lines.find((l) => l.kind === "kv" && l.kvKey === "DIV_RAILS_B")).toBeUndefined();
    expect(project.lines.some((l) => l.kind === "raw" && l.raw.includes("DIV_NUM_DIVIDERS"))).toBe(true);
    expect(project.lines.some((l) => l.kind === "raw" && l.raw.includes("DIV_RAILS_B"))).toBe(true);
  });

  it("classifies Make() lines", () => {
    const project = importScad("// BGSD\ninclude <boardgame_insert_toolkit_lib.4.scad>;\ndata = [\n];\nMake(data);");
    const make = project.lines.find((l) => l.kind === "makeall");
    expect(make).toBeTruthy();
    expect(make.varName).toBe("data");
  });

  it("parses KV lines with correct key and value", () => {
    const scad = `// BGSD
include <boardgame_insert_toolkit_lib.4.scad>;
data = [
    [ OBJECT_BOX, [
        [ NAME, "hello" ],
        [ BOX_SIZE_XYZ, [10, 20, 30] ],
    ]],
];
Make(data);`;
    const project = importScad(scad);
    const nameKv = project.lines.find((l) => l.kind === "kv" && l.kvKey === "NAME");
    expect(nameKv).toBeTruthy();
    expect(nameKv.kvValue).toBe("hello");

    const sizeKv = project.lines.find((l) => l.kind === "kv" && l.kvKey === "BOX_SIZE_XYZ");
    expect(sizeKv).toBeTruthy();
    expect(sizeKv.kvValue).toEqual([10, 20, 30]);
  });

  it("tracks bracket depth correctly", () => {
    const scad = `// BGSD
include <boardgame_insert_toolkit_lib.4.scad>;
data = [
    [ OBJECT_BOX, [
        [ NAME, "test" ],
    ]],
];
Make(data);`;
    const project = importScad(scad);
    const opens = project.lines.filter((l) => l.kind === "open");
    const closes = project.lines.filter((l) => l.kind === "close");
    expect(opens.length).toBe(closes.length);

    // Data open should be depth 0
    const dataOpen = opens.find((l) => l.role === "data");
    expect(dataOpen).toBeTruthy();
    expect(dataOpen.depth).toBe(0);
  });

  it("parses boolean KV values", () => {
    const scad = `// BGSD
include <boardgame_insert_toolkit_lib.4.scad>;
data = [
    [ OBJECT_BOX, [
        [ ENABLED_B, true ],
        [ BOX_STACKABLE_B, false ],
    ]],
];
Make(data);`;
    const project = importScad(scad);
    const enabled = project.lines.find((l) => l.kvKey === "ENABLED_B");
    expect(enabled.kvValue).toBe(true);
    const stackable = project.lines.find((l) => l.kvKey === "BOX_STACKABLE_B");
    expect(stackable.kvValue).toBe(false);
  });

  it("parses inline globals (v4 format)", () => {
    const scad = `// BGSD
include <boardgame_insert_toolkit_lib.4.scad>;
data = [
    [ G_TOLERANCE, 0.15 ],
    [ OBJECT_BOX, [
        [ NAME, "test" ],
    ]],
];
Make(data);`;
    const project = importScad(scad);
    const global = project.lines.find((l) => l.kind === "global" && l.globalKey === "G_TOLERANCE");
    expect(global).toBeTruthy();
    expect(global.globalValue).toBe(0.15);
    expect(global.inlineGlobal).toBe(true);
  });

  it("parses KV lines with trailing comments", () => {
    const scad = `// BGSD
include <boardgame_insert_toolkit_lib.4.scad>;
data = [
    [ OBJECT_BOX, [
        [ NAME, "test" ], // player box
    ]],
];
Make(data);`;
    const project = importScad(scad);
    const nameKv = project.lines.find((l) => l.kvKey === "NAME");
    expect(nameKv).toBeTruthy();
    // The KV value should be parsed correctly regardless of trailing comment
    expect(nameKv.kvValue).toBe("test");
  });

  it("round-trips a BIT file preserving semantic content", () => {
    const scad = loadFixture("design5.scad");
    const project = importScad(scad);
    // The importer may split merged brackets (e.g. "[ OBJECT_BOX, [" → two lines)
    // so raw join won't be identical, but key structural elements must be present
    const output = project.lines.map((l) => l.raw).join("\n");
    expect(output).toContain("BGSD");
    expect(output).toContain("boardgame_insert_toolkit_lib");
    expect(output).toContain("OBJECT_BOX");
    expect(output).toContain("NAME");
    expect(output).toContain("BOX_SIZE_XYZ");
    expect(output).toContain("BOX_LID");
    expect(output).toContain("Make(scene_1)");
  });

  it("round-trips a CTD file preserving content", () => {
    const scad = loadFixture("design.scad");
    const project = importScad(scad);
    const output = project.lines.map((l) => l.raw).join("\n");
    expect(normalizeNewlines(output.trim())).toBe(normalizeNewlines(scad.trim()));
  });

  it("handles empty scene gracefully", () => {
    const scad = loadFixture("design4.scad");
    const project = importScad(scad);
    expect(project.lines.length).toBeGreaterThan(0);
    const opens = project.lines.filter((l) => l.kind === "open");
    const closes = project.lines.filter((l) => l.kind === "close");
    expect(opens.length).toBe(closes.length);
  });

  it("handles scene with inline empty array", () => {
    const scad = loadFixture("design3.scad");
    const project = importScad(scad);
    expect(project.lines.length).toBeGreaterThan(0);
    expect(project.libraryProfile).toBe("ctd");
  });
});
