import { describe, it, expect } from "vitest";
import { importScad } from "../importer.js";
import fs from "fs";
import path from "path";

const FIXTURES = path.join(__dirname);

function loadFixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), "utf-8");
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
    expect(output.trim()).toBe(scad.trim());
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
